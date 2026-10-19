const $ = id => document.getElementById(id);
const state = {
  projectRoot: null, files: [], sessionId: null, running: false, waitingForResponse: false, pendingPatch: null,
  selectedFile: null, diffTab: 'changes', changes: new Map(), expandedFolders: new Set(), treeInitialized: false,
};
const icons = { ts:'TS',tsx:'TS',js:'JS',jsx:'JS',json:'{}',md:'M',css:'#',html:'<>',py:'Py',java:'J',sql:'DB',yml:'Y',yaml:'Y',lock:'L' };

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  setTimeout(() => $('toast').classList.add('hidden'), 4200);
}
function setStatus(text, running = state.running) {
  $('status-text').textContent = text;
  $('send-task').disabled = running || !state.projectRoot;
  $('new-chat').disabled = running;
  $('send-task').innerHTML = running ? 'Nova travaille <span class="spinner"></span>' : 'Envoyer <span>↑</span>';
  $('steer-task').classList.toggle('hidden', !running);
  $('steer-task').disabled = !running || !state.sessionId;
  $('stop-task').classList.toggle('hidden', !running || !state.waitingForResponse);
  $('task-input').placeholder = running ? 'Ajoutez une consigne à la tâche en cours…' : 'Demandez à Nova de modifier votre projet… Tapez /init avant la demande pour renvoyer le prompt initial.';
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function ext(filePath) { return filePath.split('.').pop().toLowerCase(); }

function renderTree(files) {
  state.files = files || [];
  const root = {};
  for (const entry of state.files) {
    const parts = entry.path.replaceAll('\\', '/').split('/').filter(Boolean);
    let cursor = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      cursor[name] ??= { __children: {}, __path: parts.slice(0, index + 1).join('/'), __type: index === parts.length - 1 ? entry.type : 'directory' };
      cursor = cursor[name].__children;
    }
  }
  if (!state.treeInitialized) {
    for (const entry of Object.values(root)) if (entry.__type === 'directory') state.expandedFolders.add(entry.__path);
    state.treeInitialized = true;
  }

  const draw = (node, depth = 0) => Object.keys(node).sort((a, b) => {
    const aDir = node[a].__type === 'directory';
    const bDir = node[b].__type === 'directory';
    return aDir !== bDir ? (aDir ? -1 : 1) : a.localeCompare(b);
  }).map(name => {
    const item = node[name];
    const isDirectory = item.__type === 'directory';
    const isOpen = isDirectory && state.expandedFolders.has(item.__path);
    const icon = isDirectory ? (isOpen ? '▾' : '▸') : (icons[ext(name)] || '·');
    const button = `<button class="tree-item ${isDirectory ? 'folder' : 'file'}" style="--depth:${depth}" data-path="${esc(item.__path)}" data-type="${isDirectory ? 'directory' : 'file'}" ${isDirectory ? `aria-expanded="${isOpen}"` : ''}><span class="tree-icon">${icon}</span><span class="tree-name">${esc(name)}</span>${state.changes.has(item.__path) ? '<span class="modified-mark" title="Modifié">M</span>' : ''}</button>`;
    if (!isDirectory) return button;
    return `${button}<div class="tree-children ${isOpen ? '' : 'hidden'}">${draw(item.__children, depth + 1)}</div>`;
  }).join('');

  $('file-tree').innerHTML = Object.keys(root).length
    ? `<div role="tree">${draw(root)}</div>`
    : '<div class="empty-tree">Aucun fichier visible dans ce projet.</div>';
  $('file-tree').querySelectorAll('.tree-item').forEach(button => button.addEventListener('click', () => {
    const filePath = button.dataset.path;
    if (button.dataset.type === 'directory') {
      if (state.expandedFolders.has(filePath)) state.expandedFolders.delete(filePath);
      else state.expandedFolders.add(filePath);
      renderTree(state.files);
      return;
    }
    state.selectedFile = filePath;
    if (state.changes.has(filePath)) showDiff(filePath);
  }));
}

function addMessage(role, title, body, { expandable = false } = {}) {
  $('welcome').classList.add('hidden');
  const message = document.createElement('article');
  message.className = `message ${role}`;
  const avatar = role === 'user' ? '' : '<div class="message-avatar" aria-hidden="true">N</div>';
  const heading = title ? `<div class="message-title">${esc(title)}</div>` : '';
  const fullBody = String(body ?? '');
  const collapsed = expandable && fullBody.length > 700;
  const displayedBody = collapsed ? `${fullBody.slice(0, 700).trimEnd()}…` : fullBody;
  message.innerHTML = `${avatar}<div class="message-content">${heading}<div class="message-body">${esc(displayedBody).replace(/\n/g, '<br>')}</div></div>`;
  if (collapsed) {
    const expandButton = document.createElement('button');
    expandButton.className = 'message-expand';
    expandButton.type = 'button';
    expandButton.textContent = 'Développer';
    expandButton.setAttribute('aria-expanded', 'false');
    expandButton.addEventListener('click', () => {
      const expanded = expandButton.getAttribute('aria-expanded') === 'true';
      message.querySelector('.message-body').innerHTML = esc(expanded ? `${fullBody.slice(0, 700).trimEnd()}…` : fullBody).replace(/\n/g, '<br>');
      expandButton.textContent = expanded ? 'Développer' : 'Réduire';
      expandButton.setAttribute('aria-expanded', String(!expanded));
    });
    message.querySelector('.message-content').append(expandButton);
  }
  $('conversation').append(message);
  $('conversation').scrollTop = $('conversation').scrollHeight;
  return message;
}

function addActivity(text) {
  const conversation = $('conversation');
  const previous = conversation.lastElementChild;
  if (previous?.classList.contains('activity') && previous.dataset.activity === text) return;
  const row = document.createElement('div');
  row.className = 'activity';
  row.dataset.activity = text;
  row.innerHTML = `<span class="activity-dot" aria-hidden="true"></span><span>${esc(text)}</span>`;
  conversation.append(row);
  conversation.scrollTop = conversation.scrollHeight;
}

function setFiles(files) { state.files = files || []; renderTree(state.files); }
function resetAgentChat() {
  state.sessionId = null;
  state.running = false;
  state.waitingForResponse = false;
  state.pendingPatch = null;
  state.selectedFile = null;
  state.changes.clear();
  $('conversation').replaceChildren();
  $('welcome').classList.remove('hidden');
  $('session-info').textContent = 'Nouvelle conversation';
  $('task-input').value = '';
  $('approval-panel').replaceChildren();
  $('approval-panel').classList.add('hidden');
  $('diff-count').textContent = '0';
  $('change-list').innerHTML = '<div class="diff-empty"><div class="diff-empty-icon">⇄</div><strong>Aucun changement pour le moment</strong><p>Les fichiers modifiés par Nova apparaîtront ici avec leur diff avant/après.</p></div>';
  $('diff-view').innerHTML = '<div class="diff-empty"><div class="diff-empty-icon">⌁</div><strong>Le diff apparaîtra ici</strong><p>Lance une tâche et sélectionne un fichier modifié.</p></div>';
  $('change-list').classList.remove('hidden');
  $('diff-view').classList.add('hidden');
  document.querySelectorAll('.diff-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.diffTab === 'changes'));
  state.diffTab = 'changes';
  renderTree(state.files);
  setStatus(state.projectRoot ? 'Nouveau chat' : 'En attente', false);
}
function updateChange(filePath, detail = {}) {
  const old = state.changes.get(filePath) || {};
  state.changes.set(filePath, { ...old, ...detail, path: filePath });
  $('diff-count').textContent = String(state.changes.size);
  $('change-list').innerHTML = [...state.changes.values()].map(item => `<button class="change-item ${state.selectedFile === item.path ? 'selected' : ''}" data-change-path="${esc(item.path)}"><span class="file-type">${esc(icons[ext(item.path)] || '·')}</span><span class="change-meta"><strong>${esc(item.path.split('/').pop())}</strong><small>${esc(item.path)}</small></span><span class="change-stats"><i>+${item.additions || 0}</i> <b>−${item.deletions || 0}</b></span></button>`).join('') || '<div class="diff-empty"><strong>Aucun changement</strong><p>Les modifications apparaîtront ici.</p></div>';
  $('change-list').querySelectorAll('[data-change-path]').forEach(button => button.addEventListener('click', () => showDiff(button.dataset.changePath)));
  $('apply-changes').disabled = !state.pendingPatch;
  renderTree(state.files);
}
function renderDiff(diff) {
  return esc(diff).split('\n').map(line => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : line.startsWith('@@') ? 'hunk' : '';
    return `<span class="diff-line ${cls}">${line || ' '}</span>`;
  }).join('');
}
function showDiff(filePath) {
  state.selectedFile = filePath;
  const item = state.changes.get(filePath);
  if (!item) return;
  $('diff-view').innerHTML = `<div class="diff-file-title"><div><strong>${esc(filePath.split('/').pop())}</strong><small>${esc(filePath)}</small></div></div><pre class="diff-code">${renderDiff(item.diff || state.pendingPatch?.diff || 'Diff détaillé indisponible.')}</pre>`;
  document.querySelectorAll('.diff-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.diffTab === 'diff'));
  $('change-list').classList.add('hidden');
  $('diff-view').classList.remove('hidden');
  state.diffTab = 'diff';
}

function showApproval(payload) {
  const { id, request } = payload;
  const isPatch = request.kind === 'patch';
  const title = isPatch ? 'Patch prêt à examiner' : request.kind === 'command' ? 'Autorisation de commande' : 'Fichier sensible';
  const detail = isPatch ? request.summary : request.kind === 'command' ? `${request.command}\n${request.reason || ''}\n${request.cwd || ''}` : `${request.path}\n${request.reason || ''}`;
  $('approval-panel').innerHTML = `<div class="approval-title"><span class="approval-icon">${isPatch ? 'Δ' : '!'}</span><div><strong>${title}</strong><small>${esc(detail)}</small></div></div><div class="approval-actions"><button class="reject-button" data-decision="reject">Refuser</button><button class="approve-button" data-decision="approve">${isPatch ? 'Approuver le patch' : 'Approuver'}</button>${request.kind === 'command' ? '<button class="approve-session-button" data-decision="approve-session">Approuver les commandes suivantes</button>' : ''}</div>`;
  $('approval-panel').classList.remove('hidden');
  if (isPatch) {
    state.pendingPatch = request;
    for (const file of request.files || []) updateChange(file.path, { ...file, diff: request.diff });
    if (!request.files?.length) updateChange('Patch Nova', { diff: request.diff });
    $('apply-changes').disabled = false;
  }
  $('approval-panel').querySelectorAll('[data-decision]').forEach(button => button.addEventListener('click', async () => {
    try {
      await window.novaDesktop.decideApproval({ id, decision: button.dataset.decision });
      $('approval-panel').classList.add('hidden');
      toast(button.dataset.decision === 'reject' ? 'Action refusée.' : 'Décision transmise à Nova.');
    } catch (error) { toast(error.message); }
  }));
}

window.novaDesktop.onApprovalRequest(showApproval);
window.novaDesktop.onQuestion(({ id, question }) => {
  const panel = $('approval-panel');
  panel.innerHTML = `<div class="approval-title"><span class="approval-icon">?</span><div><strong>Nova a une question</strong><small>${esc(question)}</small></div></div><form id="answer-form"><input id="answer-input" placeholder="Votre réponse…" maxlength="10000" required><button class="approve-button">Envoyer</button></form>`;
  panel.classList.remove('hidden');
  $('answer-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await window.novaDesktop.answerQuestion({ id, answer: $('answer-input').value }); panel.classList.add('hidden'); }
    catch (error) { toast(error.message); }
  });
});

window.novaDesktop.onEvent(event => {
  if (event.type === 'session') {
    state.sessionId = event.session.id;
    $('session-info').textContent = event.session.id;
    $('steer-task').disabled = !state.running;
  }
  if (event.type === 'status') {
    state.waitingForResponse = event.state === 'WAITING_FOR_RESPONSE';
    if (event.state === 'WAITING_FOR_RESPONSE') { setStatus('Thinking', state.running); addActivity('Thinking'); }
    else if (event.state === 'DONE') setStatus('Terminé', false);
    else if (event.state === 'WAITING_FOR_APPROVAL') setStatus('Autorisation requise', state.running);
    else if (event.state === 'WAITING_FOR_USER') setStatus('Question en attente', state.running);
    else if (event.state === 'ERROR') setStatus('Erreur', false);
  }
  if (event.type === 'activity') { addActivity(event.text); setStatus(event.text, state.running); }
  if (event.type === 'read') { addActivity(`Read ${event.path}`); setStatus(`Read ${event.path}`, state.running); }
  if (event.type === 'write') { addActivity(`Write ${event.path}`); setStatus(`Write ${event.path}`, state.running); renderTree(state.files); }
  if (event.type === 'summary') addMessage('assistant', 'Nova', event.text, { expandable: true });
  if (event.type === 'patch-ready') {
    state.pendingPatch = event;
    for (const file of event.files || []) updateChange(file.path, { ...file, diff: event.diff });
    if (!event.files?.length) updateChange('Patch Nova', { diff: event.diff });
    $('diff-view').innerHTML = `<div class="diff-summary"><strong>Patch préparé</strong><p>${esc(event.summary)}</p><pre class="diff-code">${renderDiff(event.diff)}</pre></div>`;
    $('apply-changes').disabled = false;
    document.querySelector('[data-diff-tab="diff"]').click();
  }
  if (event.type === 'error') { addMessage('error', 'Erreur Nova', event.message); toast(event.message); }
  if (event.type === 'completed') {
    state.running = false;
    $('session-info').textContent = event.sessionId;
    state.sessionId = event.sessionId;
    setStatus(event.state === 'DONE' ? 'Terminé' : 'En pause', false);
    toast(event.state === 'DONE' ? (state.pendingPatch ? 'Tâche terminée. Vérifiez le diff.' : 'Tâche terminée.') : 'Session enregistrée.');
  }
});

window.novaDesktop.onInstallProgress(({ state: status, message }) => {
  $('install-state').textContent = message;
  if (status === 'error') toast(message);
});
window.novaDesktop.onUpdateStatus(async update => {
  if (update.state === 'available' && confirm(`Une nouvelle version de Nova Agent (${update.version}) est disponible. La télécharger ?`)) {
    try { await window.novaDesktop.downloadUpdate(); toast('Téléchargement de la mise à jour…'); }
    catch (error) { toast(`Mise à jour impossible : ${error.message}`); }
  } else if (update.state === 'downloading') $('install-state').textContent = `Mise à jour : ${update.percent}%`;
  else if (update.state === 'downloaded') {
    $('install-state').textContent = 'Mise à jour prête';
    if (confirm(`La mise à jour ${update.version} est téléchargée. Redémarrer Nova pour l’installer ?`)) await window.novaDesktop.installUpdate();
  } else if (update.state === 'current') $('install-state').textContent = `À jour · ${update.version}`;
  else if (update.state === 'error' || update.state === 'unavailable') $('install-state').textContent = 'Mise à jour indisponible';
});

async function openProject() {
  try {
    const result = await window.novaDesktop.pickProject();
    if (!result) return;
    state.projectRoot = result.projectRoot;
    state.expandedFolders.clear();
    state.treeInitialized = false;
    $('project-label').textContent = result.projectRoot;
    $('project-name').textContent = result.projectRoot.split(/[\\/]/).pop();
    $('provider').value = result.providerId;
    setFiles(result.files);
    setStatus('Projet prêt', false);
    $('task-input').focus();
  } catch (error) { toast(error.message); }
}

$('open-project').addEventListener('click', openProject);
$('open-project-sidebar').addEventListener('click', openProject);
$('new-chat').addEventListener('click', async () => {
  if (state.running) return;
  const button = $('new-chat');
  button.disabled = true;
  try {
    await window.novaDesktop.newChat({ projectRoot: state.projectRoot, providerId: $('provider').value });
    resetAgentChat();
    toast('Nouveau chat prêt dans Nova et chez le fournisseur IA.');
    $('task-input').focus();
  } catch (error) {
    toast(`Impossible de démarrer un nouveau chat : ${error.message}`);
  } finally {
    button.disabled = state.running;
  }
});
$('refresh-tree').addEventListener('click', async () => {
  if (!state.projectRoot) return;
  try { const result = await window.novaDesktop.refreshTree(state.projectRoot); setFiles(result.files); toast('Arborescence actualisée.'); }
  catch (error) { toast(error.message); }
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const problem = $('task-input').value.trim();
  if (!problem) return;
  if (!state.projectRoot) { toast('Ouvrez un dossier de projet avant de démarrer.'); return; }
  if (state.running) return;
  addMessage('user', '', problem);
  $('task-input').value = '';
  state.running = true;
  state.waitingForResponse = false;
  $('stop-task').disabled = false;
  $('stop-task').textContent = 'Arrêter';
  setStatus('Préparation', true);
  try {
    const result = await window.novaDesktop.runTask({ projectRoot: state.projectRoot, problem, providerId: $('provider').value });
    state.sessionId = result.sessionId;
    $('session-info').textContent = result.sessionId;
    if (result.state === 'DONE') { state.running = false; setStatus('Terminé', false); }
  } catch (error) {
    state.running = false;
    setStatus('Erreur', false);
    addMessage('error', 'Erreur Nova', error.message);
    toast(error.message);
  }
});
$('steer-task').addEventListener('click', async () => {
  const message = $('task-input').value.trim();
  if (!message || !state.sessionId) return;
  try {
    await window.novaDesktop.steerTask({ message });
    $('task-input').value = '';
    addMessage('user', 'Consigne ajoutée', message);
    toast('Consigne transmise à Nova.');
  } catch (error) { toast(error.message); }
});
$('stop-task').addEventListener('click', async () => {
  try {
    await window.novaDesktop.stopTask();
    $('stop-task').disabled = true;
    $('stop-task').textContent = 'Arrêt…';
    setStatus('Arrêt en cours', true);
  } catch (error) { toast(error.message); }
});
$('task-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (state.running) $('steer-task').click();
    else $('composer').requestSubmit();
  }
});
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => {
  $('task-input').value = button.dataset.prompt;
  $('task-input').focus();
}));
document.querySelectorAll('.diff-tab').forEach(button => button.addEventListener('click', () => {
  state.diffTab = button.dataset.diffTab;
  document.querySelectorAll('.diff-tab').forEach(tab => tab.classList.toggle('active', tab === button));
  $('change-list').classList.toggle('hidden', state.diffTab !== 'changes');
  $('diff-view').classList.toggle('hidden', state.diffTab !== 'diff');
}));
$('apply-changes').addEventListener('click', () => {
  if (!state.pendingPatch) { toast('Aucun patch à approuver.'); return; }
  $('approval-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if ($('approval-panel').classList.contains('hidden')) toast('La demande d’approbation apparaîtra ici.');
});
$('settings').addEventListener('click', async () => {
  const info = await window.novaDesktop.appInfo();
  $('version-info').textContent = `Desktop ${info.appVersion} · Nova Core ${info.novaVersion}`;
  $('info-dialog').showModal();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); openProject(); }
});
window.novaDesktop.appInfo().then(info => {
  $('version-info').textContent = `Desktop ${info.appVersion} · Nova Core ${info.novaVersion}`;
}).catch(() => {});
setStatus('En attente', false);
