import { EdgeSession } from '../../browser/session.js';
import { inspectChatGPTPage } from '../../browser/page-inspector.js';
import { ask } from '../prompts.js';
import { isInteractive } from '../../utils/fs.js';
import { loadConfig } from '../../config/loader.js';
import { getEdgeProfilePath } from '../../browser/edge.js';

export async function browserCommand(projectRoot: string): Promise<void> {
  const config = await loadConfig(projectRoot);
  const session = new EdgeSession(config.browser.channel, config.browser.timeoutMs);
  try {
    const page = await session.openChatGPT();
    let state = await inspectChatGPTPage(page);
    console.log(`Edge ouvert sur https://chatgpt.com/ — profil persistant dédié : ${getEdgeProfilePath()}`);
    if (!state.authenticated || !state.usable) {
      console.log(`${state.detail} Connecte-toi manuellement dans la fenêtre Edge. Nova Agent ne collecte ni ne demande ton mot de passe.`);
      if (!isInteractive()) return;
      await ask('Après la connexion, appuie sur Entrée pour revérifier… ');
      state = await inspectChatGPTPage(page);
    }
    console.log(state.usable ? 'Session et champ de conversation détectés.' : `Interface non prête : ${state.detail}`);
    if (isInteractive()) await ask('Appuie sur Entrée pour fermer la session Edge… ');
  } finally {
    await session.close(true);
  }
}
