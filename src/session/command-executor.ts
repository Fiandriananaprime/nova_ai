import path from 'node:path';
import { execa } from 'execa';
import { ask } from '../cli/prompts.js';
import { renderStatus } from '../cli/terminal-ui.js';
import { containsPotentialSecret } from '../security/secrets.js';
import { NovaError } from '../utils/errors.js';
import type { PersistedSession } from './persistence.js';
import { requestNovaApproval, emitNovaEvent } from './events.js';

const COMMAND_TIMEOUT_MS = 120_000;

function terminalSafe(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export interface CommandOutcome {
  approved: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

async function approveCommand(command: string, reason: string, session: PersistedSession): Promise<boolean> {
  if (session.approvalPolicy?.commands) return true;
  const desktopDecision = await requestNovaApproval({ kind: 'command', command, reason, cwd: path.resolve(session.projectRoot), sessionId: session.id });
  if (desktopDecision !== undefined) {
    if (desktopDecision === 'approve-session') {
      session.approvalPolicy ??= { read: false, write: false, commands: false };
      session.approvalPolicy.commands = true;
      return true;
    }
    return desktopDecision === 'approve';
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  console.log(`\nCommande demandée par l'IA :\n  ${command}`);
  console.log(`Motif : ${terminalSafe(reason) || '(non précisé)'}`);
  console.log(`Dossier : ${path.resolve(session.projectRoot)}`);
  console.log('Cette commande peut lire ou modifier des fichiers, accéder au réseau et transmettre sa sortie à l’IA. Vérifie-la avant accord.');
  while (true) {
    const answer = (await ask('Tape approve pour cette commande, approve command pour autoriser les suivantes de la session, ou rejected : ')).trim().toLowerCase();
    if (answer === 'approve') return true;
    if (answer === 'approve command') {
      session.approvalPolicy ??= { read: false, write: false, commands: false };
      session.approvalPolicy.commands = true;
      return true;
    }
    if (answer === 'reject' || answer === 'rejected' || answer === 'rejecte') return false;
    console.log('Réponse invalide. Tape approve, approve command ou rejected.');
  }
}

export async function executeRequestedCommand(
  command: string,
  reason: string,
  session: PersistedSession,
): Promise<CommandOutcome> {
  if (!command.trim() || command.length > 4000 || /[\u0000-\u001f\u007f]/.test(command)) {
    throw new NovaError('La commande est vide ou dépasse les limites locales.', 'COMMAND_INVALID');
  }
  if (!await approveCommand(command, reason, session)) {
    renderStatus('COMMAND_REJECTED', 'commande non exécutée');
    emitNovaEvent({ type: 'status', sessionId: session.id, state: 'WAITING_FOR_APPROVAL', detail: 'Commande refusée ; aucune commande exécutée.', at: new Date().toISOString() });
    return { approved: false, exitCode: null, stdout: '', stderr: 'Commande refusée par l’utilisateur.' };
  }

  renderStatus('COMMAND', command);
  let result: { exitCode: number | null; stdout: string; stderr: string };
  let timedOut = false;
  try {
    const child = await execa(command, {
      cwd: session.projectRoot,
      shell: true,
      reject: false,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    result = { exitCode: child.exitCode ?? null, stdout: child.stdout, stderr: child.stderr };
  } catch (error) {
    const issue = error as Error & { stdout?: string; stderr?: string; timedOut?: boolean; exitCode?: number | null };
    result = {
      exitCode: issue.exitCode ?? null,
      stdout: issue.stdout ?? '',
      stderr: issue.timedOut ? `Commande interrompue après ${COMMAND_TIMEOUT_MS / 1000} secondes.` : issue.message,
    };
    timedOut = Boolean(issue.timedOut);
  }

  if (containsPotentialSecret(`${result.stdout}\n${result.stderr}`)) {
    result = { ...result, stdout: '[sortie masquée : Nova a détecté un secret potentiel]', stderr: '' };
  } else {
    // Keep the bounded execa result intact; the orchestrator moves long output to
    // .nova_agents/output and streams it to the provider in acknowledged chunks.
    result = { ...result };
  }
  if (result.stdout) console.log(`\nstdout (${result.stdout.split(/\r?\n/).length} lignes)${result.stdout.split(/\r?\n/).length > 80 ? ' · voir le transfert par segments' : ''}:\n${terminalSafe(result.stdout.split(/\r?\n/).slice(0, 80).join('\n'))}${result.stdout.split(/\r?\n/).length > 80 ? '\n[… sortie complète transmise par segments]' : ''}`);
  if (result.stderr) console.log(`\nstderr (${result.stderr.split(/\r?\n/).length} lignes):\n${terminalSafe(result.stderr.split(/\r?\n/).slice(0, 80).join('\n'))}`);
  renderStatus('COMMAND_RESULT', `exit ${result.exitCode ?? 'inconnu'}${timedOut ? ' · délai dépassé' : ''}`);
  return { approved: true, ...result, ...(timedOut ? { timedOut: true } : {}) };
}

export function formatCommandResult(command: string, outcome: CommandOutcome): string {
  return `Résultat de la commande demandée :\nCommande : ${command}\nAutorisée : ${outcome.approved ? 'oui' : 'non'}\nCode de sortie : ${outcome.exitCode ?? 'non exécutée'}\nSortie standard :\n${outcome.stdout || '(vide)'}\nErreur standard :\n${outcome.stderr || '(vide)'}\nPoursuis la tâche à partir de ce résultat. Si une autre commande est nécessaire, demande-la via RUN_COMMAND. N’affirme pas qu’une commande a réussi si son code de sortie est non nul.`;
}
