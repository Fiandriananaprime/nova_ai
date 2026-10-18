import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { NovaError } from '../utils/errors.js';

export function normalizeRelativePath(input: string): string {
  if (!input || input.includes('\0')) throw new NovaError('Chemin de fichier vide ou invalide.', 'PATH_INVALID');
  const slash = input.replaceAll('\\', '/');
  if (slash.startsWith('/') || /^[A-Za-z]:/.test(slash) || slash.startsWith('//')) {
    throw new NovaError(`Chemin absolu interdit : ${input}`, 'PATH_ABSOLUTE');
  }
  const parts = slash.split('/');
  if (parts.some((part) => part === '..')) throw new NovaError(`Traversée de répertoire interdite : ${input}`, 'PATH_TRAVERSAL');
  const normalized = path.posix.normalize(slash);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new NovaError(`Chemin non autorisé : ${input}`, 'PATH_INVALID');
  }
  return normalized;
}

export function resolveInside(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(root, ...normalized.split('/'));
  const rel = path.relative(path.resolve(root), absolute);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new NovaError(`Le chemin sort du projet : ${relativePath}`, 'PATH_OUTSIDE_PROJECT');
  }
  if (normalized === '.nova_agents' || normalized.startsWith('.nova_agents/')) {
    throw new NovaError('Les fichiers internes de Nova Agent ne peuvent pas être modifiés par un patch.', 'PATH_AGENT_INTERNAL');
  }
  return absolute;
}

export function isSecretPath(relativePath: string): boolean {
  const p = relativePath.replaceAll('\\', '/').toLowerCase();
  const base = p.split('/').at(-1) ?? p;
  if (base === '.env' || (base.startsWith('.env.') && !['.env.example', '.env.sample'].includes(base))) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base)) return true;
  if (/(^|\/)(credentials|secrets?)(\/|\.|$)/.test(p)) return true;
  if (/(token|secret|password|private[-_]?key)\.(json|ya?ml|txt|conf)$/i.test(base)) return true;
  return false;
}

export async function assertNoSymlinkEscape(root: string, relativePath: string, allowMissingLeaf = false): Promise<void> {
  const normalized = normalizeRelativePath(relativePath);
  const rootReal = await realpath(root);
  const segments = normalized.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new NovaError(`Les liens symboliques ne sont pas acceptés dans les chemins modifiés : ${relativePath}`, 'SYMLINK_FORBIDDEN');
      if (index < segments.length - 1 && !info.isDirectory()) throw new NovaError(`Un composant du chemin n'est pas un dossier : ${relativePath}`, 'PATH_COMPONENT_NOT_DIRECTORY');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingLeaf && index === segments.length - 1) return;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  const absoluteReal = await realpath(path.resolve(root, ...segments));
  const relativeReal = path.relative(rootReal, absoluteReal);
  if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
    throw new NovaError(`Le chemin réel sort du projet : ${relativePath}`, 'PATH_OUTSIDE_PROJECT');
  }
}
