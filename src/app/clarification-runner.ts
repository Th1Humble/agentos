import type { Bot } from '../im/lark.js';
import type { BotConfig } from '../core/bot-registry.js';
import { formatClarificationAnswers, type ClarificationFlow } from '../core/clarification.js';
import type { AppRuntime } from './runtime.js';
import { continueTask } from './task-continuation.js';

export async function continueClarificationFlow(options: {
  runtime: AppRuntime; bot: Bot; config: BotConfig; flow: ClarificationFlow;
  run: AbortController; defaultDeliveryMode: 'local' | 'lark-doc';
}): Promise<void> {
  return continueTask({ ...options, prompt: formatClarificationAnswers(options.flow) });
}
