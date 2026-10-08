import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

export const WorkspaceRequestSchema = z.object({
  path: z.string().trim().min(1),
  create: z.boolean().default(false),
  handoff: z.string().max(4000).default('').describe('切换后继续执行所需的任务目标、已确认约束和下一步；不要包含推测的用户授权'),
});

export function resolveWorkspacePath(input: string, baseDirectory?: string): string {
  let value = input.trim();
  if (!value) throw new Error('工作目录不能为空');
  if (value === '~' || value.startsWith('~/')) value = homedir() + value.slice(1);
  if (!isAbsolute(value) && !baseDirectory) throw new Error('尚未绑定目录，请提供绝对路径或 ~/ 开头的路径');
  return resolve(baseDirectory || '/', value);
}

export async function ensureWorkspaceDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => { throw new Error(`工作目录不存在或不可访问: ${path}`); });
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹: ${path}`);
}

export async function prepareWorkspace(input: string, baseDirectory?: string, create = false): Promise<string> {
  const path = resolveWorkspacePath(input, baseDirectory);
  if (create) await mkdir(path, { recursive: true });
  await ensureWorkspaceDirectory(path);
  return realpath(path);
}
