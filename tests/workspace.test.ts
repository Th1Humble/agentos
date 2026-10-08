import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'agentos-workspace-test-')));
process.env.AGENT_OS_DATA_DIR = join(temp, 'data');
const { SessionManager } = await import('../src/core/session-manager.js');
const { JsonSessionStore } = await import('../src/core/session-store.js');
const { prepareWorkspace, resolveWorkspacePath } = await import('../src/core/workspace.js');
const { OS_ROOT, SKILLS_ROOT } = await import('../src/core/paths.js');
const { parseAgentOsConfig, buildBotPrompt } = await import('../src/core/bot-registry.js');
const { TeamRegistry } = await import('../src/core/team-registry.js');
const { executeCli } = await import('../src/app/cli-execution.js');
const { ScheduleStore } = await import('../src/core/schedule-store.js');
const { ScheduleRunStore } = await import('../src/core/schedule-run-store.js');
const { Scheduler } = await import('../src/app/scheduler.js');
const { executeScheduleManageRequest } = await import('../src/app/schedule-manage-service.js');
const { CodexAdapter } = await import('../src/cli/codex-adapter.js');
const { ClaudeAdapter } = await import('../src/cli/claude-adapter.js');
after(async () => { await rm(temp, { recursive: true, force: true }); });

const address = { messageId: 'message', chatId: 'chat', threadId: 'topic', rootId: '' };
const config = { id: 'product', appId: '', appSecret: '', defaultCliId: 'codex' as const, role: '产品', skills: ['grill-me'], systemPrompt: '', workspaceDir: '', collaborationMaxRounds: 16 };
async function idle(sessions: InstanceType<typeof SessionManager>, bot = 'product', workspace = '', msg = address) {
  const { session } = await sessions.resolve(msg, 'codex', bot, workspace);
  return sessions.transition(session.id, 'idle');
}

test('new topics remain unbound; roles share directory; switching resets all native sessions and survives restart', async () => {
  const file = join(temp, 'sessions.json');
  const store = new JsonSessionStore(file);
  const sessions = await SessionManager.open({ store });
  const a = await idle(sessions);
  assert.equal(a.workspaceDir, '');
  const project = await prepareWorkspace(join(temp, 'project'), undefined, true);
  await sessions.setWorkspaceDir(a.id, project);
  const b = await idle(sessions, 'developer');
  assert.equal(b.workspaceDir, project);
  await sessions.setCliSessionId(a.id, 'native-a');
  await sessions.setCliSessionId(b.id, 'native-b');
  await sessions.setWorkspaceDir(a.id, temp);
  for (const s of sessions.topicSessions(a.id)) {
    assert.equal(s.workspaceDir, temp);
    assert.equal(s.cliSessionId, undefined);
  }
  const restored = await SessionManager.open({ store });
  assert.equal(restored.get(b.id)?.workspaceDir, temp);
  assert.equal((await idle(restored, 'product', '', { ...address, threadId: 'other' })).workspaceDir, '');
});

test('switch refuses active peers and pending flows, permits stopped selector only', async () => {
  const sessions = new SessionManager();
  const a = await idle(sessions);
  const b = await idle(sessions, 'developer');
  await sessions.transition(b.id, 'active');
  await assert.rejects(sessions.setWorkspaceDir(a.id, temp, true), /正在执行/);
  await sessions.transition(b.id, 'idle');
  sessions.workspaceChangeGuard = () => { throw new Error('待处理审批'); };
  await assert.rejects(sessions.setWorkspaceDir(a.id, temp), /待处理审批/);
  assert.equal(sessions.get(a.id)?.workspaceDir, '');
});

test('legacy conflicts and missing workspace never fall back to OS cwd', async () => {
  const sessions = new SessionManager();
  const a = await idle(sessions, 'a', temp);
  const b = { ...a, id: 'b', botId: 'b', workspaceDir: join(temp, 'different'), cliSessionId: 'old' };
  const file = join(temp, 'legacy.json');
  await writeFile(file, JSON.stringify([a, b]));
  const migrated = await SessionManager.open({ store: new JsonSessionStore(file) });
  assert.equal(migrated.get('b')?.workspaceDir, '');
  assert.equal(migrated.get('b')?.cliSessionId, undefined);
  const missing = { ...a } as any;
  delete missing.workspaceDir;
  await writeFile(file, JSON.stringify([missing]));
  assert.equal((await new JsonSessionStore(file, 'a').load())[0].workspaceDir, '');
});

test('path validation supports tilde, rejects ambiguous relative path and missing directory', async () => {
  assert.equal(resolveWorkspacePath('~/demo'), join(homedir(), 'demo'));
  assert.throws(() => resolveWorkspacePath('../demo'), /绝对路径/);
  await assert.rejects(prepareWorkspace(join(temp, 'missing')), /不存在/);
  assert.equal(await prepareWorkspace('project', temp), join(temp, 'project'));
});

test('bot workspace config is ignored and role skill path is anchored to OS', async () => {
  const parsed = parseAgentOsConfig({ teamLeader: 'a', bots: [{ id: 'a', appIdEnv: 'ID', appSecretEnv: 'SECRET', defaultCli: 'codex', role: 'a', workspace: '/old/project' }] }, { ID: 'id', SECRET: 'secret', CLI_WORKDIR: '/also/old' });
  assert.equal('workspaceDir' in parsed.bots[0], false);
  assert.ok(buildBotPrompt(config, '讨论').includes(join(SKILLS_ROOT, 'grill-me', 'SKILL.md')));
  assert.deepEqual(await new TeamRegistry(config.id, [config]).findMissingSkills(), []);
});

test('both engine adapters recognize workspace selection', () => {
  const codex = new CodexAdapter().parseEvents(JSON.stringify({ type: 'item.started', item: { id: '1', type: 'mcp_tool_call', server: 'agent_os', tool: 'select_workspace', arguments: { path: temp } } }));
  const claude = new ClaudeAdapter().parseEvents(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'mcp__agent_os__select_workspace', input: { path: temp } }] } }));
  assert.ok(codex.some(e => e.type === 'tool_call' && e.toolName === 'select_workspace'));
  assert.ok(claude.some(e => e.type === 'tool_call' && e.toolName === 'select_workspace'));
});

test('selection stops child then resumes automatically in bound directory with fresh native session', async () => {
  const sessions = new SessionManager();
  const session = await idle(sessions);
  await sessions.transition(session.id, 'active');
  const project = join(temp, 'project');
  let calls = 0;
  const prompts: string[] = [];
  const adapter = {
    id: 'codex', command: process.execPath, displayName: 'test',
    buildArgs(prompt: string) {
      prompts.push(prompt);
      calls++;
      return calls === 1
        ? ['-e', `console.log(JSON.stringify({type:'tool_call',toolUseId:'1',toolName:'select_workspace',input:{path:${JSON.stringify(project)},handoff:'继续检查项目'}}));setInterval(()=>{},1000)`]
        : ['-e', "console.log(JSON.stringify({type:'result',answer:process.cwd(),sessionId:'new-native'}))"];
    },
    buildResumeArgs() { throw new Error('must start fresh'); },
    parseEvents(line: string) { return [JSON.parse(line)]; },
  } as any;
  const runtime = { sessions, teamRegistry: new TeamRegistry(config.id, [config]) } as any;
  const result = await executeCli(adapter, '检查项目', '', undefined, new AbortController().signal, [], undefined, undefined, { runtime, session, config });
  assert.equal(result.answer, project);
  assert.equal(sessions.get(session.id)?.workspaceDir, project);
  assert.equal(session.workspaceDir, project);
  assert.ok(prompts[0].includes('尚未绑定'));
  assert.ok(prompts[1].includes('继续检查项目'));
  assert.equal(calls, 2);
});

test('scheduled jobs snapshot workspace; legacy jobs pause and cannot resume without migration', async () => {
  const store = new ScheduleStore();
  const runStore = new ScheduleRunStore();
  const scheduler = new Scheduler({ runtime: {} as any, scheduleStore: store, runStore, defaultProductDeliveryMode: 'local' });
  const rule = { kind: 'interval' as const, everyMs: 60000 };
  const legacy = store.create({ creatorOpenId: 'owner', chatId: 'chat', targetBotId: 'product', prompt: 'check', rule });
  await scheduler.start();
  assert.equal(scheduler.get(legacy.id)?.status, 'paused');
  assert.throws(() => scheduler.resume(legacy.id), /workspaceDir/);
  await executeScheduleManageRequest({ action: 'add', targetBotId: 'product', prompt: 'check', rule }, { scheduler, runStore, chatId: 'chat', creatorOpenId: 'owner', workspaceDir: temp });
  assert.equal(scheduler.list().find(t => t.id !== legacy.id)?.workspaceDir, temp);
  scheduler.stop();
});

test('failed persistence rolls back every role directory and native session', async () => {
  let fail = false;
  const sessions = await SessionManager.open({ store: { async load() { return []; }, async save() { if (fail) throw new Error('disk failure'); } } });
  const a = await idle(sessions);
  const b = await idle(sessions, 'developer');
  await sessions.setCliSessionId(a.id, 'native');
  fail = true;
  await assert.rejects(sessions.setWorkspaceDir(a.id, temp), /disk failure/);
  assert.equal(sessions.get(a.id)?.workspaceDir, '');
  assert.equal(sessions.get(a.id)?.cliSessionId, 'native');
  assert.equal(sessions.get(b.id)?.workspaceDir, '');
});

test('conflicting workspace migration invalidates pending approvals durably', async () => {
  const { JsonProductSpecFlowStore } = await import('../src/core/product-spec-store.js');
  const file = join(temp, 'product-flows.json');
  const store = new JsonProductSpecFlowStore(file);
  const flow = store.create({ taskId: 'task', botId: 'product', sessionId: 'conflict', ownerOpenId: 'owner', request: { deliveryMode: 'local', title: 'Title', summary: 'Summary', specPath: 'spec.md', ticketsPath: 'issues' } });
  store.invalidateWorkspaceSessions(new Set(['conflict']));
  assert.equal(new JsonProductSpecFlowStore(file).get(flow.token)?.status, 'expired');
});

test('compiled OS paths remain anchored when launched from another directory', async () => {
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const url = pathToFileURL(join(OS_ROOT, 'dist/core/paths.js')).href;
  const value = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const p = await import(${JSON.stringify(url)}); console.log(JSON.stringify([p.OS_ROOT,p.SKILLS_ROOT]));`], { cwd: temp, encoding: 'utf8' }));
  assert.deepEqual(value, [OS_ROOT, SKILLS_ROOT]);
});

test('Feishu skills are delegated to installed packages without OS paths or installation checks', async () => {
  const mixed = { ...config, skills: ['grill-me', 'lark-doc', 'lark-drive'] };
  const prompt = buildBotPrompt(mixed, '整理需求');
  assert.ok(prompt.includes(join(SKILLS_ROOT, 'grill-me', 'SKILL.md')));
  assert.ok(!prompt.includes(join(SKILLS_ROOT, 'lark-doc')));
  assert.ok(!prompt.includes(join(SKILLS_ROOT, 'lark-drive')));
  assert.ok(prompt.includes('已安装的飞书 Skill 包'));
  assert.deepEqual(await new TeamRegistry(mixed.id, [mixed]).findMissingSkills(), []);
  const missingLocal = { ...config, skills: ['nonexistent-local-skill', 'lark-doc'] };
  assert.deepEqual((await new TeamRegistry(missingLocal.id, [missingLocal]).findMissingSkills()).map(s => s.skill), ['nonexistent-local-skill']);
});
