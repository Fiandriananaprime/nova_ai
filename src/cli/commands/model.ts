import path from 'node:path';
import { writeJson } from '../../utils/fs.js';
import { loadConfig, CONFIG_RELATIVE_PATH } from '../../config/loader.js';
import { ConfigSchema } from '../../config/schema.js';
import { listProviders } from '../../ai/registry.js';

const aliases: Record<string, string> = {
  chatgpt: 'chatgpt-web',
  'chatgpt-web': 'chatgpt-web',
  claude: 'claude-web',
  'claude-web': 'claude-web',
  gemini: 'gemini-web',
  'gemini-web': 'gemini-web',
  mock: 'mock',
};

function displayName(providerId: string): string {
  return providerId.replace(/-web$/, '');
}

export async function modelList(projectRoot = process.cwd()): Promise<void> {
  const config = await loadConfig(projectRoot);
  console.log('Modèles disponibles :');
  for (const provider of listProviders()) {
    const selected = provider.id === config.defaultProvider;
    const name = displayName(provider.id);
    const state = provider.available ? 'disponible' : 'non implémenté';
    console.log(`${selected ? '●' : ' '} ${name.padEnd(10)} ${state.padEnd(15)} ${provider.description}`);
  }
  console.log('\nChoisir : /model <chatgpt|claude|gemini|mock>');
}

export async function modelUse(projectRoot: string, modelName: string): Promise<void> {
  const providerId = aliases[modelName.trim().toLowerCase()];
  if (!providerId) throw new Error(`Modèle inconnu : ${modelName}. Utilise /model list pour voir les choix.`);
  const provider = listProviders().find((item) => item.id === providerId);
  if (!provider || !provider.available) throw new Error(`Le modèle ${displayName(providerId)} n'est pas disponible : ${provider?.description ?? providerId}`);
  const config = await loadConfig(projectRoot);
  const next = ConfigSchema.parse({ ...config, defaultProvider: providerId });
  await writeJson(path.join(projectRoot, CONFIG_RELATIVE_PATH), next);
  console.log(`Modèle actif pour ce projet : ${displayName(providerId)}.`);
}
