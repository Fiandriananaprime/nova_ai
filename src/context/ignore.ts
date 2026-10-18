import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ignore, { type Ignore } from 'ignore';
import { NovaError } from '../utils/errors.js';

export const DEFAULT_NOVAIGNORE = `# Dependencies\nnode_modules/\nvendor/\n.venv/\nvenv/\n\n# Version control and agent internals\n.git/\n.nova_agents/\n\n# Build outputs\ndist/\nbuild/\ncoverage/\n.next/\n.nuxt/\n.output/\ntarget/\n\n# Caches\n.cache/\n.parcel-cache/\n.turbo/\n\n# IDE and operating-system files\n.vscode/\n.idea/\nThumbs.db\n.DS_Store\n\n# Environment secrets\n.env\n.env.*\n!.env.example\n!.env.sample\n\n# Common credential files\n*.pem\n*.key\nid_rsa\nid_ed25519\n\n# Large generated assets\n*.min.js\n*.map\n`;

export interface IgnoreRules {
  checker: Ignore;
  novaignorePath: string;
  gitignorePath: string;
}

async function readRules(filePath: string): Promise<string> {
  try { return await readFile(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    if ((error as NodeJS.ErrnoException).code === 'EACCES') throw new NovaError(`Accès refusé au fichier de règles : ${filePath}`, 'IGNORE_PERMISSION');
    throw error;
  }
}

export async function loadIgnoreRules(projectRoot: string): Promise<IgnoreRules> {
  const novaignorePath = path.join(projectRoot, '.novaignore');
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const novaignore = await readRules(novaignorePath);
  const gitignore = await readRules(gitignorePath);
  const checker = ignore({ ignorecase: process.platform === 'win32' });
  checker.add(DEFAULT_NOVAIGNORE);
  if (gitignore.trim()) checker.add(gitignore);
  if (novaignore.trim()) checker.add(novaignore);
  // These exclusions are enforced independently of user negation rules.
  checker.add(['.nova_agents/', '.git/', 'node_modules/', 'vendor/', '.venv/', 'venv/']);
  return { checker, novaignorePath, gitignorePath };
}

export function isIgnored(rules: IgnoreRules, relativePath: string, isDirectory = false): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const withSlash = isDirectory ? `${normalized.replace(/\/$/, '')}/` : normalized;
  if (normalized === '.nova_agents' || normalized.startsWith('.nova_agents/')) return true;
  if (normalized === '.git' || normalized.startsWith('.git/')) return true;
  if (normalized === 'node_modules' || normalized.startsWith('node_modules/')) return true;
  if (normalized === 'vendor' || normalized.startsWith('vendor/') || normalized === '.venv' || normalized.startsWith('.venv/') || normalized === 'venv' || normalized.startsWith('venv/')) return true;
  return rules.checker.ignores(withSlash);
}
