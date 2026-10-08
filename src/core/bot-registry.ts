import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CliId } from '../cli/types.js';
import { OS_ROOT, SKILLS_ROOT } from './paths.js';
import { join, resolve } from 'node:path';

const ProductDeliveryModeSchema = z.enum(['local', 'lark-doc']);

export type ProductDeliveryMode = z.infer<typeof ProductDeliveryModeSchema>;

export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  role: string;
  skills: string[];
  systemPrompt: string;
  collaborationMaxRounds: number;
}

export interface AgentOsConfig {
  teamLeaderId: string;
  defaultProductDeliveryMode: ProductDeliveryMode;
  bots: BotConfig[];
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'bot id 只能使用小写字母、数字、连字符和下划线',
    ),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(['claude', 'codex']),
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(''),
  collaborationMaxRounds: z.number().int().min(1).max(32).optional().default(16),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  teamLeader: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  defaultProductDeliveryMode: ProductDeliveryModeSchema.optional()
    .default('lark-doc'),
  bots: z.array(BotSchema).min(1),
});

export function parseAgentOsConfig(
  input: unknown,
  env: Environment,
): AgentOsConfig {
  const parsed = BotConfigFileSchema.parse(input);
  if (parsed.bots.some(bot => bot.workspace) || env.CLI_WORKDIR || env.CLAUDE_WORKDIR) {
    console.warn('[工作目录] Bot workspace / CLI_WORKDIR / CLAUDE_WORKDIR 已弃用，新话题请通过对话或 /cd 选择目录。');
  }
  const ids = new Set<string>();
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`);
    ids.add(bot.id);
  }

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? '';
      const appSecret = env[bot.appSecretEnv]?.trim() ?? '';
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`);
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`);
      }
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        collaborationMaxRounds: bot.collaborationMaxRounds,
      };
    });
  if (configs.length === 0) throw new Error('至少需要启用一个 bot');
  const enabledIds = new Set(configs.map((config) => config.id));
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`);
  }
  return {
    teamLeaderId: parsed.teamLeader,
    defaultProductDeliveryMode: parsed.defaultProductDeliveryMode,
    bots: configs,
  };
}

export function parseBotConfigs(
  input: unknown,
  env: Environment,
): BotConfig[] {
  return parseAgentOsConfig(input, env).bots;
}

export async function loadAgentOsConfig(
  filePath: string,
  env: Environment = process.env,
): Promise<AgentOsConfig> {
  let content: string;
  try {
    content = await readFile(resolve(OS_ROOT, filePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      );
    }
    throw error;
  }

  try {
    return parseAgentOsConfig(JSON.parse(content), env);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`);
  }
}

export async function loadBotConfigs(
  filePath: string,
  env: Environment = process.env,
): Promise<BotConfig[]> {
  return (await loadAgentOsConfig(filePath, env)).bots;
}

// 飞书 Skill 由宿主机安装的包管理，OS 不解析路径或校验安装。
export function isOsManagedSkill(skill: string): boolean {
  return !skill.startsWith('lark-');
}

export function buildBotPrompt(
  config: Pick<BotConfig, 'role' | 'skills' | 'systemPrompt'>,
  prompt: string,
  teamContext = '',
  defaultProductDeliveryMode: ProductDeliveryMode = 'lark-doc',
): string {
  const localSkills = config.skills.filter(isOsManagedSkill);
  const externalSkills = config.skills.filter(skill => !isOsManagedSkill(skill));
  const managesProductDocuments = config.skills.some((skill) =>
    ['to-spec', 'to-tickets', 'lark-doc'].includes(skill));
  const productDeliveryPolicy = managesProductDocuments
    ? [
        '产品方案交付规则（必须遵守）：',
        `- 当前默认交付方式：${defaultProductDeliveryMode}。`,
        '- 用户明确指定本地 Markdown 或飞书云文档时，以用户本次选择覆盖默认值。',
        '- 不要为了选择交付格式单独发起澄清。',
        '- 方案产物完成后必须实际调用 request_spec_approval，并提交最终采用的 deliveryMode 与对应产物字段。',
        '- 不能只在普通回复中罗列 deliveryMode、documentUrl、specPath 或 ticketsPath。工具调用成功后停止本轮。',
      ].join('\n')
    : '';
  const feishuOutputPolicy = [
    '飞书输出规则（必须遵守）：',
    '- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。',
    '- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。',
    '- 详细产物写入当前工作区文件。回复只提供简短摘要和文件路径。',
    '- 需要用户决策时，必须调用 request_clarification 工具；不要用大段文字列出问题。工具调用后停止继续推断，等待用户回答。',
  ].join('\n');
  const sections = [
    `你的角色：${config.role}`,
    config.systemPrompt.trim(),
    teamContext.trim(),
    productDeliveryPolicy,
    config.skills.length > 0
      ? [
          '角色 Skill 加载规则：',
          ...(localSkills.length ? ['- 以下 OS 自有 Skill 只从列出的绝对路径读取，不使用任务工作目录中的同名版本。'] : []),
          '- Skill 的参考文件和脚本相对于 Skill 所在目录解析，交付产物写入任务工作目录。',
          ...localSkills.map(skill => `- ${skill}: ${join(SKILLS_ROOT, skill, 'SKILL.md')}`),
          ...(externalSkills.length ? [`- ${externalSkills.join('、')} 使用执行引擎中已安装的飞书 Skill 包，遵循该包的加载方式。`] : []),
          `本次任务必须执行的项目 Skill：${config.skills.map((skill) => `$${skill}`).join('、')}`,
        ].join('\n')
      : '',
    feishuOutputPolicy,
    `当前任务：${prompt}`,
  ];
  return sections.filter(Boolean).join('\n\n');
}
