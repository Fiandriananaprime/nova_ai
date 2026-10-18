import { NovaError } from '../utils/errors.js';
import { normalizeRelativePath } from '../security/paths.js';

export interface PatchFile {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  created: boolean;
  deleted: boolean;
}

function decodeGitPath(token: string): string {
  const value = token.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; }
    catch { throw new NovaError(`Chemin Git entre guillemets invalide : ${value}`, 'PATCH_PATH_INVALID'); }
  }
  return value;
}

function parseDiffHeader(line: string): { oldPath: string; newPath: string } {
  const value = line.slice('diff --git '.length);
  const quoted = value.match(/^("(?:\\.|[^"\\])*"|\S+)\s+("(?:\\.|[^"\\])*"|\S+)$/);
  if (quoted) return { oldPath: decodeGitPath(quoted[1]!), newPath: decodeGitPath(quoted[2]!) };
  const unquoted = value.match(/^a\/(.+) b\/(.+)$/);
  if (!unquoted) throw new NovaError(`En-tête diff illisible : ${line}`, 'PATCH_HEADER_INVALID');
  return { oldPath: `a/${unquoted[1]}`, newPath: `b/${unquoted[2]}` };
}

function parseHeaderPath(line: string): string | null {
  const value = line.slice(4).trim();
  if (value === '/dev/null') return null;
  const decoded = decodeGitPath(value.split('\t')[0]!);
  if (decoded.startsWith('a/')) return decoded.slice(2);
  if (decoded.startsWith('b/')) return decoded.slice(2);
  throw new NovaError(`Chemin de patch invalide : ${line}`, 'PATCH_PATH_INVALID');
}

export function parsePatch(patch: string): PatchFile[] {
  if (!patch.trim()) throw new NovaError('Le patch est vide.', 'PATCH_EMPTY');
  if (/GIT binary patch|^Binary files .* differ$/m.test(patch)) throw new NovaError('Les patchs binaires ne sont pas pris en charge.', 'PATCH_BINARY_UNSUPPORTED');
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = [line];
      blocks.push(current);
    } else if (current) current.push(line);
  }
  if (!blocks.length) throw new NovaError('Aucun en-tête « diff --git » trouvé dans le patch.', 'PATCH_FORMAT_INVALID');
  const files: PatchFile[] = [];
  for (const block of blocks) {
    const diffPaths = parseDiffHeader(block[0]!);
    const oldHeader = block.find((line) => line.startsWith('--- '));
    const newHeader = block.find((line) => line.startsWith('+++ '));
    if (!oldHeader || !newHeader) throw new NovaError(`En-têtes ---/+++ absents pour ${block[0]}`, 'PATCH_HEADER_INVALID');
    const oldPath = parseHeaderPath(oldHeader);
    const newPath = parseHeaderPath(newHeader);
    if (oldPath === null && newPath === null) throw new NovaError('Un patch ne peut pas supprimer et créer /dev/null en même temps.', 'PATCH_PATH_INVALID');
    const path = newPath ?? oldPath!;
    const normalized = normalizeRelativePath(path);
    if (oldPath !== null && normalizeRelativePath(oldPath) !== normalized) throw new NovaError(`Renommages non pris en charge : ${oldPath} -> ${newPath}`, 'PATCH_RENAME_UNSUPPORTED');
    if (newPath !== null && normalizeRelativePath(newPath) !== normalized) throw new NovaError(`Renommages non pris en charge : ${oldPath} -> ${newPath}`, 'PATCH_RENAME_UNSUPPORTED');
    const diffOld = diffPaths.oldPath.startsWith('a/') ? diffPaths.oldPath.slice(2) : diffPaths.oldPath;
    const diffNew = diffPaths.newPath.startsWith('b/') ? diffPaths.newPath.slice(2) : diffPaths.newPath;
    if (diffOld !== diffNew || normalizeRelativePath(diffOld) !== normalized) {
      throw new NovaError(`Les chemins de l'en-tête diff ne correspondent pas aux fichiers ciblés : ${block[0]}`, 'PATCH_PATH_MISMATCH');
    }
    const file: PatchFile = { path: normalized, oldPath: oldPath === null ? null : normalized, newPath: newPath === null ? null : normalized, created: oldPath === null, deleted: newPath === null };
    if (files.some((item) => item.path === file.path)) throw new NovaError(`Le patch cible plusieurs fois le même fichier : ${file.path}`, 'PATCH_DUPLICATE_PATH');
    files.push(file);
  }
  return files;
}
