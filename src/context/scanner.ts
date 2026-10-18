import path from 'node:path';
import { lstat } from 'node:fs/promises';
import fg from 'fast-glob';
import { loadIgnoreRules, isIgnored } from './ignore.js';
import { NovaError } from '../utils/errors.js';
import { isSecretPath } from '../security/paths.js';

export interface ScanEntry { path: string; type: 'file' | 'directory'; size?: number; }
export interface ScanResult {
  root: string;
  entries: ScanEntry[];
  files: ScanEntry[];
  directories: ScanEntry[];
  ignored: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; message: string }>;
  totalBytes: number;
}

const DEFAULT_MAX_ENTRIES = 25000;

export async function scanProject(projectRoot: string, options: { maxEntries?: number } = {}): Promise<ScanResult> {
  const root = path.resolve(projectRoot);
  const rules = await loadIgnoreRules(root);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const patterns = await fg('**/*', {
    cwd: root,
    dot: true,
    onlyFiles: false,
    unique: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: ['.git/**', '.nova_agents/**', 'node_modules/**', 'vendor/**', '.venv/**', 'venv/**'],
  });
  const entries: ScanEntry[] = [];
  const ignored: ScanResult['ignored'] = [];
  const errors: ScanResult['errors'] = [];
  let totalBytes = 0;

  // Report the presence/reason of protected roots without enumerating their contents.
  for (const protectedPath of ['.git', '.nova_agents', 'node_modules', 'vendor', '.venv', 'venv']) {
    try {
      const info = await lstat(path.join(root, protectedPath));
      if (info.isDirectory() || info.isSymbolicLink()) {
        ignored.push({ path: protectedPath, reason: 'Dossier protégé exclu du scan et du contexte' });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push({ path: protectedPath, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  patterns.sort((a: string, b: string) => a.localeCompare(b, 'en'));
  for (const item of patterns) {
    if (entries.length >= maxEntries) {
      ignored.push({ path: item, reason: `Limite de scan atteint (${maxEntries} entrées)` });
      break;
    }
    const normalized = item.replaceAll('\\', '/');
    let info;
    try { info = await lstat(path.join(root, item)); }
    catch (error) {
      errors.push({ path: normalized, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (info.isSymbolicLink()) {
      ignored.push({ path: normalized, reason: 'Lien symbolique non suivi' });
      continue;
    }
    if (!info.isFile() && !info.isDirectory()) continue;
    if (!info.isDirectory() && isSecretPath(normalized)) {
      ignored.push({ path: normalized, reason: 'Nom de fichier sensible détecté' });
      continue;
    }
    const directory = info.isDirectory();
    if (isIgnored(rules, normalized, directory)) {
      if (!ignored.some((item) => item.path === normalized)) {
        ignored.push({ path: normalized, reason: 'Règle .novaignore/.gitignore ou exclusion de sécurité' });
      }
      continue;
    }
    if (!directory) totalBytes += info.size;
    entries.push({ path: normalized, type: directory ? 'directory' : 'file', ...(directory ? {} : { size: info.size }) });
  }
  const files = entries.filter((entry) => entry.type === 'file');
  const directories = entries.filter((entry) => entry.type === 'directory');
  return { root, entries, files, directories, ignored, errors, totalBytes };
}

export function renderTree(rootName: string, entries: ScanEntry[], maxLines = 12000): string {
  const byParent = new Map<string, ScanEntry[]>();
  for (const entry of entries) {
    const parent = path.posix.dirname(entry.path);
    const children = byParent.get(parent) ?? [];
    children.push(entry);
    byParent.set(parent, children);
  }
  for (const children of byParent.values()) {
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return path.posix.basename(a.path).localeCompare(path.posix.basename(b.path), 'en');
    });
  }
  const lines = [`${rootName}/`];
  const walk = (parent: string, prefix: string): void => {
    if (lines.length >= maxLines) return;
    const children = byParent.get(parent) ?? [];
    children.forEach((child, index) => {
      if (lines.length >= maxLines) return;
      const last = index === children.length - 1;
      const name = path.posix.basename(child.path) + (child.type === 'directory' ? '/' : '');
      lines.push(`${prefix}${last ? '└── ' : '├── '}${name}`);
      if (child.type === 'directory') walk(child.path, `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  walk('.', '');
  if (lines.length >= maxLines) lines.push('… (arborescence tronquée)');
  return `${lines.join('\n')}\n`;
}

export function assertProjectRoot(root: string): void {
  if (!path.isAbsolute(root)) throw new NovaError('Le chemin du projet doit être résolu en chemin absolu.', 'PROJECT_PATH_NOT_ABSOLUTE');
}
