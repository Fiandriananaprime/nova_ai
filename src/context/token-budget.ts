export interface ContextPacket { projectContext: string; tree?: string; truncated: boolean; characters: number; }

function clip(text: string, max: number, label: string): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const marker = `\n\n[… ${label} tronqué par la limite de contexte locale …]\n\n`;
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room * 0.78);
  const tail = Math.max(0, room - head);
  return { text: `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ''}`, truncated: true };
}

export function fitContext(projectContext: string, tree: string, maxChars: number): ContextPacket {
  const safeMax = Math.max(4000, maxChars);
  const projectLimit = Math.floor(safeMax * 0.68);
  const treeLimit = safeMax - projectLimit;
  const project = clip(projectContext, projectLimit, 'project-context.md');
  const treeResult = clip(tree, treeLimit, 'project-tree.txt');
  return {
    projectContext: project.text,
    ...(treeResult.text ? { tree: treeResult.text } : {}),
    truncated: project.truncated || treeResult.truncated,
    characters: project.text.length + treeResult.text.length,
  };
}
