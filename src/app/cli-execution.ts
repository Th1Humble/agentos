import { runCli } from '../cli/runner.js';
import type { CliAdapter, CliRunResult } from '../cli/types.js';
import { buildBotPrompt, type BotConfig } from '../core/bot-registry.js';
import type { Session } from '../core/session-manager.js';
import { WorkspaceRequestSchema, prepareWorkspace } from '../core/workspace.js';
import type { AppRuntime } from './runtime.js';

export async function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  stopToolNames: string[],
  onEvent: Parameters<typeof runCli>[0]['onEvent'],
  env?: Record<string, string>,
  context?: { runtime: AppRuntime; session: Session; config: BotConfig },
): Promise<CliRunResult> {
  if (context) {
    const previous = context.runtime.sessions.get(context.session.id)?.taskContext;
    const originalPrompt = prompt;
    if (!sessionId && previous) prompt = `此前任务信息（项目切换后需重新验证）：${previous}\n\n${prompt}`;
    await context.runtime.sessions.setTaskContext(context.session.id, originalPrompt);
  }
  for (let attempts = 0; attempts < 3; attempts++) {
    const current = context?.runtime.sessions.get(context.session.id);
    const result = await runCli({
      adapter,
      prompt: context ? buildBotPrompt(
        context.config, prompt, context.runtime.teamRegistry.contextFor(context.config.id),
        context.runtime.defaultProductDeliveryMode,
      ) : prompt,
      cwd: current?.workspaceDir ?? workspaceDir,
      sessionId, signal,
      stopToolNames, onEvent,
      env: { ...(current ? { AGENT_OS_CHAT_ID: current.chatId } : {}), ...env, ...(current ? { AGENT_OS_SESSION_ID: current.id, AGENT_OS_WORKSPACE: current.workspaceDir } : {}) },
    });
    const selection = result.toolCalls?.find(call => call.toolName === 'select_workspace');
    if (!selection) return result;
    if (!context || !current) throw new Error('此执行入口不允许切换工作目录');
    const request = WorkspaceRequestSchema.parse(selection.input);
    if (signal.aborted) throw new Error('任务已取消');
    context.runtime.sessions.assertWorkspaceChangeAllowed(current.id, true);
    const directory = await prepareWorkspace(request.path, current.workspaceDir, request.create);
    await context.runtime.sessions.setWorkspaceDir(current.id, directory, true);
    const updated = context.runtime.sessions.get(current.id)!;
    for (const peer of context.runtime.sessions.topicSessions(current.id)) context.runtime.contextWindows?.delete(peer.id);
    Object.assign(context.session, updated);
    delete context.session.cliSessionId;
    workspaceDir = directory;
    sessionId = undefined;
    prompt = [
      `OS 已将当前话题工作目录绑定到 ${directory}，请继续原任务，不要重复选择同一目录。`,
      request.handoff ? `前一轮交接：${request.handoff}` : '',
      prompt,
    ].join('\n\n');
  }
  throw new Error('目录切换次数过多，请使用 /cd 明确目录后重试');
}
