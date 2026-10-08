import type { Bot } from '../im/lark.js';
import type { BotConfig } from '../core/bot-registry.js';
import type { ApprovalFlow } from '../core/approval.js';
import type { ClarificationFlow } from '../core/clarification.js';
import { answerContinuation, answerNeedsContinuation, buildTaskCard, splitLongText, ThrottledCardUpdater } from '../im/card.js';
import { getCliAdapter } from '../cli/registry.js';
import { TaskProgressTracker } from '../core/task-progress.js';
import type { AppRuntime } from './runtime.js';
import { executeCli } from './cli-execution.js';
import { markSessionIdle } from './session-view.js';
import { handleTaskResult, returnCollaborationResult, type TaskResultContext } from './task-result.js';
import { sendResultNotification } from './notification-service.js';

export async function continueTask(options: {
  runtime: AppRuntime; bot: Bot; config: BotConfig;
  flow: ApprovalFlow | ClarificationFlow; run: AbortController; prompt: string;
}): Promise<void> {
  const { runtime, bot, config, flow, run } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session) throw new Error('续接对应的会话已经失效');
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updater: ThrottledCardUpdater | undefined;
  const adapter = getCliAdapter(session.cliId);
  const progress = new TaskProgressTracker(Date.now, runtime.contextWindows.get(session.id), false);
  try {
    const cardId = await bot.replyCard(flow.originalMessageId, buildTaskCard({
      title: adapter.displayName, status: 'running', detail: '正在根据你的回复继续任务',
      abortSessionId: session.id, progress: progress.snapshot(),
    }), flow.replyInThread);
    if (!cardId) throw new Error('飞书没有返回进度卡片 message_id');
    updater = new ThrottledCardUpdater(card => bot.updateCard(cardId, card));
    const render = () => updater!.push(buildTaskCard({
      title: adapter.displayName, status: 'running', detail: progress.snapshot().current || '正在继续执行',
      abortSessionId: session.id, progress: progress.snapshot(),
    }));
    heartbeat = setInterval(render, 1000);
    heartbeat.unref();
    const result = await executeCli(adapter, options.prompt, session.workspaceDir, session.cliSessionId,
      run.signal, [], event => {
        if (event.type === 'tool_start' || event.type === 'tool_end' || event.type === 'context') {
          progress.accept(event); render();
        }
      }, { AGENT_OS_OWNER_OPEN_ID: flow.ownerOpenId }, { runtime, session, config });
    clearInterval(heartbeat);
    if (run.signal.aborted) throw new Error('任务已取消');
    const context: TaskResultContext = {
      runtime, bot, config, session, taskId: flow.taskId,
      ownerOpenId: flow.ownerOpenId, ownerUnionId: flow.ownerUnionId,
      collaboration: flow.collaboration, originalMessageId: flow.originalMessageId,
      cardMessageId: cardId, replyInThread: flow.replyInThread,
      finishCard: card => updater!.finish(card),
    };
    if (await handleTaskResult(result, context)) {
      // Delegation has its own card. Don't leave the execution card spinning.
      if (result.toolCalls?.some(call => call.toolName === 'dispatch_task')) {
        await updater.finish(buildTaskCard({ title: adapter.displayName, status: 'success', detail: '已派发，等待团队成员返回', progress: progress.snapshot() }));
      }
      return;
    }
    await returnCollaborationResult(result, context);
    await updater.finish(buildTaskCard({
      title: adapter.displayName, status: 'success', detail: '本轮执行完成',
      progress: progress.snapshot(), answer: result.answer, stats: result.stats,
    }));
    if (answerNeedsContinuation(result.answer)) {
      for (const chunk of splitLongText(answerContinuation(result.answer))) await bot.reply(flow.originalMessageId, chunk, flow.replyInThread);
    }
    await sendResultNotification({ bot, replyToMessageId: flow.originalMessageId,
      target: { openId: flow.ownerOpenId, name: '' }, text: '本轮处理完成，请查看结果。', replyInThread: flow.replyInThread });
  } catch (error) {
    if (!updater) throw error;
    await updater.finish(buildTaskCard({
      title: adapter.displayName, status: run.signal.aborted ? 'cancelled' : 'failed',
      detail: run.signal.aborted ? '任务已停止' : '任务续接失败，请在话题中重试',
      technicalDetail: (error as Error).message, progress: progress.snapshot(),
    }));
  } finally {
    clearInterval(heartbeat);
    if (runtime.activeRuns.get(session.id)?.controller === run) runtime.activeRuns.delete(session.id);
    await markSessionIdle(runtime.sessions, session.id);
  }
}
