import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createProvider } from '../ai/registry.js';
import { loadConfig } from '../config/loader.js';
import { readProjectFile } from '../context/file-reader.js';
import { readOptional, id } from '../utils/fs.js';
import { NovaError, asNovaError } from '../utils/errors.js';
import { validateRequestedFiles } from '../protocol/validator.js';
import type { AIProvider, AIResponse } from '../protocol/schema.js';
import { validatePatch } from '../patches/validator.js';
import { applyOperation } from '../history/operation-service.js';
import { saveReport, type OperationRecord } from '../history/markdown-reports.js';
import { upsertOperation } from '../history/records.js';
import { ask, approveOrReject } from '../cli/prompts.js';
import { renderPatchPreview } from '../cli/patch-preview.js';
import { renderDone, renderEvent, renderStatus, renderSummary, startThinking } from '../cli/terminal-ui.js';
import { isInteractive } from '../utils/fs.js';
import { refreshTree } from '../context/tree.js';
import { PROJECT_CONTEXT_TEMPLATE } from '../context/descriptions.js';
import { fitContext } from '../context/token-budget.js';
import { assertTransition } from './state-machine.js';
import { prepareAndStorePatch } from '../patches/prepare.js';
import { loadIgnoreRules, isIgnored } from '../context/ignore.js';
import { saveSession, type PersistedSession } from './persistence.js';
import { assertNoPotentialSecret } from '../security/secrets.js';
import type { ProjectFile } from '../context/file-reader.js';

export interface FixOptions {
  projectRoot: string;
  problem?: string;
  providerId?: string;
  maxCycles?: number;
  dryRun?: boolean;
  noApply?: boolean;
  resumeSession?: PersistedSession;
}

async function readProjectContext(projectRoot: string): Promise<string> {
  const contextPath = path.join(projectRoot, '.nova_agents', 'project-context.md');
  const context = (await readOptional(contextPath)) ?? PROJECT_CONTEXT_TEMPLATE;
  assertNoPotentialSecret(context, '.nova_agents/project-context.md');
  return context;
}

function transition(session: PersistedSession, state: PersistedSession['state'], detail: string): void {
  assertTransition(session.state, state);
  session.state = state;
  session.exchanges.push({ at: new Date().toISOString(), state, detail: detail.slice(0, 3000) });
}

async function getProvider(providerId: string, projectRoot: string): Promise<AIProvider> {
  const config = await loadConfig(projectRoot);
  const provider = createProvider(providerId, config, projectRoot);
  if (!provider.available) throw new NovaError(`Fournisseur ${providerId} indisponible : ${provider.description}`, 'PROVIDER_NOT_AVAILABLE');
  return provider;
}

async function readRequestedFile(
  projectRoot: string,
  requestedPath: string,
  maxBytes: number,
  session: PersistedSession,
): Promise<ProjectFile> {
  const approvedHash = session.approvedSensitiveFiles?.[requestedPath];
  if (approvedHash) {
    const previouslyApproved = await readProjectFile(projectRoot, requestedPath, maxBytes, { allowPotentialSecrets: true });
    if (previouslyApproved.sha256 === approvedHash) return previouslyApproved;
    delete session.approvedSensitiveFiles?.[requestedPath];
  }

  try {
    return await readProjectFile(projectRoot, requestedPath, maxBytes);
  } catch (error) {
    if (asNovaError(error).code !== 'CONTENT_SECRET_DETECTED') throw error;
  }

  if (!isInteractive()) {
    throw new NovaError(`Secret potentiel détecté dans ${requestedPath} ; approbation interactive requise.`, 'CONTENT_SECRET_APPROVAL_REQUIRED');
  }

  let answer = '';
  while (answer !== 'approve' && answer !== 'rejected') {
    answer = (await ask(`Secret potentiel détecté dans ${requestedPath}. Tape approve pour transmettre ce fichier tel quel à l’IA, ou rejected pour le bloquer : `)).trim().toLowerCase();
    if (!answer) answer = 'rejected';
    else if (answer !== 'approve' && answer !== 'rejected') console.log('Réponse invalide. Tape approve ou rejected.');
  }
  if (answer === 'rejected') {
    throw new NovaError(`Transmission de ${requestedPath} refusée par l’utilisateur.`, 'CONTENT_SECRET_REJECTED');
  }

  const approved = await readProjectFile(projectRoot, requestedPath, maxBytes, { allowPotentialSecrets: true });
  session.approvedSensitiveFiles ??= {};
  session.approvedSensitiveFiles[approved.path] = approved.sha256;
  await saveSession(session);
  return approved;
}

const MAX_LINES_PER_FILE_CHUNK = 300;
const MAX_BYTES_PER_FILE_CHUNK = 12 * 1024;

interface FileChunk { content: string; firstLine: number; lastLine: number; lineCount: number; }

function splitLongLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of line) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (current && currentBytes + bytes > MAX_BYTES_PER_FILE_CHUNK) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) parts.push(current);
  return parts;
}

function splitFileIntoChunks(content: string): { chunks: FileChunk[]; lineCount: number } {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: FileChunk[] = [];
  let currentContent = '';
  let currentBytes = 0;
  let currentLineCount = 0;
  let firstLine = 0;
  let lastLine = 0;
  const finishChunk = (): void => {
    if (!currentContent && lines.length > 0) return;
    chunks.push({ content: currentContent, firstLine, lastLine, lineCount: currentLineCount });
    currentContent = '';
    currentBytes = 0;
    currentLineCount = 0;
    firstLine = 0;
    lastLine = 0;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    for (const part of splitLongLine(lines[lineIndex]!)) {
      const partBytes = Buffer.byteLength(part, 'utf8');
      const startsNewLine = lastLine !== lineNumber;
      if (currentContent && (currentBytes + partBytes > MAX_BYTES_PER_FILE_CHUNK
        || (startsNewLine && currentLineCount >= MAX_LINES_PER_FILE_CHUNK))) finishChunk();
      if (!currentContent) firstLine = lineNumber;
      if (lastLine !== lineNumber) currentLineCount += 1;
      lastLine = lineNumber;
      currentContent += part;
      currentBytes += partBytes;
    }
  }
  if (lines.length === 0) chunks.push({ content: '', firstLine: 0, lastLine: 0, lineCount: 0 });
  else finishChunk();
  return { chunks, lineCount: lines.length };
}

function getFileChunk(content: string, index: number): { content: string; total: number; firstLine: number; lastLine: number; lineCount: number } {
  const split = splitFileIntoChunks(content);
  const chunk = split.chunks[index - 1];
  if (chunk === undefined) throw new NovaError('Index de segment de fichier invalide.', 'FILE_CHUNK_INVALID');
  return { ...chunk, total: split.chunks.length, lineCount: split.lineCount };
}

function fileDeliveryMessage(filePath: string, chunkIndex: number, chunkTotal: number, firstLine: number, lastLine: number, lineCount: number): string {
  return `Envoi du segment ${chunkIndex}/${chunkTotal} du fichier ${filePath} (lignes ${firstLine}-${lastLine} sur ${lineCount}, maximum ${MAX_LINES_PER_FILE_CHUNK} lignes et ${MAX_BYTES_PER_FILE_CHUNK} octets par segment). Le contenu de ce segment est dans files. Ne l'analyse pas encore et n'envoie pas de patch. Réponds uniquement avec cet accusé JSON nova-agent/1 : {"protocol":"nova-agent/1","status":"FILE_RECEIVED","receivedFile":"${filePath}","chunkIndex":${chunkIndex}}. Attends le segment suivant ou le message confirmant la fin de tous les fichiers.`;
}

export async function runFix(options: FixOptions): Promise<PersistedSession> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = await loadConfig(projectRoot);
  const session: PersistedSession = options.resumeSession ?? {
    id: id(),
    projectRoot,
    problem: options.problem ?? '',
    providerId: options.providerId ?? config.defaultProvider,
    state: 'IDLE',
    cycle: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exchanges: [],
    requestedFiles: [],
    fileHashes: {},
    transmittedFileHashes: {},
    approvedSensitiveFiles: {},
    fileRequestSignatures: [],
    answers: [],
    contextSent: false,
    generalPromptSent: false,
  };
  if (options.providerId && options.providerId !== session.providerId) {
    session.providerId = options.providerId;
    delete session.providerState;
    session.contextSent = false;
    session.generalPromptSent = false;
    session.transmittedFileHashes = {};
  }
  if (options.resumeSession && session.state === 'DONE') throw new NovaError(`La session ${session.id} est déjà terminée. Lance une nouvelle commande fix pour une autre tâche.`, 'SESSION_ALREADY_DONE');
  if (options.problem?.trim()) session.problem = options.problem;
  if (!session.problem.trim()) throw new NovaError('Description du problème manquante.', 'TASK_DESCRIPTION_REQUIRED');
  if (session.problem.length > 10000) throw new NovaError('La description du problème dépasse la limite locale de 10 000 caractères.', 'TASK_DESCRIPTION_TOO_LARGE');
  const cycleLimit = options.maxCycles === undefined
    ? undefined
    : options.resumeSession
      ? session.cycle + options.maxCycles
      : options.maxCycles;
  const rawContext = await readProjectContext(projectRoot);
  const { tree: rawTree } = await refreshTree(projectRoot);
  const contextPacket = fitContext(rawContext, rawTree, config.protocol.maxContextChars);
  const context = contextPacket.projectContext;
  const tree = contextPacket.tree ?? '';
  if (contextPacket.truncated) console.log(`Contexte limité à ${contextPacket.characters} caractères pour respecter le budget local.`);
  let provider: AIProvider | undefined;
  let outgoingFiles: Array<{ path: string; content: string; sha256: string }> = [];
  let nextMessage = session.pendingMessage ?? (session.cycle === 0
    ? session.problem
    : `Reprise de la tâche ${session.id}. Objectif initial : ${session.problem}. Dernier état local : ${session.state}. Historique des étapes : ${session.exchanges.slice(-8).map((e) => `${e.state}: ${e.detail}`).join('\n')}. Réponses utilisateur enregistrées : ${session.answers.map((answer, index) => `Q${index + 1}: ${answer}`).join(' | ') || '(aucune)'}. Fichiers précédemment transmis : ${Object.entries(session.transmittedFileHashes ?? {}).map(([file, hash]) => `${file} (SHA-256 ${hash})`).join(', ') || '(aucun)'}. Demande de nouveau uniquement les fichiers dont le contenu est nécessaire.`);

  try {
    transition(session, 'ANALYZING_CONTEXT', 'Lecture du contexte projet local et préparation du paquet minimal.');
    await saveSession(session);
    // A previous process may have stopped after preparing a file request. Re-read only those paths
    // through the same security gates; never persist source contents in the session JSON.
    if (session.fileTransferActive && session.fileTransferCurrentPath) {
      const file = await readRequestedFile(projectRoot, session.fileTransferCurrentPath, config.protocol.maxFileSizeBytes, session);
      const expectedHash = session.fileTransferHashes?.[file.path];
      if (expectedHash && file.sha256 !== expectedHash) throw new NovaError(`Le fichier ${file.path} a changé pendant son transfert. Relance la demande pour obtenir un nouvel envoi.`, 'FILE_CHANGED_DURING_TRANSFER');
      const chunkIndex = session.fileTransferChunkIndex ?? 1;
      const chunk = getFileChunk(file.content, chunkIndex);
      session.fileTransferChunkIndex = chunkIndex;
      session.fileTransferChunkTotal = chunk.total;
      session.fileHashes[file.path] = file.sha256;
      outgoingFiles.push({ path: file.path, content: chunk.content, sha256: file.sha256 });
      nextMessage = fileDeliveryMessage(file.path, chunkIndex, chunk.total, chunk.firstLine, chunk.lastLine, chunk.lineCount);
    } else {
      for (const pendingPath of session.pendingFilePaths ?? []) {
        const file = await readRequestedFile(projectRoot, pendingPath, config.protocol.maxFileSizeBytes, session);
        session.fileHashes[file.path] = file.sha256;
        outgoingFiles.push({ path: file.path, content: file.content, sha256: file.sha256 });
      }
    }
    provider = await getProvider(session.providerId, projectRoot);
    provider.restoreState?.(session.providerState);

    while (cycleLimit === undefined || session.cycle < cycleLimit) {
      session.cycle += 1;
      transition(session, 'SENDING_PROMPT', `Envoi de l’échange ${session.cycle} au fournisseur ${session.providerId}.`);
      await saveSession(session);
      const request = {
        taskId: session.id,
        message: nextMessage,
        includeGeneralPrompt: !session.generalPromptSent,
        projectContext: session.contextSent ? '' : context,
        ...(!session.contextSent && tree ? { tree } : {}),
        ...(outgoingFiles.length ? { files: outgoingFiles } : {}),
      };
      session.pendingMessage = nextMessage;
      session.pendingFilePaths = outgoingFiles.map((file) => file.path);
      session.generalPromptSent = true;
      transition(session, 'WAITING_FOR_RESPONSE', `Attente de la réponse ${session.cycle}.`);
      await saveSession(session);
      const deliveredFiles = request.files ?? [];
      outgoingFiles = [];
      const stopThinking = startThinking();
      let response: AIResponse;
      try {
        response = await provider.send(request);
      } finally {
        stopThinking();
      }
      if (session.fileTransferActive) {
        if (session.fileTransferChunkIndex === 1) for (const file of deliveredFiles) renderEvent('read', file.path);
      } else {
        for (const file of deliveredFiles) renderEvent('read', file.path);
      }
      session.transmittedFileHashes = session.transmittedFileHashes ?? {};
      if (!session.fileTransferActive) {
        for (const file of request.files ?? []) session.transmittedFileHashes[file.path] = file.sha256;
      }
      delete session.pendingFilePaths;
      delete session.pendingMessage;
      const providerState = provider.getState?.() ?? session.providerState;
      if (providerState) session.providerState = providerState;
      else delete session.providerState;
      session.contextSent = true;
      transition(session, 'PARSING_RESPONSE', `Réponse reçue : ${response.status}.`);
      await saveSession(session);

      if (session.fileTransferActive) {
        const currentPath = session.fileTransferCurrentPath;
        const expectedChunkIndex = session.fileTransferChunkIndex ?? 1;
        if (response.status !== 'FILE_RECEIVED' || !currentPath || response.receivedFile !== currentPath || response.chunkIndex !== expectedChunkIndex) {
          throw new NovaError(`Accusé de réception invalide : Nova attendait FILE_RECEIVED pour ${currentPath ?? 'le fichier courant'}.`, 'FILE_TRANSFER_ACK_INVALID');
        }
        const currentFile = await readRequestedFile(projectRoot, currentPath, config.protocol.maxFileSizeBytes, session);
        const expectedCurrentHash = session.fileTransferHashes?.[currentFile.path];
        if (expectedCurrentHash && currentFile.sha256 !== expectedCurrentHash) throw new NovaError(`Le fichier ${currentFile.path} a changé pendant son transfert. Relance la demande pour obtenir un nouvel envoi.`, 'FILE_CHANGED_DURING_TRANSFER');
        const currentChunk = getFileChunk(currentFile.content, expectedChunkIndex);
        if (expectedChunkIndex === currentChunk.total) session.transmittedFileHashes[currentFile.path] = currentFile.sha256;
        if (expectedChunkIndex < currentChunk.total) {
          const nextChunkIndex = expectedChunkIndex + 1;
          const nextChunk = getFileChunk(currentFile.content, nextChunkIndex);
          session.fileTransferChunkIndex = nextChunkIndex;
          session.fileTransferChunkTotal = nextChunk.total;
          session.fileHashes[currentFile.path] = currentFile.sha256;
          outgoingFiles = [{ path: currentFile.path, content: nextChunk.content, sha256: currentFile.sha256 }];
          nextMessage = fileDeliveryMessage(currentFile.path, nextChunkIndex, nextChunk.total, nextChunk.firstLine, nextChunk.lastLine, nextChunk.lineCount);
          transition(session, 'READING_FILES', `Accusé reçu ; préparation du segment ${nextChunkIndex}/${nextChunk.total} de ${currentFile.path}.`);
          session.pendingFilePaths = [currentFile.path];
          session.pendingMessage = nextMessage;
          await saveSession(session);
        } else {
          const nextPath = session.fileTransferQueue?.[0];
          if (nextPath) {
            const file = await readRequestedFile(projectRoot, nextPath, config.protocol.maxFileSizeBytes, session);
            const expectedHash = session.fileTransferHashes?.[file.path];
            if (expectedHash && file.sha256 !== expectedHash) throw new NovaError(`Le fichier ${file.path} a changé pendant son transfert. Relance la demande pour obtenir un nouvel envoi.`, 'FILE_CHANGED_DURING_TRANSFER');
            const chunk = getFileChunk(file.content, 1);
            session.fileTransferQueue?.shift();
            session.fileTransferCurrentPath = file.path;
            session.fileTransferChunkIndex = 1;
            session.fileTransferChunkTotal = chunk.total;
            session.fileHashes[file.path] = file.sha256;
            outgoingFiles = [{ path: file.path, content: chunk.content, sha256: file.sha256 }];
            nextMessage = fileDeliveryMessage(file.path, 1, chunk.total, chunk.firstLine, chunk.lastLine, chunk.lineCount);
            transition(session, 'READING_FILES', `Accusé reçu ; préparation du premier segment de ${file.path}.`);
            session.pendingFilePaths = [file.path];
            session.pendingMessage = nextMessage;
            await saveSession(session);
          } else {
            session.fileTransferActive = false;
            delete session.fileTransferCurrentPath;
            delete session.fileTransferChunkIndex;
            delete session.fileTransferChunkTotal;
            delete session.fileTransferQueue;
            delete session.fileTransferHashes;
            delete session.fileTransferTotal;
            outgoingFiles = [];
            nextMessage = `Tous les fichiers demandés ont été envoyés segment par segment et accusés réception. ${session.fileTransferSummary ?? ''}\nTu peux maintenant analyser la tâche. Si un fichier supplémentaire est indispensable, utilise NEED_FILES. Réponse uniquement JSON nova-agent/1.`;
            delete session.fileTransferSummary;
            transition(session, 'ANALYZING_CONTEXT', 'Tous les fichiers demandés ont été transmis et accusés réception.');
            session.pendingFilePaths = [];
            session.pendingMessage = nextMessage;
            await saveSession(session);
          }
        }
        continue;
      }
      if (response.status === 'FILE_RECEIVED') {
        throw new NovaError('Accusé FILE_RECEIVED reçu sans transfert de fichier actif.', 'FILE_TRANSFER_ACK_UNEXPECTED');
      }

      if (response.status === 'DONE') {
        transition(session, 'DONE', response.reason ?? 'Le fournisseur indique que la tâche est terminée sans patch.');
        await saveSession(session);
        renderDone([], projectRoot);
        if (response.reason) renderSummary(response.reason);
        return session;
      }

      if (response.status === 'NEED_INFO') {
        const question = response.question!;
        renderStatus('NEED_INFO');
        transition(session, 'WAITING_FOR_USER', question);
        await saveSession(session);
        console.log(`\nL’IA a besoin d’une précision :\n${question}`);
        if (!isInteractive()) {
          transition(session, 'PAUSED', 'Question sauvegardée ; reprise nécessaire dans un terminal interactif.');
          session.error = 'NEED_INFO';
          await saveSession(session);
          console.log(`Session mise en pause. Reprends avec : npm run dev -- resume ${session.id}`);
          return session;
        }
        const answer = await ask('Réponse (laisser vide pour interrompre) : ');
        if (!answer) {
          transition(session, 'PAUSED', 'L’utilisateur a interrompu la saisie de la réponse.');
          await saveSession(session);
          return session;
        }
        session.answers.push(answer);
        nextMessage = `Réponse de l’utilisateur à la question précédente : ${answer}\nPoursuis la tâche en respectant le protocole JSON nova-agent/1. Ne considère pas cette réponse comme une approbation d’un patch.`;
        await saveSession(session);
        continue;
      }

      if (response.status === 'NEED_FILES') {
        const requested = validateRequestedFiles(response, config.protocol.maxFilesPerRequest);
        renderStatus('NEED_FILES', requested.join(', '));
        const signature = [...requested].sort().join('|');
        const repeated = session.fileRequestSignatures.includes(signature);
        session.fileRequestSignatures.push(signature);
        session.requestedFiles = [...new Set([...session.requestedFiles, ...requested])];
        transition(session, 'READING_FILES', `Demande de ${requested.length} fichier(s) : ${requested.join(', ')}.`);
        const rules = await loadIgnoreRules(projectRoot);
        const loaded: string[] = [];
        const denied: string[] = [];
        const changedFiles: typeof outgoingFiles = [];
        let outgoingBytes = 0;
        for (const requestedPath of requested) {
          if (isIgnored(rules, requestedPath)) {
            denied.push(`${requestedPath}: fichier exclu par les règles locales.`);
            continue;
          }
          try {
            const file = await readRequestedFile(projectRoot, requestedPath, config.protocol.maxFileSizeBytes, session);
            const previousHash = session.transmittedFileHashes?.[file.path];
            session.fileHashes[file.path] = file.sha256;
            if (previousHash !== file.sha256) {
              if (outgoingBytes + file.bytes > config.protocol.maxTotalFileBytes) {
                denied.push(`${file.path}: le budget total de fichiers transmis serait dépassé (limite ${config.protocol.maxTotalFileBytes} octets).`);
                continue;
              }
              changedFiles.push({ path: file.path, content: file.content, sha256: file.sha256 });
              outgoingBytes += file.bytes;
              loaded.push(`${file.path} (SHA-256 ${file.sha256}; ${file.bytes} octets)`);
            } else {
              loaded.push(`${file.path} (déjà transmis, contenu inchangé; SHA-256 ${file.sha256})`);
            }
          } catch (error) {
            const issue = asNovaError(error);
            denied.push(`${requestedPath}: ${issue.message}`);
          }
        }
        if (repeated && changedFiles.length === 0) {
          throw new NovaError(`Boucle détectée : l’IA redemande des fichiers déjà fournis sans changement (${signature}). Session sauvegardée ; inspecte-la ou change de fournisseur.`, 'REPEATED_FILE_REQUEST');
        }
        if (changedFiles.length > 0) {
          const firstFile = changedFiles[0];
          if (!firstFile) throw new NovaError('La file de transfert est vide malgré une demande de fichiers.', 'FILE_TRANSFER_EMPTY');
          const remainingFiles = changedFiles.slice(1);
          const firstChunk = getFileChunk(firstFile.content, 1);
          outgoingFiles = [{ path: firstFile.path, content: firstChunk.content, sha256: firstFile.sha256 }];
          session.fileTransferActive = true;
          session.fileTransferCurrentPath = firstFile.path;
          session.fileTransferChunkIndex = 1;
          session.fileTransferChunkTotal = firstChunk.total;
          session.fileTransferQueue = remainingFiles.map((file) => file.path);
          session.fileTransferHashes = Object.fromEntries(changedFiles.map((file) => [file.path, file.sha256]));
          session.fileTransferTotal = changedFiles.length;
          session.fileTransferSummary = `Fichiers disponibles : ${loaded.join('\n') || '(aucun)'}. Demandes refusées ou fichiers absents : ${denied.join('\n') || '(aucun)'}.`;
          nextMessage = fileDeliveryMessage(firstFile.path, 1, firstChunk.total, firstChunk.firstLine, firstChunk.lastLine, firstChunk.lineCount);
        } else {
          outgoingFiles = [];
          session.fileTransferActive = false;
          nextMessage = `Résultat de NEED_FILES. Fichiers transmis ou déjà connus :\n${loaded.length ? loaded.join('\n') : '(aucun)'}\nDemandes refusées ou fichiers absents :\n${denied.length ? denied.join('\n') : '(aucun)'}\nPoursuis le diagnostic. Si une information manque encore, utilise NEED_INFO. Ne propose PATCH_READY que si tu as assez de contexte et un diff unifié applicable. Réponse uniquement JSON nova-agent/1.`;
        }
        if (denied.length) renderStatus('files unavailable', denied.join(' ; '));
        // Save the retry metadata before the next browser call, but never store file contents.
        session.pendingFilePaths = outgoingFiles.map((file) => file.path);
        session.pendingMessage = nextMessage;
        await saveSession(session);
        continue;
      }

      if (response.status === 'PATCH_READY') {
        renderStatus('PATCH_READY', 'diff préparé');
        transition(session, 'VALIDATING_PATCH', 'Validation du patch, des chemins et des empreintes d’origine.');
        const prepared = await validatePatch(projectRoot, response.patch!, session.fileHashes, config.patches.maxPatchBytes);
        if (prepared.files.length === 0) throw new NovaError('Le patch ne contient aucun fichier modifiable.', 'PATCH_EMPTY');
        const operationId = id();
        const storedPatch = await prepareAndStorePatch(projectRoot, response.patch!, session.fileHashes, config.patches.maxPatchBytes, operationId);
        const patchRelativePath = storedPatch.relativePath;
        const record: OperationRecord = {
          id: operationId,
          task: session.problem,
          status: 'PREPARED',
          date: new Date().toISOString(),
          provider: session.providerId,
          context: `Session ${session.id}; ${session.exchanges.slice(-5).map((item) => `${item.state}: ${item.detail}`).join(' | ')}`,
          filesRequested: [...session.requestedFiles],
          filesChanged: prepared.files.map((file) => file.path),
          summary: response.summary!,
          originalHashes: prepared.originalHashes,
          patchPath: patchRelativePath,
          unifiedDiff: response.patch!,
          tests: (response.tests ?? []).map((test: string) => ({ command: test, result: 'SUGGÉRÉ — non exécuté automatiquement' })),
          errors: [],
        };
        session.pendingOperationId = operationId;
        transition(session, 'PREVIEWING_DIFF', 'Patch enregistré et prêt pour prévisualisation.');
        const reportPath = await saveReport(projectRoot, record);
        await upsertOperation(projectRoot, record);
        await saveSession(session);
        renderSummary(record.summary);
        console.log(`\n${renderPatchPreview(projectRoot, prepared.files, response.patch!, reportPath)}\n`);

        if (options.dryRun || options.noApply) {
          renderStatus('PATCH_READY', `préparé sans application · ${patchRelativePath}`);
          transition(session, 'DONE', options.dryRun ? 'Fin dry-run : aucune source modifiée.' : 'Patch préparé mais non appliqué.');
          await saveSession(session);
          renderDone([reportPath], projectRoot);
          return session;
        }
        transition(session, 'WAITING_FOR_APPROVAL', 'Attente de la confirmation explicite de l’utilisateur.');
        await saveSession(session);
        if (!isInteractive()) {
          transition(session, 'PAUSED', 'Patch préparé ; confirmation interactive requise avant application.');
          await saveSession(session);
          console.log(`Patch en attente d’approbation. Applique-le avec : npm run dev -- apply --project \"${projectRoot}\"`);
          return session;
        }
        if (!await approveOrReject('Appliquer ce patch ?')) {
          record.status = 'REJECTED';
          record.errors.push('Patch explicitement refusé par l’utilisateur ; les fichiers source ne sont pas modifiés.');
          await saveReport(projectRoot, record);
          await upsertOperation(projectRoot, record);
          transition(session, 'DONE', 'Patch rejeté ; aucune source modifiée.');
          await saveSession(session);
          renderStatus('REJECTED', 'aucun fichier source modifié');
          renderDone([reportPath], projectRoot);
          return session;
        }
        transition(session, 'APPLYING_PATCH', 'L’utilisateur a accepté le patch. Revalidation avant application.');
        await saveSession(session);
        await applyOperation(projectRoot, record, response.patch, async (stage) => {
          transition(session, stage, stage === 'RUNNING_TESTS' ? 'Exécution des tests explicitement configurés.' : 'Enregistrement de l’historique auxiliaire et du rapport.');
          await saveSession(session);
        });
        for (const file of prepared.files) renderEvent('write', file.path);
        await saveSession(session);
        transition(session, 'DONE', 'Correction terminée.');
        await saveSession(session);
        renderDone([reportPath], projectRoot);
        return session;
      }
    }
    transition(session, 'PAUSED', `Limite facultative de cycles atteinte (${cycleLimit}).`);
    session.error = 'MAX_CYCLES_REACHED';
    await saveSession(session);
    console.log(`Limite facultative de cycles atteinte. Reprends avec : npm run dev -- resume ${session.id}`);
    return session;
  } catch (error) {
    const issue = asNovaError(error);
    session.error = `${issue.code}: ${issue.message}`;
    transition(session, 'ERROR', session.error);
    await saveSession(session).catch(() => undefined);
    throw issue;
  } finally {
    if (provider) {
      const providerState = provider.getState?.() ?? session.providerState;
      if (providerState) session.providerState = providerState;
      else delete session.providerState;
      await saveSession(session).catch(() => undefined);
      await provider.close().catch(() => undefined);
    }
  }
}
