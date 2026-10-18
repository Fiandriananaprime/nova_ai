import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { saveDefaultConfig, loadConfig } from '../../config/loader.js';
import { DEFAULT_NOVAIGNORE } from '../../context/ignore.js';
import { PROJECT_CONTEXT_TEMPLATE } from '../../context/descriptions.js';
import { refreshTree } from '../../context/tree.js';
import { scanProject } from '../../context/scanner.js';
import { AuxiliaryGitRepository } from '../../history/git-repository.js';
import { confirm } from '../prompts.js';
import { writeAtomic } from '../../utils/fs.js';
import { assertSafeAgentDirectory } from '../../security/agent-files.js';

async function fileExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function initProject(projectInput = '.', options: { addGitignore?: boolean } = {}): Promise<void> {
  const projectRoot = path.resolve(projectInput);
  const info = await import('node:fs/promises').then(({ stat }) => stat(projectRoot));
  if (!info.isDirectory()) throw new Error(`Le chemin du projet n'est pas un dossier : ${projectRoot}`);
  const created: string[] = [];
  await assertSafeAgentDirectory(path.join(projectRoot, '.nova_agents'), true);
  const novaignorePath = path.join(projectRoot, '.novaignore');
  if (!(await fileExists(novaignorePath))) {
    await writeAtomic(novaignorePath, DEFAULT_NOVAIGNORE);
    created.push('.novaignore');
  } else console.log('Conservé : .novaignore existant (aucun remplacement).');

  const directories = ['.nova_agents', '.nova_agents/sessions', '.nova_agents/diff', '.nova_agents/backups', '.nova_agents/patches', '.nova_agents/logs'];
  for (const relative of directories) await assertSafeAgentDirectory(path.join(projectRoot, relative), true);
  if (!(await fileExists(path.join(projectRoot, '.nova_agents', 'config.json')))) {
    await saveDefaultConfig(projectRoot);
    created.push('.nova_agents/config.json');
  } else await loadConfig(projectRoot);
  if (!(await fileExists(path.join(projectRoot, '.nova_agents', 'project-context.md')))) {
    await writeAtomic(path.join(projectRoot, '.nova_agents', 'project-context.md'), PROJECT_CONTEXT_TEMPLATE);
    created.push('.nova_agents/project-context.md');
  } else console.log('Conservé : .nova_agents/project-context.md existant (aucun remplacement).');

  const config = await loadConfig(projectRoot);
  if (options.addGitignore || await confirm('Ajouter .nova_agents/ au .gitignore du dépôt principal ? Nova Agent ne le modifiera pas sans autorisation explicite.')) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    const existing = (await fileExists(gitignorePath)) ? await readFile(gitignorePath, 'utf8') : '';
    if (!existing.split(/\r?\n/).some((line) => line.trim() === '.nova_agents/')) {
      const next = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}# Nova Agent local state\n.nova_agents/\n`;
      await writeAtomic(gitignorePath, next);
      console.log('Ajout de .nova_agents/ au .gitignore principal.');
    }
  }
  const { scan } = await refreshTree(projectRoot);
  created.push('.nova_agents/project-tree.txt');
  if (config.history.enabled) {
    const repository = new AuxiliaryGitRepository(projectRoot, config.history.directory);
    if (!(await repository.exists())) {
      await repository.initialize();
      await repository.snapshot(scan.files.map((item) => item.path));
      created.push(config.history.directory);
    } else if (!(await repository.head())) {
      await repository.snapshot(scan.files.map((item) => item.path));
      console.log('Snapshot initial créé dans l’historique auxiliaire existant.');
    } else console.log('Conservé : historique Git auxiliaire existant.');
  }
  console.log(`\nNova Agent initialisé : ${projectRoot}`);
  console.log(`Fichiers analysés : ${scan.files.length} | Répertoires ignorés : ${scan.ignored.length} | Taille des fichiers listés : ${scan.totalBytes} octets`);
  console.log(`Créé ou mis à jour : ${created.join(', ') || 'aucun'}`);
  console.log('Le dépôt principal n’a pas été initialisé, réinitialisé ou commité par Nova Agent.');
}
