import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { isInteractive } from '../utils/fs.js';

export async function ask(question: string, defaultValue = ''): Promise<string> {
  if (!isInteractive()) return defaultValue;
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
}

export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  if (!isInteractive()) return false;
  const answer = (await ask(`${question} ${defaultValue ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (!answer) return defaultValue;
  return ['y', 'yes', 'o', 'oui'].includes(answer);
}

export async function approveOrReject(question: string): Promise<boolean> {
  while (true) {
    const answer = (await ask(`${question} Tape approve (tout le patch de cette session), approve all, ou reject : `)).trim().toLowerCase();
    if (answer === 'approve' || answer === 'approve all') return true;
    if (answer === 'reject' || answer === 'rejected') return false;
    console.log('Réponse invalide. Tape approve, approve all ou reject.');
  }
}
