import { readFileSync } from 'node:fs';

const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };

export const NOVA_VERSION = typeof packageManifest.version === 'string' ? packageManifest.version : 'unknown';
