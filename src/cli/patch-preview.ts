import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PatchFile } from '../patches/parser.js';

function countChanges(section: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of section.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added += 1;
    if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function splitPatch(patch: string): string[] {
  const sections: string[] = [];
  let current: string[] | undefined;
  for (const line of patch.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current.join('\n'));
      current = [];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current.join('\n'));
  return sections;
}

function terminalLink(label: string, reportPath: string): string {
  const safeLabel = label.replace(/[\u001b\u0000-\u001f]/g, '');
  return `\u001b]8;;${pathToFileURL(reportPath).href}\u001b\\${safeLabel}\u001b]8;;\u001b\\`;
}

export function renderPatchPreview(projectRoot: string, files: PatchFile[], patch: string, reportPath: string): string {
  const sections = splitPatch(patch);
  const lines = files.map((file, index) => {
    const counts = countChanges(sections[index] ?? '');
    const action = file.deleted ? 'delete' : 'write';
    return `  ${action} ${terminalLink(file.path, reportPath)} +${counts.added} -${counts.removed}`;
  });
  const relativeReport = path.relative(projectRoot, reportPath);
  return `Modifications proposées :\n${lines.join('\n')}\nRapport Markdown complet : ${relativeReport}`;
}
