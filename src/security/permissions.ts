import path from 'node:path';
import { loadIgnoreRules, isIgnored } from '../context/ignore.js';
import { assertNoSymlinkEscape, isSecretPath, normalizeRelativePath, resolveInside } from './paths.js';
import { NovaError } from '../utils/errors.js';

export type PathIntent = 'read' | 'write';
export async function assertAllowedProjectPath(projectRoot: string, inputPath: string, intent: PathIntent, allowMissingLeaf = false): Promise<{ relativePath: string; absolutePath: string }> {
  const relativePath = normalizeRelativePath(inputPath);
  if (isSecretPath(relativePath)) throw new NovaError(`Chemin sensible interdit : ${relativePath}`, intent === 'read' ? 'FILE_SENSITIVE' : 'PATCH_SENSITIVE_PATH');
  const rules = await loadIgnoreRules(path.resolve(projectRoot));
  if (isIgnored(rules, relativePath)) throw new NovaError(`Chemin exclu par les règles locales : ${relativePath}`, intent === 'read' ? 'FILE_IGNORED' : 'PATCH_IGNORED_PATH');
  const absolutePath = resolveInside(projectRoot, relativePath);
  await assertNoSymlinkEscape(projectRoot, relativePath, allowMissingLeaf);
  return { relativePath, absolutePath };
}
