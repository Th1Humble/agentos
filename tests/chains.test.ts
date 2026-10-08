import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'agentos-chains-')));
process.env.AGENT_OS_DATA_DIR = join(temp, 'data');
const { SessionManager } = await import('../src/core/session-manager.js');
const { TeamRegistry } = await import('../src/core/team-registry.js');
const { ClarificationFlowStore } = await import('../src/core/clarification.js');
const { ApprovalFlowStore } = await import('../src/core/approval.js');
const { ProductSpecFlowStore } = await import('../src/core/product-spec.js');
const { CollaborationInbox } = await import('../src/core/collaboration.js');
const { handleTaskResult, returnCollaborationResult } = await import('../src/app/task-result.js');
const { continueTask } = await import('../src/app/task-continuation.js');
const { getCliAdapter } = await import('../src/cli/registry.js');
const { createCardActionHandler } = await import('../src/app/card-action-handler.js');
const { CollaborationService } = await import('../src/app/collaboration-service.js');
const { requestTaskAbort } = await import('../src/core/task-abort.js');
const { runScheduledTaskDirectly } = await import('../src/app/scheduled-task-runner.js');
const { runCli } = await import('../src/cli/runner.js');
const { ScheduleStore } = await import('../src/core/schedule-store.js');
const { ScheduleRunStore } = await import('../src/core/schedule-run-store.js');
const { Scheduler } = await import('../src/app/scheduler.js');
const { startScheduleApi } = await import('../src/app/schedule-api.js');
const { OS_ROOT } = await import('../src/core/paths.js');
after(async () => { await rm(temp, { recursive: true, force: true }); });
const base = { appId: '', appSecret: '', defaultCliId: 'codex', role: '角色', skills: [], systemPrompt: '', workspaceDir: '', collaborationMaxRounds: 16 };
const approvalRequest = { operation: 'restart', detail: 'restart test', impact: 'test', rollback: 'undo' };
const questionRequest = { title: '目录', questions: [{ id: 'path', prompt: '使用哪个目录', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] };
const call = (toolName: string, input: unknown) => ({ answer: '', sessionId: 'native', toolCalls: [{ toolUseId: 'call-1', toolName, input }] });
async function fixture(id = 'leader') {
  const configs = ['leader', 'developer', 'product'].map(id => ({ ...base, id }));
  const sessions = new SessionManager();
  const { session } = await sessions.resolve({ messageId: 'message', chatId: 'chat', threadId: 'topic', rootId: '' }, 'codex', id, temp);
  await sessions.transition(session.id, 'active');
  const sent: any[] = [];
  const bot = {
    async replyCard(...args: any[]) { sent.push(['card', ...args]); return 'card-id'; },
    async updateCard(...args: any[]) { sent.push(['update', ...args]); },
    async replyMention(...args: any[]) { sent.push(['mention', ...args]); return 'mention-id'; },
    async reply(...args: any[]) { sent.push(['reply', ...args]); return 'reply-id'; },
  } as any;
  const runtime = {
    sessions, teamRegistry: new TeamRegistry('leader', configs as any),
    activeRuns: new Map(), contextWindows: new Map(), botRuntimes: new Map(),
    processedCollaborationTurns: new Set(), collaborationInbox: new CollaborationInbox(),
    clarificationFlows: new ClarificationFlowStore(), approvalFlows: new ApprovalFlowStore(), productSpecFlows: new ProductSpecFlowStore(),
  } as any;
  for (const config of configs) runtime.botRuntimes.set(config.id, { config, bot, identity: { openId: config.id, name: config.id } });
  const config = configs.find(c => c.id === id)! as any;
  const context = { runtime, config, bot, session, taskId: 'task', ownerOpenId: 'owner', originalMessageId: 'message', cardMessageId: 'card-id', replyInThread: true, async finishCard(card: any) { sent.push(['finish', card]); } };
  return { ...context, context, sent };
}
function fakeEngine(events: unknown[]) {
  const adapter = getCliAdapter('codex') as any;
  const original = { command: adapter.command, buildArgs: adapter.buildArgs, buildResumeArgs: adapter.buildResumeArgs, parseEvents: adapter.parseEvents };
  adapter.command = process.execPath;
  adapter.buildArgs = () => ['-e', `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));`];
  adapter.buildResumeArgs = adapter.buildArgs;
  adapter.parseEvents = (line: string) => [JSON.parse(line)];
  return () => Object.assign(adapter, original);
}

test('result router handles clarification, approval, and valid local product documents', async () => {
  const f = await fixture('product');
  assert.equal(await handleTaskResult(call('request_clarification', questionRequest), f.context), true);
  assert.ok(f.runtime.clarificationFlows.findForTask('task', 'product'));
  assert.equal(await handleTaskResult(call('request_approval', approvalRequest), f.context), true);
  assert.equal(f.runtime.approvalFlows.hasPendingSession(f.session.id), true);
  const spec = join(temp, 'spec-project');
  await mkdir(join(spec, 'issues'), { recursive: true });
  await writeFile(join(spec, 'spec.md'), '# Spec');
  await writeFile(join(spec, 'issues', '1.md'), '# Ticket');
  // Keep this verification independent of the fixture's waiting flows.
  const product = await fixture('product');
  await product.runtime.sessions.transition(product.session.id, 'idle');
  await product.runtime.sessions.setWorkspaceDir(product.session.id, spec);
  assert.equal(await handleTaskResult(call('request_spec_approval', { deliveryMode: 'local', title: 'Feature', summary: 'Done', specPath: 'spec.md', ticketsPath: 'issues' }), product.context), true);
  assert.equal(product.runtime.productSpecFlows.hasPendingSession(product.session.id), true);
  assert.equal(await handleTaskResult({ answer: '先讨论需求' }, product.context), false);
});

test('dispatch and collaboration return preserve directory, owner and round', async () => {
  const f = await fixture();
  await handleTaskResult(call('dispatch_task', { targetBotId: 'developer', objective: '实现', instruction: '实现要求' }), f.context);
  const notification = f.sent.find(row => row[0] === 'mention' && String(row[3]).includes('任务编号'));
  const dispatchId = notification[3].match(/任务编号：([a-f0-9]{12})/)[1];
  const pending = f.runtime.collaborationInbox.consume(dispatchId, 'developer');
  assert.equal(pending.workspaceDir, temp);
  assert.equal(pending.ownerOpenId, 'owner');
  assert.equal(pending.round, 1);
  const dev = await fixture('developer');
  await returnCollaborationResult({ answer: '实现完成' }, { ...dev.context, collaboration: { taskId: 'task', fromBotId: 'leader', reportToBotId: 'leader', round: 1, maxRounds: 16 } });
  assert.ok(dev.sent.some(row => row[0] === 'mention' && row[2].openId === 'leader'));
  await assert.rejects(handleTaskResult(call('dispatch_task', { targetBotId: 'product', objective: 'x', instruction: 'x' }), dev.context), /CEO/);
});

test('approval continuation can ask clarification; clarification continuation can dispatch', async () => {
  for (const [name, input] of [['request_clarification', questionRequest], ['dispatch_task', { targetBotId: 'developer', objective: '实现', instruction: '继续执行' }]] as const) {
    const f = await fixture();
    const restore = fakeEngine([{ type: 'session', sessionId: 'native' }, { type: 'tool_call', toolUseId: 'tool', toolName: name, input }]);
    try {
      const run = new AbortController();
      f.runtime.activeRuns.set(f.session.id, { controller: run, ownerOpenId: 'owner' });
      await continueTask({ runtime: f.runtime, bot: f.bot, config: f.config, run, prompt: '用户已回复，请继续', flow: { ...f.context, sessionId: f.session.id } as any });
      assert.equal(f.runtime.sessions.get(f.session.id).status, 'idle');
      assert.equal(f.runtime.activeRuns.size, 0);
      if (name === 'request_clarification') assert.ok(f.runtime.clarificationFlows.findForTask('task', 'leader'));
      else assert.ok(f.sent.some(row => row[0] === 'mention' && String(row[3]).includes('任务编号')));
    } finally { restore(); }
  }
});

test('failed progress card cleans up the active run and releases the session', async () => {
  const f = await fixture();
  const run = new AbortController();
  f.runtime.activeRuns.set(f.session.id, { controller: run, ownerOpenId: 'owner' });
  f.bot.replyCard = async () => { throw new Error('card offline'); };
  await assert.rejects(continueTask({ runtime: f.runtime, bot: f.bot, config: f.config, run, prompt: 'continue', flow: { ...f.context, sessionId: f.session.id } as any }), /card offline/);
  assert.equal(f.runtime.sessions.get(f.session.id).status, 'idle');
  assert.equal(f.runtime.activeRuns.size, 0);
});

test('approval and abort reject other users; busy approval does not consume the decision', async () => {
  const f = await fixture();
  const flow = f.runtime.approvalFlows.create({ ...f.context, botId: f.config.id, sessionId: f.session.id, request: approvalRequest });
  const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, collaborationService: new CollaborationService(f.runtime), defaultProductDeliveryMode: 'local' });
  const action = { operatorOpenId: 'other', operatorUnionId: '', messageId: 'card', value: { action: 'decide_approval', flowToken: flow.token, decision: 'approve' }, formValue: {} };
  assert.match((await handler(action))!.toast!.content, /发起人/);
  assert.equal(flow.status, 'pending');
  assert.match((await handler({ ...action, operatorOpenId: 'owner' }))!.toast!.content, /仍在执行/);
  assert.equal(flow.status, 'pending');
  const controller = new AbortController();
  f.runtime.activeRuns.set(f.session.id, { controller, ownerOpenId: 'owner' });
  assert.equal(requestTaskAbort(f.runtime.activeRuns, f.session.id, 'other'), 'forbidden');
  assert.equal(controller.signal.aborted, false);
  assert.equal(requestTaskAbort(f.runtime.activeRuns, f.session.id, 'owner'), 'stopped');
});

test('busy clarification does not consume its last answer', async () => {
  const f = await fixture();
  const flow = f.runtime.clarificationFlows.create({ ...f.context, botId: f.config.id, sessionId: f.session.id, request: questionRequest });
  const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, collaborationService: new CollaborationService(f.runtime), defaultProductDeliveryMode: 'local' });
  const response = await handler({ operatorOpenId: 'owner', operatorUnionId: '', messageId: 'card', value: { action: 'answer_clarification', flowToken: flow.token, questionId: 'path', optionId: 'a' }, formValue: {} });
  assert.match(response!.toast!.content, /仍在执行/);
  assert.equal(flow.currentIndex, 0);
});

test('scheduled execution cannot silently succeed after requesting approval', async () => {
  const f = await fixture();
  const restore = fakeEngine([{ type: 'tool_call', toolUseId: 'approval', toolName: 'request_approval', input: approvalRequest }]);
  try {
    await assert.rejects(runScheduledTaskDirectly({ runtime: f.runtime, task: { id: 'schedule', targetBotId: 'developer', chatId: 'chat', creatorOpenId: 'owner', workspaceDir: temp, prompt: 'execute' } as any, scheduledFor: new Date().toISOString(), defaultProductDeliveryMode: 'local' }), /交互/);
    assert.equal(f.runtime.activeRuns.size, 0);
  } finally { restore(); }
});

test('every interactive tool stops execution even without caller stopToolNames', async () => {
  for (const toolName of ['request_clarification', 'request_approval', 'request_spec_approval', 'dispatch_task']) {
    const adapter = {
      command: process.execPath, id: 'codex', displayName: 'test',
      buildArgs: () => ['-e', `console.log(JSON.stringify({type:'tool_call',toolUseId:'1',toolName:${JSON.stringify(toolName)},input:{}})); setTimeout(()=>console.log(JSON.stringify({type:'result',answer:'should not continue'})),5000);`],
      parseEvents: (line: string) => [JSON.parse(line)],
    } as any;
    const result = await runCli({ adapter, prompt: 'x', cwd: temp, timeoutMs: 2000 });
    assert.equal(result.toolCalls?.[0].toolName, toolName);
    assert.equal(result.answer, '');
  }
});

test('real MCP to local API creates schedules with authoritative session directory', async () => {
  const f = await fixture();
  const store = new ScheduleStore();
  const runStore = new ScheduleRunStore();
  const scheduler = new Scheduler({ runtime: f.runtime, scheduleStore: store, runStore, defaultProductDeliveryMode: 'local' });
  const server = startScheduleApi({ scheduler, sessions: f.runtime.sessions, runStore, port: 0, token: 'test-token' });
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'regression', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', join(OS_ROOT, 'src/mcp/app-tools-server.ts')], cwd: OS_ROOT,
      env: { ...process.env, SCHEDULE_API_PORT: String(port), SCHEDULE_API_TOKEN: 'test-token', AGENT_OS_SESSION_ID: f.session.id, AGENT_OS_CHAT_ID: 'chat', AGENT_OS_OWNER_OPEN_ID: 'owner' } as Record<string, string>, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'schedule_manage', arguments: { action: 'add', targetBotId: 'developer', prompt: '检查项目', rule: { kind: 'interval', everyMs: 60000 } } });
    assert.notEqual(result.isError, true);
    assert.equal(store.list()[0].workspaceDir, temp);
    await f.runtime.sessions.transition(f.session.id, 'idle');
    const next = join(temp, 'another'); await mkdir(next);
    await f.runtime.sessions.setWorkspaceDir(f.session.id, next);
    assert.equal(store.list()[0].workspaceDir, temp);
    const wrongChat = await fetch(`http://127.0.0.1:${port}/api/schedules/manage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-token': 'test-token' }, body: JSON.stringify({ request: { action: 'list' }, sessionId: f.session.id, chatId: 'wrong', creatorOpenId: 'owner' }) });
    assert.equal(wrongChat.status, 400);
  } finally {
    await client.close(); scheduler.stop(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('invalid structured tool request fails instead of reporting success', async () => {
  const f = await fixture();
  await assert.rejects(handleTaskResult(call('request_approval', {}), f.context), /参数不合法/);
  await assert.rejects(handleTaskResult({ answer: '', toolCalls: [...call('request_approval', approvalRequest).toolCalls, ...call('request_clarification', questionRequest).toolCalls] }, f.context), /多个/);
});

test('approval continuation may request another approval without executing through it', async () => {
  const f = await fixture('developer');
  const restore = fakeEngine([{ type: 'session', sessionId: 'native' }, { type: 'tool_call', toolUseId: 'approval-again', toolName: 'request_approval', input: approvalRequest }]);
  try {
    const run = new AbortController();
    await continueTask({ runtime: f.runtime, bot: f.bot, config: f.config, run, prompt: '继续已批准的步骤', flow: { ...f.context, sessionId: f.session.id } as any });
    assert.equal(f.runtime.approvalFlows.hasPendingSession(f.session.id), true);
    assert.equal(f.runtime.sessions.get(f.session.id).status, 'idle');
  } finally { restore(); }
});

test('restored approval deadline expires without requiring a card click', async () => {
  const { armApprovalTimeout } = await import('../src/app/task-result.js');
  const f = await fixture();
  const flow = f.runtime.approvalFlows.create({ ...f.context, botId: f.config.id, sessionId: f.session.id, request: approvalRequest });
  flow.expiresAt = new Date(Date.now() - 1).toISOString();
  // A closed session must not launch any CLI but its stale approval still expires.
  await f.runtime.sessions.transition(f.session.id, 'closed');
  assert.equal(f.runtime.approvalFlows.pending().length, 1);
  armApprovalTimeout(f.runtime, f.config, f.bot, flow);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(flow.status, 'expired');
  assert.equal(f.runtime.approvalFlows.pending().length, 0);
});
