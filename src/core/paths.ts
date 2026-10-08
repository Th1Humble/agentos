import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from 'dotenv';

export const OS_ROOT = fileURLToPath(new URL('../../', import.meta.url));
config({ path: resolve(OS_ROOT, '.env'), quiet: true });
export const DATA_ROOT = resolve(OS_ROOT, process.env.AGENT_OS_DATA_DIR ?? 'data');
export const SKILLS_ROOT = resolve(OS_ROOT, 'skills');
