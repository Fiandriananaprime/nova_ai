import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ConfigSchema, DEFAULT_CONFIG, type NovaConfig } from './schema.js';
import { NovaError } from '../utils/errors.js';
import { writeJson } from '../utils/fs.js';
import { assertSafeAgentPath } from '../security/agent-files.js';

export const AGENT_DIR = '.nova_agents';
export const CONFIG_RELATIVE_PATH = path.join(AGENT_DIR, 'config.json');

export async function loadConfig(projectRoot: string): Promise<NovaConfig> {
  const configPath = path.join(projectRoot, CONFIG_RELATIVE_PATH);
  try {
    await assertSafeAgentPath(configPath);
    const raw: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    const config = ConfigSchema.parse(raw);
    const historyDirectory = config.history.directory.replaceAll('\\', '/');
    const absoluteHistory = path.resolve(projectRoot, historyDirectory);
    const relativeHistory = path.relative(path.resolve(projectRoot), absoluteHistory).replaceAll('\\', '/');
    if (path.isAbsolute(historyDirectory) || relativeHistory === '.nova_agents' || !relativeHistory.startsWith('.nova_agents/')) {
      throw new Error('history.directory doit rester à l’intérieur de .nova_agents/.');
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    throw new NovaError(`Configuration invalide (${configPath}) : ${error instanceof Error ? error.message : String(error)}`, 'CONFIG_INVALID', { cause: error });
  }
}

export async function saveDefaultConfig(projectRoot: string): Promise<void> {
  await writeJson(path.join(projectRoot, CONFIG_RELATIVE_PATH), DEFAULT_CONFIG);
}
