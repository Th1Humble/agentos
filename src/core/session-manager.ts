import { randomUUID } from 'node:crypto';
import type { CliId } from '../cli/types.js';
import type { SessionStore } from './session-store.js';

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed';

export interface Session {
  id: string;
  botId: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  cliSessionId?: string;
  workspaceDir: string;
  workspaceConflict?: boolean;
  taskContext?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export interface ResolvedSession {
  session: Session;
  isNew: boolean;
}

export interface SessionManagerOptions {
  now?: () => Date;
  createId?: () => string;
  store?: SessionStore;
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['active', 'idle', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
};

function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

function sessionKey(botId: string, chatId: string, threadId: string): string {
  return `${botId}:${chatId}:${threadId}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store?: SessionStore;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
  }

  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = (await options.store?.load()) ?? [];
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      );
    }
    const topics = new Map<string, Session[]>();
    for (const session of manager.sessions.values()) {
      const key = JSON.stringify([session.chatId, session.threadId]);
      topics.set(key, [...(topics.get(key) ?? []), session]);
    }
    let changed = false;
    for (const peers of topics.values()) {
      if (new Set(peers.map(s => s.workspaceDir)).size <= 1) continue;
      console.warn('[工作目录] 历史话题目录不一致，需要重新选择:', peers[0].threadId);
      for (const session of peers) { session.workspaceDir = ''; session.workspaceConflict = true; delete session.cliSessionId; }
      changed = true;
    }
    if (changed) await manager.persist();
    return manager;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find(
      (session) => session.id === sessionId,
    );
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = 'claude',
    botId = 'default',
    workspaceDir = '',
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message);
    const key = sessionKey(botId, message.chatId, threadId);
    const existing = this.sessions.get(key);
    if (existing) return { session: existing, isNew: false };

    const peers = [...this.sessions.values()].filter(s => s.chatId === message.chatId && s.threadId === threadId);
    if (peers.length) workspaceDir = peers[0].workspaceDir;
    const now = this.now().toISOString();
    const session: Session = {
      id: this.createId(),
      botId,
      threadId,
      chatId: message.chatId,
      cliId,
      workspaceDir,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      throw error;
    }
    return { session, isNew: true };
  }

  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
    }

    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空');
    return this.updateCliSelection(sessionId, cliSessionId);
  }

  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, undefined);
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
    allowActiveSession = false,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);

    if (current.workspaceDir === workspaceDir) return current;

    const peers = this.topicSessions(sessionId);
    this.assertWorkspaceChangeAllowed(sessionId, allowActiveSession);
    const previous = peers.map(s => ({ ...s }));
    for (const session of peers) {
      const { cliSessionId: _, ...rest } = session;
      this.sessions.set(sessionKey(session.botId, session.chatId, session.threadId), {
        ...rest, workspaceDir, workspaceConflict: undefined, updatedAt: this.now().toISOString(),
      });
    }
    try { await this.persist(); }
    catch (error) {
      for (const session of previous) this.sessions.set(sessionKey(session.botId, session.chatId, session.threadId), session);
      throw error;
    }
    return this.get(sessionId)!;
  }

  assertWorkspaceChangeAllowed(sessionId: string, allowActiveSession = false): void {
    const peers = this.topicSessions(sessionId);
    if (peers.some(s => (s.status === 'active' || s.status === 'creating') && !(allowActiveSession && s.id === sessionId))) {
      throw new Error('话题中有成员正在执行，请结束后切换目录');
    }
    this.workspaceChangeGuard?.(peers);
  }

  conflictedSessionIds(): Set<string> {
    return new Set([...this.sessions.values()].filter(s => s.workspaceConflict).map(s => s.id));
  }

  async setTaskContext(sessionId: string, text: string): Promise<void> {
    const current = this.get(sessionId);
    if (!current) throw new Error('会话不存在');
    const updated = { ...current, taskContext: text.slice(-8000) };
    const key = sessionKey(current.botId, current.chatId, current.threadId);
    this.sessions.set(key, updated);
    try { await this.persist(); }
    catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
  }

  workspaceChangeGuard?: (sessions: Session[]) => void;

  topicSessions(sessionId: string): Session[] {
    const current = this.get(sessionId);
    return current ? [...this.sessions.values()].filter(s => s.chatId === current.chatId && s.threadId === current.threadId) : [];
  }

  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()]);
  }
}
