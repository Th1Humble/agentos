import type { Bot } from '../im/lark.js';
import type { BotConfig } from '../core/bot-registry.js';
import { formatApprovalDecision, type ApprovalFlow } from '../core/approval.js';
import type { AppRuntime } from './runtime.js';
import { continueTask } from './task-continuation.js';

export async function continueApprovalFlow(options: {
  runtime: AppRuntime; bot: Bot; config: BotConfig; flow: ApprovalFlow; run: AbortController;
}): Promise<void> {
  return continueTask({ ...options, prompt: formatApprovalDecision(options.flow) });
}
