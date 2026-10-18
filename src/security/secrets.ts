import { NovaError } from '../utils/errors.js';

const PLACEHOLDER = /^(?:['"]?(?:change[-_ ]?me|example|placeholder|dummy|replace[-_ ]?me|your[-_ ].*|<[^>]+>|\$\{[^}]+\}|process\.env\.[A-Z0-9_]+|\*{3,})['"]?)$/i;

export function containsPotentialSecret(content: string): boolean {
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(content)) return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(content)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(content)) return true;
  if (/\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(content)) return true;
  const assignment = /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|private[_-]?key|secret|authorization)\s*[:=]\s*(?:(["'])(.*?)\1|([^\s,;#]+))/i;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(assignment);
    if (!match) continue;
    const quoted = Boolean(match[1]);
    const value = (quoted ? match[2] : match[3])?.trim() ?? '';
    if (value.length < 8 || PLACEHOLDER.test(value) || /^(?:null|undefined|false|true)$/i.test(value)) continue;
    // Ordinary source-code references are not literal credentials; long unquoted tokens are suspicious.
    if (!quoted && (value.startsWith('${') || value.startsWith('process.env.') || value.includes('.') || value.includes('(') || value.startsWith('$'))) continue;
    if (quoted || /^[A-Za-z0-9_+/=-]{20,}$/.test(value)) return true;
    if (!quoted && /^[A-Za-z_$][\w$]*$/.test(value)) continue;
  }
  return false;
}

export function assertNoPotentialSecret(content: string, relativePath: string): void {
  if (containsPotentialSecret(content)) {
    throw new NovaError(`Le contenu de ${relativePath} semble contenir un secret. Nova Agent refuse de le transmettre ou de l’enregistrer dans un rapport. Retire ou remplace ce secret localement, puis recommence.`, 'CONTENT_SECRET_DETECTED');
  }
}
