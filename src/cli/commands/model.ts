import path from 'node:path';
import { readOperations } from '../../history/records.js';
import { readJson, writeJson } from '../../utils/fs.js';
import { loadConfig, CONFIG_RELATIVE_PATH } from '../../config/loader.js';
import { ConfigSchema } from '../../config/schema.js';
import { listProviders } from '../../ai/registry.js';

export async function modelList(): Promise<void> {
  for (const provider of listProviders()) {
    console.log(`${provider.id.padEnd(14)} ${provider.available ? '[disponible]' : '[non implémenté]'} ${provider.description}`);
  }
}

export async function modelUse(projectRoot: string, providerId: string): Promise<void> {
  const valid = listProviders().some((provider) => provider.id === providerId);
  if (!valid) throw new Error(`Fournisseur inconnu : ${providerId}. Lance « model list » pour voir les identifiants.`);
  const provider = listProviders().find((item) => item.id === providerId)!;
  if (!provider.available) throw new Error(`Le fournisseur ${providerId} n'est pas implémenté : ${provider.description}`);
  const config = await loadConfig(projectRoot);
  const next = ConfigSchema.parse({ ...config, defaultProvider: providerId });
  await writeJson(path.join(projectRoot, CONFIG_RELATIVE_PATH), next);
  console.log(`Fournisseur par défaut : ${providerId}`);
}
