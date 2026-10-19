import path from 'node:path';
import { access } from 'node:fs/promises';
import { loadConfig } from '../../config/loader.js';
import { refreshTree } from '../../context/tree.js';
import { scanProject } from '../../context/scanner.js';
import { AuxiliaryGitRepository } from '../../history/git-repository.js';
import { ensureProjectInitialized } from '../../context/project-setup.js';

async function fileExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function initProject(projectInput = '.'): Promise<void> {
  const projectRoot = path.resolve(projectInput);
  const info = await import('node:fs/promises').then(({ stat }) => stat(projectRoot));
  if (!info.isDirectory()) throw new Error(`Le chemin du projet n'est pas un dossier : ${projectRoot}`);
  const created: string[] = [];
  const initialFiles = ['.novaignore', '.nova_agents', '.nova_agents/config.json', '.nova_agents/project-context.md'];
  const missingBefore = new Set<string>();
  for (const relative of initialFiles) if (!(await fileExists(path.join(projectRoot, relative)))) missingBefore.add(relative);
  await ensureProjectInitialized(projectRoot);
  created.push(...missingBefore);

  const config = await loadConfig(projectRoot);
  if (missingBefore.size > 0) console.log('Création automatique des fichiers locaux Nova et ajout de .nova_agents/ au .gitignore.');
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
