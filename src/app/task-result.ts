import type { CliRunResult } from '../cli/types.js';
import type { Bot } from '../im/lark.js';
import type { CardJson } from '../im/card.js';
import { buildApprovalCard, buildClarificationCard, buildProductSpecApprovalCard } from '../im/card.js';
import type { BotConfig } from '../core/bot-registry.js';
import type { Session } from '../core/session-manager.js';
import { findClarificationRequest } from '../core/clarification.js';
import { findApprovalRequest, type ApprovalFlow } from '../core/approval.js';
import { findProductSpecRequest } from '../core/product-spec.js';
import { findDispatchTaskRequest, type CollaborationOrigin } from '../core/collaboration.js';
import type { AppRuntime } from './runtime.js';
import { assertProductSpecDocuments } from './product-spec-documents.js';
import { CollaborationService } from './collaboration-service.js';
import { sendResultNotification } from './notification-service.js';
import { scheduleApprovalContinuation } from './card-action-handler.js';

export interface TaskResultContext {
  runtime: AppRuntime;
  config: BotConfig;
  bot: Bot;
  session: Session;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  originalMessageId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  finishCard: (card: CardJson) => Promise<void>;
}

const INTERACTIVE_TOOLS = new Set([
  'request_clarification', 'request_approval', 'request_spec_approval', 'dispatch_task',
]);

/** Shared by initial turns and every continuation. True means waiting or delegated, not completed. */
export async function handleTaskResult(result: CliRunResult, context: TaskResultContext): Promise<boolean> {
  const { runtime, config, session, bot } = context;
  if (result.sessionId) await runtime.sessions.setCliSessionId(session.id, result.sessionId);
  if (result.stats?.contextWindowTokens) runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
  const calls = result.toolCalls?.filter(call => INTERACTIVE_TOOLS.has(call.toolName)) ?? [];
  if (calls.length === 0) return false;
  if (calls.length > 1) throw new Error('同一轮不能同时提交多个等待或派发请求');
  const common = {
    taskId: context.taskId, botId: config.id, sessionId: session.id,
    ownerOpenId: context.ownerOpenId, ownerUnionId: context.ownerUnionId,
    collaboration: context.collaboration,
  };
  const notify = (text: string) => sendResultNotification({
    bot, replyToMessageId: context.originalMessageId,
    target: { openId: context.ownerOpenId, name: '' }, text,
    replyInThread: context.replyInThread,
  });
  const clarification = findClarificationRequest(calls);
  if (clarification) {
    const flow = runtime.clarificationFlows.create({
      ...common, originalMessageId: context.originalMessageId,
      cardMessageId: context.cardMessageId, replyInThread: context.replyInThread,
      request: clarification,
    });
    await context.finishCard(buildClarificationCard({ flow }));
    await notify(`需要确认 ${clarification.questions.length} 个问题，请在卡片中回答。`);
    return true;
  }
  const approval = findApprovalRequest(calls);
  if (approval) {
    const flow = runtime.approvalFlows.create({
      ...common, originalMessageId: context.originalMessageId,
      cardMessageId: context.cardMessageId, replyInThread: context.replyInThread,
      request: approval,
    });
    armApprovalTimeout(runtime, config, bot, flow);
    await context.finishCard(buildApprovalCard(flow));
    await notify('有操作需要审批，请在卡片中确认。');
    return true;
  }
  const spec = findProductSpecRequest(calls);
  if (spec) {
    if (spec.deliveryMode === 'local') {
      await assertProductSpecDocuments(runtime.sessions.get(session.id)!.workspaceDir, spec);
    }
    const flow = runtime.productSpecFlows.create({ ...common, request: spec });
    await context.finishCard(buildProductSpecApprovalCard(flow));
    await notify('产品方案已生成，请查看确认卡。');
    return true;
  }
  const dispatch = findDispatchTaskRequest(calls);
  if (dispatch) {
    if (config.id !== runtime.teamRegistry.leaderBotId) throw new Error('只有 CEO 助理可以派发团队任务');
    if (dispatch.targetBotId === config.id) throw new Error('不能把任务派给自己');
    const origin = context.collaboration;
    if (origin && origin.round >= origin.maxRounds) throw new Error('协作已达到轮次上限');
    await new CollaborationService(runtime).dispatch({
      senderConfig: config, senderBot: bot, replyToMessageId: context.originalMessageId,
      targetBotId: dispatch.targetBotId, taskId: context.taskId,
      ownerOpenId: context.ownerOpenId, ownerUnionId: context.ownerUnionId,
      reportToBotId: origin?.reportToBotId ?? config.id,
      objective: dispatch.objective, instruction: dispatch.instruction,
      expectedOutput: dispatch.expectedOutput,
      round: origin ? origin.round + 1 : 1,
      maxRounds: origin?.maxRounds ?? config.collaborationMaxRounds,
      workspaceDir: runtime.sessions.get(session.id)!.workspaceDir,
    });
    await notify(`任务已交给 ${dispatch.targetBotId}，等待协作结果。`);
    return true;
  }
  throw new Error(`工具 ${calls[0].toolName} 的参数不合法，请重试`);
}

export async function returnCollaborationResult(result: CliRunResult, context: TaskResultContext): Promise<void> {
  const origin = context.collaboration;
  if (!origin || origin.reportToBotId === context.config.id || origin.round >= origin.maxRounds) return;
  await new CollaborationService(context.runtime).dispatch({
    senderConfig: context.config, senderBot: context.bot, replyToMessageId: context.originalMessageId,
    targetBotId: origin.reportToBotId, taskId: origin.taskId,
    ownerOpenId: context.ownerOpenId, ownerUnionId: context.ownerUnionId,
    reportToBotId: origin.reportToBotId,
    objective: '团队成员完成任务，继续推进原目标',
    instruction: `${context.config.role} 的执行结果：\n${result.answer}\n请继续组织后续工作；可以交付时向用户汇总结论。`,
    expectedOutput: '继续推进原任务或向用户交付结论',
    round: origin.round + 1, maxRounds: origin.maxRounds,
    workspaceDir: context.runtime.sessions.get(context.session.id)!.workspaceDir,
  });
}

/** Also called at startup for persisted approvals, so restart does not disable expiry. */
export function armApprovalTimeout(runtime: AppRuntime, config: BotConfig, bot: Bot, flow: ApprovalFlow): void {
  const timer = setTimeout(() => {
    const current = runtime.approvalFlows.get(flow.token);
    if (!current || current.status !== 'pending') return;
    const session = runtime.sessions.get(flow.sessionId);
    // A different turn may still be running. Keep the pending flow until it can safely resume.
    if (session?.status === 'active' || session?.status === 'creating') {
      const retry = setTimeout(() => armApprovalTimeout(runtime, config, bot, flow), 1000);
      retry.unref();
      return;
    }
    const expired = runtime.approvalFlows.expire(flow.token);
    if (!expired || !session || session.status === 'closed') return;
    void scheduleApprovalContinuation({ runtime, config, bot, flow: expired })
      .catch(error => console.error('[审批] 超时续接失败:', (error as Error).message));
  }, Math.max(0, Date.parse(flow.expiresAt) - Date.now()));
  timer.unref();
}
