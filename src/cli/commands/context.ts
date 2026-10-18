import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { refreshTree } from '../../context/tree.js';
import { scanProject } from '../../context/scanner.js';
import { assertSafeAgentPath } from '../../security/agent-files.js';

export async function contextCommand(projectRoot: string, action: string): Promise<void> {
  const root = path.resolve(projectRoot);
  if (action === 'show') {
    const contextPath = path.join(root, '.nova_agents', 'project-context.md');
    await assertSafeAgentPath(contextPath);
    const context = await readFile(contextPath, 'utf8');
    console.log(context);
    return;
  }
  if (action === 'tree') {
    const { tree, scan } = await refreshTree(root);
    console.log(tree);
    console.log(`\n${scan.files.length} fichiers | ${scan.directories.length} dossiers | ${scan.ignored.length} éléments ignorés | ${scan.totalBytes} octets`);
    return;
  }
  if (action === 'refresh') {
    const { tree, scan } = await refreshTree(root);
    console.log(`Arborescence actualisée : ${path.join(root, '.nova_agents', 'project-tree.txt')}`);
    console.log(tree);
    console.log(`${scan.files.length} fichiers analysés ; ${scan.errors.length} erreur(s) de scan.`);
    for (const error of scan.errors.slice(0, 20)) console.log(`⚠ ${error.path}: ${error.message}`);
    return;
  }
  const scan = await scanProject(root);
  console.log(`Fichiers inclus : ${scan.files.length}; dossiers inclus : ${scan.directories.length}; ignorés : ${scan.ignored.length}; erreurs : ${scan.errors.length}`);
}
