import { armApprovalTimeout, handleTaskResult, returnCollaborationResult, type TaskResultContext } from './app/task-result.js';
/**
 * Agent OS 入口。
 * 当前阶段：飞书消息驱动 Claude Code / Codex 完成任务。
 */
import { OS_ROOT, DATA_ROOT } from './core/paths.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  startBot,
  type Bot,
  type IncomingDocumentComment,
} from './im/lark.js';
import {
  answerContinuation,
  answerNeedsContinuation,
  buildClarificationSupersededCard,
  buildSessionNoticeCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from './im/card.js';
import { resolveMentions, extractResourceKeys } from './im/message-parser.js';
import { parseCliRequest, parseCommand } from './core/command-parser.js';
import { SessionManager } from './core/session-manager.js';
import { JsonSessionStore } from './core/session-store.js';
import { TaskProgressTracker } from './core/task-progress.js';
import type { ActiveRun } from './core/task-abort.js';
import {
  ClarificationFlowStore,
  formatClarificationMessage,
} from './core/clarification.js';
import { JsonProductSpecFlowStore } from './core/product-spec-store.js';
import { JsonApprovalFlowStore } from './core/approval-store.js';
import { JsonScheduleStore } from './core/schedule-store.js';
import { JsonScheduleRunStore } from './core/schedule-run-store.js';
import { topicTaskId } from './core/topic-task.js';
import {
  CollaborationInbox,
  buildCollaborationPrompt,
  collaborationOrigin,
  collaborationTurnKey,
  type CollaborationMessage,
} from './core/collaboration.js';
import {
  ensureWorkspaceDirectory,
} from './core/workspace.js';
import {
  loadAgentOsConfig,
  type BotConfig,
} from './core/bot-registry.js';
import { TeamRegistry } from './core/team-registry.js';
import { getCliAdapter, listCliAdapters } from './cli/registry.js';
import { compactCliSession } from './cli/native-compact.js';
import {
  createCardActionHandler,
} from './app/card-action-handler.js';
import { executeCli } from './app/cli-execution.js';
import { handleSessionCommand } from './app/command-handler.js';
import { sendResultNotification } from './app/notification-service.js';
import { markSessionIdle } from './app/session-view.js';
import { runProductDocumentComment } from './app/product-comment-runner.js';
import { CollaborationService } from './app/collaboration-service.js';
import { Scheduler } from './app/scheduler.js';
import { startScheduleApi } from './app/schedule-api.js';
import { startScheduleFileWatcher } from './app/schedule-watcher.js';
import type { AppRuntime, BotRuntime } from './app/runtime.js';

const botConfigPath = resolve(
  OS_ROOT, process.env.BOTS_CONFIG ?? join('config', 'bots.json'),
);
const agentOsConfig = await loadAgentOsConfig(botConfigPath);
const botConfigs = agentOsConfig.bots;
const teamRegistry = new TeamRegistry(agentOsConfig.teamLeaderId, botConfigs);

const missingSkills = await teamRegistry.findMissingSkills();
if (missingSkills.length) {
  throw new Error(missingSkills.map(missing => `角色 ${missing.botId} 缺少 Skill ${missing.skill}: ${missing.searchedPaths.join(', ')}`).join('\n'));
}
const sessions = await SessionManager.open({
  store: new JsonSessionStore(
    join(DATA_ROOT, 'sessions.json'),
    botConfigs[0]?.id,
  ),
});
const activeRuns = new Map<string, ActiveRun>();
const contextWindows = new Map<string, number>();
const botRuntimes = new Map<string, BotRuntime>();
const processedCollaborationTurns = new Set<string>();
const collaborationInbox = new CollaborationInbox();
const clarificationFlows = new ClarificationFlowStore();
const productSpecFlows = new JsonProductSpecFlowStore(
  join(DATA_ROOT, 'product-spec-flows.json'),
);
const approvalFlows = new JsonApprovalFlowStore(
  join(DATA_ROOT, 'approval-flows.json'),
);
approvalFlows.invalidateWorkspaceSessions(sessions.conflictedSessionIds());
productSpecFlows.invalidateWorkspaceSessions(sessions.conflictedSessionIds());
const processedDocumentCommentEvents = new Set<string>();
const documentCommentQueues = new Map<string, Promise<void>>();
const MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS = 1_000;
const runtime: AppRuntime = {
  defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
  sessions,
  teamRegistry,
  activeRuns,
  contextWindows,
  botRuntimes,
  processedCollaborationTurns,
  collaborationInbox,
  clarificationFlows,
  productSpecFlows,
  approvalFlows,
};
function persistBotIdentities(): void {
  const identities = Object.fromEntries(
    [...botRuntimes.entries()].map(([id, run]) => [
      id,
      { openId: run.identity.openId, name: run.identity.name },
    ]),
  );
  mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(
    join(DATA_ROOT, 'bot-identities.json'),
    `${JSON.stringify(identities, null, 2)}\n`,
    'utf8',
  );
}
sessions.workspaceChangeGuard = peers => {
  if (peers.some(s => approvalFlows.hasPendingSession(s.id) || productSpecFlows.hasPendingSession(s.id) || clarificationFlows.hasPendingSession(s.id))) {
    throw new Error('当前话题还有待处理的审批或澄清，请先处理完成，或新开话题选择其他目录');
  }
};
const collaborationService = new CollaborationService(runtime);
const scheduleFilePath = join(DATA_ROOT, 'schedules.json');
const scheduleStore = new JsonScheduleStore(scheduleFilePath);
const scheduleRunStore = new JsonScheduleRunStore(
  join(DATA_ROOT, 'schedule-runs.json'),
);
const scheduler = new Scheduler({
  runtime,
  scheduleStore,
  runStore: scheduleRunStore,
  defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
});

console.log('Agent OS 启动，正在建立飞书长连接…');
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，Team Leader=${teamRegistry.leaderBotId}，已恢复 ${sessions.size} 个会话`,
);
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
}
for (const config of botConfigs) {
  console.log(
    `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId}`,
  );
}

async function startConfiguredBot(
  config: BotConfig,
  collaborationService: CollaborationService,
): Promise<void> {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,
    onCardAction: createCardActionHandler({
      runtime,
      config,
      collaborationService,
      defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
    }),
    onDocumentComment: config.skills.includes('lark-drive')
      ? async (comment, bot) => scheduleDocumentComment(
          config,
          bot,
          comment,
        )
      : undefined,
    onMessage: async function handleMessage(msg, bot) {
      const resolved = resolveMentions(msg.text, msg.mentions);
      let taskId = topicTaskId(msg);
      let senderRuntime: BotRuntime | undefined;
      let collaboration: CollaborationMessage | undefined;
      if (msg.senderType === 'app' || msg.senderType === 'bot') {
        const currentRuntime = botRuntimes.get(config.id);
        const mentionedCurrentBot = currentRuntime
          ? msg.mentions.some(
              (mention) => mention.openId === currentRuntime.identity.openId,
            )
          : false;
        const dispatchId = msg.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
        const pending = msg.messageType === 'post'
          && mentionedCurrentBot
          && dispatchId
          ? collaborationInbox.consume(dispatchId, config.id)
          : undefined;
        if (!pending) {
          if (dispatchId) return; // 已消费或过期的协作通知不能退化为新的外部任务。
          if (mentionedCurrentBot) {
            console.log(
              `[协作] bot 消息 @ 当前 bot，按外部派活处理 sender=${msg.senderOpenId} target=${config.id}`,
            );
          } else {
            console.log(
              `[协作] 忽略非目标 bot 消息 sender=${msg.senderOpenId} target=${config.id}`,
            );
            return;
          }
        } else {
          senderRuntime = botRuntimes.get(pending.fromBotId);
          if (!senderRuntime) {
            console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`);
            return;
          }
          const turnKey = collaborationTurnKey(pending);
          if (processedCollaborationTurns.has(turnKey)) {
            console.log(`[协作] 忽略重复消息 ${turnKey}`);
            return;
          }
          processedCollaborationTurns.add(turnKey);
          collaboration = pending;
          taskId = pending.taskId;
        }
      }
      const botSender = msg.senderType === 'app' || msg.senderType === 'bot';
      const ownerOpenId = collaboration?.ownerOpenId
        ?? (botSender
          ? process.env.OWNER_OPEN_ID ?? msg.senderOpenId
          : msg.senderOpenId);
      const ownerUnionId = collaboration?.ownerUnionId
        ?? (botSender ? undefined : msg.senderUnionId);
      const hasThread = !!msg.threadId || !!msg.rootId;
      const command = parseCommand(resolved);
      const cliRequest = parseCliRequest(resolved);
      if (cliRequest && !cliRequest.prompt) {
        await bot.reply(
          msg.messageId,
          `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
          hasThread,
        );
        return;
      }
      const pendingClarification =
        msg.senderType !== 'app'
        && msg.senderType !== 'bot'
        && !command
          ? clarificationFlows.findForTask(taskId, config.id)
          : undefined;
      const resolvedSession = await sessions.resolve(
        msg,
        cliRequest?.cliId ?? config.defaultCliId,
        config.id,
        collaboration?.workspaceDir ?? '',
      );
      let { session } = resolvedSession;
      const { isNew } = resolvedSession;
      if (command && isNew && session.status === 'creating') {
        session = await sessions.transition(session.id, 'idle');
      }
      const cliAdapter = getCliAdapter(session.cliId);
      const isCompacting = command?.name === 'compact';
            // 图片/文件下载
      const resources = extractResourceKeys(msg.messageType, msg.rawContent);
      const downloadedFiles: string[] = [];
      for (const res of resources) {
        try {
          const savePath = await bot.downloadResource(
            msg.messageId,
            res.key,
            res.type,
            join(DATA_ROOT, "downloads"),
            res.fileName,
          );
          const absPath = resolve(savePath);
          downloadedFiles.push(absPath);
          console.log(`  [下载] ${res.type} → ${absPath}`);
        } catch (e) {
          console.error(`  [下载失败] ${res.key}:`, (e as Error).message);
        }
      }

      let taskText = pendingClarification
        ? formatClarificationMessage(
            pendingClarification,
            cliRequest?.prompt ?? resolved,
          )
        : collaboration
          ? buildCollaborationPrompt(collaboration)
          : cliRequest?.prompt ?? resolved;
      if (downloadedFiles.length > 0) {
        taskText += `\n\n【用户上传的附件/图片】\n` +
          downloadedFiles.map((p) => `- ${p}`).join("\n") +
          `\n请直接从上述本地路径读取并分析。`;
      }
      if (command?.name === 'schedule' && command.request) {
        taskText = [
          '用户想创建一个定时任务。',
          `需求：${command.request}`,
          '请使用 schedule_manage 工具，action=add 创建：targetBotId 选择团队中合适的成员，prompt 保留完整需求，rule 根据需求选择合适的调度规则。',
        ].join('\n\n');
      }
      const prompt = taskText;
      const taskCardTitle = isCompacting
        ? '整理上下文'
        : cliAdapter.displayName;
      console.log(
        `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
      );
      console.log(`  原文: ${msg.text}`);
      console.log(`  还原: ${resolved}`);
      console.log(
        `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`,
      );
      console.log(
        `  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status}`,
      );

      const commandOutcome = await handleSessionCommand({
        runtime,
        scheduler,
        config,
        msg,
        bot,
        session,
        cliAdapter,
        command,
        cliRequest,
        isNew,
        hasThread,
      });
      if (commandOutcome === 'handled') return;

      if (session.status === 'closed') {
        await bot.reply(
          msg.messageId,
          '这个话题的会话已经关闭，请新开一个话题继续。',
          hasThread,
        );
        return;
      }
      if ((session.status === 'active' || (!isNew && session.status === 'creating')) && collaboration) {
        collaborationInbox.register(collaboration);
        processedCollaborationTurns.delete(collaborationTurnKey(collaboration));
        const retry = setTimeout(() => {
          void handleMessage(msg, bot).catch(error => console.error('[协作] 排队重试失败:', (error as Error).message));
        }, 1000);
        retry.unref();
        return;
      }
      if (!isNew && session.status === 'creating') {
        await bot.reply(
          msg.messageId,
          '当前会话正在准备，请稍后再追问。',
          hasThread,
        );
        return;
      }
      if (session.status === 'active') {
        await bot.reply(
          msg.messageId,
          '当前会话还在执行，请等任务结束后再追问。',
          hasThread,
        );
        return;
      }

      if (pendingClarification) {
        clarificationFlows.delete(pendingClarification.token);
        if (pendingClarification.cardMessageId) {
          try {
            await bot.updateCard(
              pendingClarification.cardMessageId,
              buildClarificationSupersededCard(pendingClarification),
            );
          } catch (error) {
            console.warn(
              '[澄清] 旧卡片更新失败，继续处理用户的新消息:',
              (error as Error).message,
            );
          }
        }
      }

      if (
        collaboration && collaboration.workspaceDir &&
        session.workspaceDir !== collaboration.workspaceDir
      ) {
        if (session.workspaceDir) throw new Error('协作任务的目录与当前话题不一致，请重新派发');
        await ensureWorkspaceDirectory(collaboration.workspaceDir);
        session = await sessions.setWorkspaceDir(
          session.id,
          collaboration.workspaceDir,
        );
      }

      await sessions.transition(session.id, 'active');
      const run = new AbortController();
      const activeRun: ActiveRun = {
        controller: run,
        ownerOpenId,
      };
      activeRuns.set(session.id, activeRun);

      // 先回复一张卡片，让用户知道任务已经进入执行队列。
      let cardId: string | undefined;
      try {
        cardId = await bot.replyCard(
          msg.messageId,
          buildTaskCard({
            title: taskCardTitle,
            status: 'running',
            detail: isCompacting
              ? cliAdapter.id === 'codex' && command?.instructions
                ? 'Codex 正在使用原生默认策略整理上下文'
                : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
              : '正在理解任务',
            abortSessionId: session.id,
          }),
          hasThread,
        );
      } catch (error) {
        if (activeRuns.get(session.id)?.controller === run)
          activeRuns.delete(session.id);
        await markSessionIdle(sessions, session.id);
        throw error;
      }

      if (!cardId) {
        console.error('[卡片] 响应里没有 message_id，无法继续更新');
        if (activeRuns.get(session.id)?.controller === run)
          activeRuns.delete(session.id);
        await markSessionIdle(sessions, session.id);
        return;
      }
      console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

      const progress = new TaskProgressTracker(
        Date.now,
        contextWindows.get(session.id),
        !session.cliSessionId,
      );
      const cardUpdater = new ThrottledCardUpdater((card) =>
        bot.updateCard(cardId, card),
      );
      const renderProgress = () => {
        const snapshot = progress.snapshot();
        cardUpdater.push(
          buildTaskCard({
            title: taskCardTitle,
            status: 'running',
            detail: isCompacting
              ? `正在调用 ${cliAdapter.displayName} 原生上下文整理`
              : snapshot.current,
            ...(!isCompacting ? { progress: snapshot } : {}),
            abortSessionId: session.id,
          }),
        );
      };
      const progressHeartbeat = setInterval(renderProgress, 1_000);
      progressHeartbeat.unref();

      const cliEnv = {
        AGENT_OS_CHAT_ID: msg.chatId,
        AGENT_OS_OWNER_OPEN_ID: collaboration?.ownerOpenId ?? msg.senderOpenId,
      };

      // 让事件回调尽快返回，CLI 在后台继续执行。
      const execution = isCompacting
        ? compactCliSession({
            adapter: cliAdapter,
            sessionId: session.cliSessionId!,
            cwd: session.workspaceDir,
            instructions: command.instructions,
            signal: run.signal,
          }).then((result) => ({
            answer: result.message ?? '',
            sessionId: result.sessionId,
            stats: undefined,
            toolCalls: undefined,
          }))
        : executeCli(
            cliAdapter,
            prompt,
            session.workspaceDir,
            session.cliSessionId,
            run.signal,
            ['request_approval'],
            (event) => {
              if (
                event.type !== 'tool_start' &&
                event.type !== 'tool_end' &&
                event.type !== 'context'
              )
                return;
              progress.accept(event);
              renderProgress();
            },
            cliEnv,
            { runtime, session, config },
          );

      void execution
        .then(async (result) => {
          clearInterval(progressHeartbeat);
          if (run.signal.aborted) throw new Error('任务已取消');
          if (!isCompacting && result.sessionId) {
            await sessions.setCliSessionId(session.id, result.sessionId);
          }
          if (!isCompacting && result.stats?.contextWindowTokens) {
            contextWindows.set(session.id, result.stats.contextWindowTokens);
          }
          const finalResult = result;
          const resultContext: TaskResultContext = {
            runtime, config, bot, session, taskId, ownerOpenId, ownerUnionId,
            collaboration: collaboration ? collaborationOrigin(collaboration) : undefined,
            originalMessageId: msg.messageId, cardMessageId: cardId, replyInThread: hasThread,
            finishCard: card => cardUpdater.finish(card),
          };
          if (!isCompacting && await handleTaskResult(result, resultContext)) {
            if (result.toolCalls?.some(call => call.toolName === 'dispatch_task')) {
              await cardUpdater.finish(buildTaskCard({ title: taskCardTitle, status: 'success', detail: '已派发，等待团队成员返回', progress: progress.snapshot() }));
            }
            return;
          }
          if (!isCompacting) await returnCollaborationResult(result, resultContext);
          const snapshot = progress.snapshot();
          await cardUpdater.finish(isCompacting
            ? buildSessionNoticeCard({
              title: finalResult.answer ? '暂时无需整理' : '上下文已整理',
              template: finalResult.answer ? 'grey' : 'green',
              detail: finalResult.answer || [
                `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                'CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。',
              ].join('\n\n'),
            })
            : buildTaskCard({
              title: taskCardTitle,
              status: 'success',
              detail: '执行完成',
              progress: snapshot,
              answer: finalResult.answer,
              stats: finalResult.stats,
            }));
          if (!isCompacting && answerNeedsContinuation(finalResult.answer)) {
            for (const chunk of splitLongText(
              answerContinuation(finalResult.answer),
            )) {
              await bot.reply(msg.messageId, chunk, hasThread);
            }
          }
          console.log(
            `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? '(无)'}`,
          );
          if (!collaboration) {
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: ownerOpenId, name: '' },
              text: isCompacting
                ? '上下文整理已完成，请查看上方结果。'
                : '任务已完成，请查看上方结果。',
              replyInThread: hasThread,
            });
          }

        })
        .catch(async (error) => {
          clearInterval(progressHeartbeat);
          if (run.signal.aborted) {
            console.log('[CLI] 任务已取消');
            await cardUpdater.finish(
              buildTaskCard({
                title: taskCardTitle,
                status: 'cancelled',
                detail:
                  activeRun.cancelMode === 'close'
                    ? '本次任务已停止，当前会话已经关闭。'
                    : isCompacting
                      ? '整理已停止，当前 CLI 会话没有改变。'
                      : '本次任务已停止。你可以继续在当前话题里提问。',
                progress: progress.snapshot(),
              }),
            );
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: senderRuntime?.identity
                ?? { openId: ownerOpenId, name: '' },
              text: '任务已停止，请查看上方状态。',
              replyInThread: hasThread,
            });
            return;
          }
          const message = (error as Error).message;
          console.error('[CLI] 执行失败:', message);
          await cardUpdater.finish(
            buildTaskCard({
              title: taskCardTitle,
              status: 'failed',
              detail: isCompacting
                ? '上下文整理失败，当前 CLI 会话没有改变。'
                : '执行没有完成。你可以调整指令后，在当前话题里重试。',
              technicalDetail: message,
              progress: progress.snapshot(),
            }),
          );
          await sendResultNotification({
            bot,
            replyToMessageId: msg.messageId,
            target: senderRuntime?.identity
              ?? { openId: ownerOpenId, name: '' },
            text: '任务执行失败，请查看上方错误信息。',
            replyInThread: hasThread,
          });
        })
        .finally(async () => {
          clearInterval(progressHeartbeat);
          if (activeRuns.get(session.id)?.controller === run) {
            activeRuns.delete(session.id);
          }
          try {
            await markSessionIdle(sessions, session.id);
          } catch (error) {
            console.error('[会话] 保存空闲状态失败:', (error as Error).message);
          }
        })
        .catch((error) => {
          console.error('[任务] 回传或收尾失败:', (error as Error).message);
        });
    },
  });
  const identity = await startedBot.getIdentity();
  const botRuntime = { config, bot: startedBot, identity };
  botRuntimes.set(config.id, botRuntime);
  persistBotIdentities();
  if (config.skills.includes('lark-drive')) {
    try {
      await startedBot.subscribeToDocumentComments();
    } catch (error) {
      console.warn(
        `[Bot ${config.id}] 文档评论订阅失败，不影响消息链路:`,
        (error as Error).message,
      );
    }
  }
  console.log(
    `[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`,
  );
}

function scheduleDocumentComment(
  config: BotConfig,
  bot: Bot,
  comment: IncomingDocumentComment,
): void {
  if (!comment.mentionedBot) return;
  const flow = productSpecFlows.findPendingByDocument(
    config.id,
    comment.fileToken,
  );
  if (!flow) {
    console.log(
      `[产品评论] 忽略未关联待确认方案的评论 file=${comment.fileToken}`,
    );
    return;
  }

  const eventKey = comment.eventId || [
    comment.fileToken,
    comment.commentId,
    comment.replyId,
  ].join(':');
  if (processedDocumentCommentEvents.has(eventKey)) return;
  rememberDocumentCommentEvent(eventKey);

  const workingReaction = bot.setDocumentCommentWorking(comment, true)
    .then(() => true)
    .catch((error) => {
      console.warn(
        '[产品评论] 添加处理中表情失败，继续执行:',
        (error as Error).message,
      );
      return false;
    });
  const previous = documentCommentQueues.get(flow.sessionId)
    ?? Promise.resolve();
  const queued = Promise.all([
    previous.catch(() => undefined),
    workingReaction,
  ]).then(async ([, reactionAdded]) => {
    try {
      await runProductDocumentComment({
        runtime,
        bot,
        flow,
        comment,
      });
    } finally {
      if (reactionAdded) {
        await bot.setDocumentCommentWorking(comment, false).catch((error) => {
          console.warn(
            '[产品评论] 移除处理中表情失败:',
            (error as Error).message,
          );
        });
      }
    }
  });
  documentCommentQueues.set(flow.sessionId, queued);
  void queued
    .catch((error) => {
      console.error('[产品评论] 处理失败:', (error as Error).message);
      return bot.replyToDocumentComment(
        comment,
        `这条评论暂时没有处理完成：${(error as Error).message}`,
      ).catch((replyError) => {
        console.error(
          '[产品评论] 回写失败:',
          (replyError as Error).message,
        );
      });
    })
    .finally(() => {
      if (documentCommentQueues.get(flow.sessionId) === queued) {
        documentCommentQueues.delete(flow.sessionId);
      }
    });
}

function rememberDocumentCommentEvent(eventKey: string): void {
  processedDocumentCommentEvents.add(eventKey);
  if (
    processedDocumentCommentEvents.size
    <= MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS
  ) return;
  const oldest = processedDocumentCommentEvents.values().next().value;
  if (oldest) processedDocumentCommentEvents.delete(oldest);
}

await Promise.all(
  botConfigs.map((config) => startConfiguredBot(config, collaborationService)),
);

for (const flow of approvalFlows.pending()) {
  const member = botRuntimes.get(flow.botId);
  if (member) armApprovalTimeout(runtime, member.config, member.bot, flow);
}

await scheduler.start();
startScheduleFileWatcher({ scheduler, filePath: scheduleFilePath });
startScheduleApi({
  scheduler,
  sessions,
  runStore: scheduleRunStore,
  port: Number(process.env.SCHEDULE_API_PORT ?? 3101),
  token: process.env.SCHEDULE_API_TOKEN,
});
