const $ = id => document.getElementById(id);
const state = { projectRoot: null, files: [], sessionId: null, running: false, pendingPatch: null, selectedFile: null, diffTab: 'changes', changes: new Map() };
const icons = { ts:'TS',tsx:'⚛',js:'JS',jsx:'⚛',json:'{}',md:'M',css:'#',html:'<>',py:'Py',java:'J',sql:'DB',yml:'Y',yaml:'Y',lock:'L' };
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); setTimeout(() => $('toast').classList.add('hidden'), 4200); }
function setStatus(text, running = state.running) { $('status-text').textContent = text; $('send-task').disabled = running || !state.projectRoot; $('send-task').innerHTML = running ? 'Nova travaille <span class="spinner"></span>' : 'Lancer la tâche <span>↑</span>'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function ext(path) { return path.split('.').pop().toLowerCase(); }
function renderTree(files) {
  state.files = files || [];
  const root = {};
  for (const item of state.files) {
    const parts = item.path.replaceAll('\\','/').split('/').filter(Boolean); let cursor = root;
    for (let i=0;i<parts.length;i++) { cursor[parts[i]] ||= { __children: {}, __path: parts.slice(0,i+1).join('/'), __type: i === parts.length-1 ? item.type : 'directory' }; cursor = cursor[parts[i]].__children; }
  }
  const draw = (node, depth=0) => Object.keys(node).sort((a,b) => { const ad = node[a].__type === 'directory', bd = node[b].__type === 'directory'; return ad !== bd ? (ad ? -1 : 1) : a.localeCompare(b); }).map(name => {
    const item=node[name], dir=item.__type==='directory', opened=depth<1, icon=dir?(opened?'▾':'▸'):(icons[ext(name)]||'·');
    return `<div class="tree-item ${dir?'folder':'file'}" style="--depth:${depth}" data-path="${esc(item.__path)}" data-type="${dir?'directory':'file'}"><span class="tree-icon">${icon}</span><span class="tree-name">${esc(name)}</span>${state.changes.has(item.__path)?'<span class="modified-mark">M</span>':''}</div>${dir&&opened?draw(item.__children,depth+1):''}`;
  }).join('');
  $('file-tree').innerHTML = Object.keys(root).length ? draw(root) : '<div class="empty-tree">Aucun fichier visible dans le tree Nova.</div>';
  $('file-tree').querySelectorAll('.tree-item').forEach(el => el.addEventListener('click', () => {
    if (el.dataset.type === 'directory') { el.classList.toggle('folder-collapsed'); el.querySelector('.tree-icon').textContent = el.classList.contains('folder-collapsed')?'▸':'▾'; let next=el.nextElementSibling; while(next && Number(next.style.getPropertyValue('--depth')) > Number(el.style.getPropertyValue('--depth'))) { next.classList.toggle('hidden',el.classList.contains('folder-collapsed')); next=next.nextElementSibling; } }
    else { state.selectedFile=el.dataset.path; if(state.changes.has(state.selectedFile)) showDiff(state.selectedFile); }
  }));
}
function addMessage(role, title, body) {
  $('welcome').classList.add('hidden');
  const el=document.createElement('article'); el.className=`message ${role}`;
  el.innerHTML=`<div class="message-avatar">${role==='assistant'?'✳':'Y'}</div><div class="message-content"><div class="message-title">${esc(title)}</div><div class="message-body">${esc(body).replace(/\n/g,'<br>')}</div></div>`;
  $('conversation').append(el); $('conversation').scrollTop=$('conversation').scrollHeight; return el;
}
function setFiles(files) { state.files=files||[]; renderTree(state.files); }
function updateChange(path, detail={}) {
  const old=state.changes.get(path)||{}; state.changes.set(path,{...old,...detail,path});
  $('diff-count').textContent=String(state.changes.size);
  $('change-list').innerHTML=[...state.changes.values()].map(item=>`<button class="change-item ${state.selectedFile===item.path?'selected':''}" data-change-path="${esc(item.path)}"><span class="file-type">${esc(icons[ext(item.path)]||'·')}</span><span class="change-meta"><strong>${esc(item.path.split('/').pop())}</strong><small>${esc(item.path)}</small></span><span class="change-stats"><i>+${item.additions||0}</i> <b>−${item.deletions||0}</b></span></button>`).join('')||'<div class="diff-empty"><div class="diff-empty-icon">⇄</div><strong>Aucun changement</strong><p>Les modifications préparées apparaîtront ici.</p></div>';
  $('change-list').querySelectorAll('[data-change-path]').forEach(el=>el.addEventListener('click',()=>showDiff(el.dataset.changePath)));
  $('apply-changes').disabled=!state.pendingPatch;
}
function showDiff(path) {
  state.selectedFile=path; const item=state.changes.get(path); if(!item)return;
  $('diff-view').innerHTML=`<div class="diff-file-title"><span class="file-type">${esc(icons[ext(path)]||'·')}</span><div><strong>${esc(path.split('/').pop())}</strong><small>${esc(path)}</small></div></div><pre class="diff-code">${renderDiff(item.diff||state.pendingPatch?.diff||'Diff détaillé indisponible. Le patch reste enregistré par Nova.','')}</pre>`;
  document.querySelectorAll('.diff-tab').forEach(el=>el.classList.toggle('active',el.dataset.diffTab==='diff'));
  $('change-list').classList.add('hidden'); $('diff-view').classList.remove('hidden'); state.diffTab='diff';
}
function renderDiff(diff) { return esc(diff).split('\n').map(line=>{const cls=line.startsWith('+')&&!line.startsWith('+++')?'added':line.startsWith('-')&&!line.startsWith('---')?'removed':line.startsWith('@@')?'hunk':'';return `<span class="diff-line ${cls}">${line||' '}</span>`;}).join(''); }
function showApproval(payload) {
  const {id,request}=payload; const patch=request.kind==='patch';
  $('approval-panel').innerHTML=`<div class="approval-title"><span class="approval-icon">${patch?'⇄':'⚠'}</span><div><strong>${patch?'Patch prêt à examiner':request.kind==='command'?'Autorisation de commande':'Fichier sensible'}</strong><small>${esc(patch?request.summary:request.kind==='command'?request.command:request.path)}</small></div></div><div class="approval-actions"><button class="reject-button" data-decision="reject">Refuser</button><button class="approve-button" data-decision="approve">Autoriser</button>${request.kind==='command'?'<button class="approve-session-button" data-decision="approve-session">Autoriser pour cette session</button>':''}</div>`;
  $('approval-panel').classList.remove('hidden');
  if(patch) { state.pendingPatch=request; for(const file of request.files||[])updateChange(file.path,{...file,diff:request.diff}); if(!request.files?.length)updateChange('Patch Nova',{diff:request.diff}); $('apply-changes').disabled=false; }
  $('approval-panel').querySelectorAll('[data-decision]').forEach(btn=>btn.addEventListener('click',async()=>{try{await window.novaDesktop.decideApproval({id,decision:btn.dataset.decision});$('approval-panel').classList.add('hidden');toast(btn.dataset.decision==='reject'?'Action refusée.':'Autorisation transmise à Nova.');}catch(e){toast(e.message);}}));
}
window.novaDesktop.onApprovalRequest(showApproval);
window.novaDesktop.onQuestion(({id,question,sessionId})=>{
  const panel=$('approval-panel'); panel.innerHTML=`<div class="approval-title"><span class="approval-icon">?</span><div><strong>Nova a une question</strong><small>${esc(question)}</small></div></div><form id="answer-form"><input id="answer-input" placeholder="Votre réponse…" maxlength="10000" required><button class="approve-button">Envoyer</button></form>`; panel.classList.remove('hidden');
  $('answer-form').addEventListener('submit',async e=>{e.preventDefault();try{await window.novaDesktop.answerQuestion({id,answer:$('answer-input').value});panel.classList.add('hidden');}catch(err){toast(err.message);}});
});
window.novaDesktop.onEvent(event=>{
  if(event.type==='status'){setStatus(event.state.replaceAll('_',' '),state.running);addMessage('system',event.state.replaceAll('_',' '),event.detail||'');}
  if(event.type==='read')addMessage('system','Fichier lu',event.path);
  if(event.type==='write')addMessage('system','Fichier modifié',event.path);
  if(event.type==='summary')addMessage('assistant','Nova',event.text);
  if(event.type==='patch-ready'){state.pendingPatch=event;for(const f of event.files||[])updateChange(f.path,{...f,diff:event.diff});if(!event.files?.length)updateChange('Patch Nova',{diff:event.diff});$('diff-view').innerHTML=`<div class="diff-summary"><strong>Patch préparé</strong><p>${esc(event.summary)}</p><pre class="diff-code">${renderDiff(event.diff)}</pre></div>`; $('apply-changes').disabled=false;document.querySelector('[data-diff-tab="diff"]').click();}
  if(event.type==='error'){addMessage('error',event.code,event.message);toast(event.message);}
  if(event.type==='completed'){state.running=false;setStatus(event.state,false);$('session-info').textContent=event.sessionId;state.sessionId=event.sessionId;toast(event.state==='DONE'?(state.pendingPatch?'Tâche terminée. Examine le diff et approuve le patch.':'Tâche terminée.'):'Session terminée.');}
});
window.novaDesktop.onInstallProgress(({state:status,message})=>{ $('install-state').textContent=message; if(status==='error')toast(message); });
window.novaDesktop.onUpdateStatus(async update=>{
  if(update.state==='available') { if(confirm('Une nouvelle version de Nova Agent Desktop ('+update.version+') est disponible. La télécharger maintenant ?')) { try { await window.novaDesktop.downloadUpdate(); toast('Téléchargement de la mise à jour…'); } catch(e) { toast('Mise à jour impossible : '+e.message); } } }
  else if(update.state==='downloading') { $('install-state').textContent='Mise à jour : '+update.percent+'%'; }
  else if(update.state==='downloaded') { $('install-state').textContent='Mise à jour prête'; if(confirm('La mise à jour '+update.version+' est téléchargée. Redémarrer Nova pour l’installer ?')) await window.novaDesktop.installUpdate(); }
  else if(update.state==='current') { $('install-state').textContent='Desktop à jour · '+update.version; }
  else if(update.state==='error') { $('install-state').textContent='Mise à jour indisponible'; }
});
$('open-project').addEventListener('click',openProject);
$('refresh-tree').addEventListener('click',async()=>{if(!state.projectRoot)return;try{const result=await window.novaDesktop.refreshTree(state.projectRoot);setFiles(result.files);toast('Arborescence actualisée.');}catch(e){toast(e.message);}});
async function openProject(){try{const result=await window.novaDesktop.pickProject();if(!result)return;state.projectRoot=result.projectRoot;$('project-label').textContent=result.projectRoot;$('project-name').textContent='⌄  '+result.projectRoot.split(/[\\/]/).pop().toUpperCase();$('provider').value=result.providerId;setFiles(result.files);addMessage('system','Projet ouvert',result.projectRoot);setStatus('Projet prêt',false);$('task-input').focus();}catch(e){toast(e.message);}}
$('composer').addEventListener('submit',async e=>{e.preventDefault();const problem=$('task-input').value.trim();if(!problem)return;if(!state.projectRoot){toast('Ouvre d’abord un dossier de projet.');return;}if(state.running)return;
  addMessage('user','Vous',problem);$('task-input').value='';state.running=true;setStatus('Initialisation…',true);
  try{const result=await window.novaDesktop.runTask({projectRoot:state.projectRoot,problem,providerId:$('provider').value});state.sessionId=result.sessionId;$('session-info').textContent=result.sessionId;if(result.state==='DONE'){state.running=false;setStatus('Terminé',false);}}
  catch(err){state.running=false;setStatus('Erreur',false);addMessage('error','Échec de la tâche',err.message);toast(err.message);}
});
$('task-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('composer').requestSubmit();}});
document.querySelectorAll('.suggestion').forEach(el=>el.addEventListener('click',()=>{$('task-input').value=el.dataset.prompt;$('task-input').focus();}));
document.querySelectorAll('.diff-tab').forEach(el=>el.addEventListener('click',()=>{state.diffTab=el.dataset.diffTab;document.querySelectorAll('.diff-tab').forEach(t=>t.classList.toggle('active',t===el));$('change-list').classList.toggle('hidden',state.diffTab!=='changes');$('diff-view').classList.toggle('hidden',state.diffTab!=='diff');}));
$('apply-changes').addEventListener('click',()=>{if(!state.pendingPatch){toast('Aucun patch à appliquer.');return;} $('approval-panel').scrollIntoView({behavior:'smooth',block:'center'}); if($('approval-panel').classList.contains('hidden')) toast('Utilise le panneau d’approbation pour autoriser ou refuser le patch.');});
$('settings').addEventListener('click',async()=>{const info=await window.novaDesktop.appInfo();$('version-info').textContent=`Desktop ${info.appVersion} · Nova Core ${info.novaVersion}`; $('info-dialog').showModal();});
$('collapse-files').addEventListener('click',()=>$('file-tree').classList.toggle('hidden'));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){e.preventDefault();openProject();}});
window.novaDesktop.appInfo().then(info=>{$('version-info').textContent=`Desktop ${info.appVersion} · Nova Core ${info.novaVersion}`;}).catch(()=>{});
setStatus('En attente',false);
