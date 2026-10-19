import path from 'node:path';
import { access, lstat, readFile, stat } from 'node:fs/promises';
import { saveDefaultConfig, loadConfig } from '../config/loader.js';
import { DEFAULT_NOVAIGNORE } from './ignore.js';
import { PROJECT_CONTEXT_TEMPLATE } from './descriptions.js';
import { assertSafeAgentDirectory } from '../security/agent-files.js';
import { writeAtomic } from '../utils/fs.js';

const AGENT_DIRECTORIES = ['sessions', 'diff', 'backups', 'patches', 'logs', 'output'] as const;

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let existing = '';
  try {
    const info = await lstat(gitignorePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('.gitignore doit être un fichier régulier ; Nova ne le remplacera pas.');
    existing = await readFile(gitignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hasNovaIgnoreRule = existing.split(/\r?\n/).some((line) => {
    const rule = line.trim().replace(/^\//, '').replace(/\/$/, '');
    return rule === '.nova_agents';
  });
  if (hasNovaIgnoreRule) return;
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeAtomic(gitignorePath, `${existing}${separator}# Nova Agent local state\n.nova_agents/\n`);
}

/** Create Nova's local project files once, without scanning or overwriting user configuration. */
export async function ensureProjectInitialized(projectInput: string): Promise<void> {
  const projectRoot = path.resolve(projectInput);
  const info = await stat(projectRoot);
  if (!info.isDirectory()) throw new Error(`Le projet doit être un dossier : ${projectRoot}`);

  const agentRoot = path.join(projectRoot, '.nova_agents');
  await assertSafeAgentDirectory(agentRoot, true);
  for (const directory of AGENT_DIRECTORIES) {
    await assertSafeAgentDirectory(path.join(agentRoot, directory), true);
  }

  const novaignorePath = path.join(projectRoot, '.novaignore');
  if (!(await exists(novaignorePath))) await writeAtomic(novaignorePath, DEFAULT_NOVAIGNORE);
  const configPath = path.join(agentRoot, 'config.json');
  if (!(await exists(configPath))) await saveDefaultConfig(projectRoot);
  else await loadConfig(projectRoot);
  const contextPath = path.join(agentRoot, 'project-context.md');
  if (!(await exists(contextPath))) await writeAtomic(contextPath, PROJECT_CONTEXT_TEMPLATE);

  await ensureGitignore(projectRoot);
}
