# Nova Agent

**Nova Agent** est un agent local de développement piloté par CLI. Il examine l'arborescence d'un projet, échange avec un fournisseur IA par l'interface Web, demande les fichiers précis dont il a besoin, prépare un patch unifié, montre le diff, attend une confirmation, applique la correction et conserve un historique indépendant avec rapport Markdown et annulation vérifiée.

> État du projet : le cœur local, le protocole, le scanner, la validation des patchs, l'historique auxiliaire et les tests automatisés sont implémentés dans le code source. L'adaptateur ChatGPT Web dépend des sélecteurs du site et doit être validé avec une session Edge réelle. Les adaptateurs Claude et Gemini sont explicitement indiqués comme non implémentés. L'intégration Web n'a pas été vérifiée en direct par cette livraison.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Prérequis Windows](#prérequis-windows)
- [Installation](#installation)
- [Premier lancement](#premier-lancement)
- [Commandes](#commandes)
- [Cycle de correction](#cycle-de-correction)
- [Données locales](#données-locales)
- [Sécurité](#sécurité)
- [Fournisseurs IA](#fournisseurs-ia)
- [Tests et vérifications](#tests-et-vérifications)
- [Limites connues](#limites-connues)
- [Structure du code](#structure-du-code)

## Fonctionnalités

- Node.js + TypeScript strict, ESM, CLI Commander.
- Profil Microsoft Edge dédié et persistant via Playwright ; aucune utilisation du profil personnel Edge.
- Protocole commun `nova-agent/1`, validé par Zod.
- États `NEED_FILES`, `FILE_RECEIVED`, `NEED_INFO`, `PATCH_READY` et `DONE`.
- Scanner de projet, arborescence déterministe et règles `.novaignore` indépendantes, en plus de `.gitignore`.
- Exclusions des dépendances, builds, secrets courants, répertoire `.nova_agents` et liens symboliques.
- Envoi des seuls fichiers explicitement demandés, SHA-256 et non-répétition de contenus inchangés.
- Patchs unifiés contrôlés par `git apply --check`, contrôle des chemins, détection de fichiers obsolètes et blocage des écritures dans `.nova_agents`.
- Confirmation obligatoire avant l'application interactive ; le mode non interactif n'applique pas de patch.
- Sauvegarde exacte des fichiers touchés, commit auxiliaire indépendant, rapport Markdown et rollback avec vérification des empreintes.
- Sessions persistées et reprise explicite.
- Provider `mock` pour tester le protocole sans navigateur ni compte IA.

## Prérequis Windows

- Windows 10 ou Windows 11.
- Node.js LTS compatible, version 20.19 ou supérieure.
- npm.
- Git disponible dans le `PATH`.
- Microsoft Edge installé pour `chatgpt-web`.
- Un compte ChatGPT déjà accessible dans le navigateur, selon les conditions d'utilisation de la plateforme.

Vérifie dans PowerShell :

```powershell
node --version
npm --version
git --version
```

## Installation

Décompresse l'archive, puis ouvre PowerShell dans le dossier `nova-agent` :

```powershell
cd "D:\Project\nova-agent"
npm install
npm run typecheck
npm test
npm run build
```

Le répertoire `node_modules` est créé localement par npm. Il n'est pas inclus dans l'archive.

Pour installer les commandes globales `nova` et `nova-agent`, depuis le dossier du projet :

```powershell
npm.cmd link
nova --help
```

Depuis le dossier du projet à analyser, tu peux ensuite lancer Nova directement :

```powershell
cd "D:\Project\MonProjet"
nova.cmd
# ou lancer une tâche directement :
nova fix "Analyse src/server.ts" --no-apply
```

Sans argument, Nova ouvre une interface interactive dans le terminal avec son logo et l’état `thinking` pendant les réponses. Décris une tâche à l’invite `nova ›`; les événements `read` et `write` indiquent les fichiers transmis ou modifiés. À la fin, le lien du rapport `.md` ouvre le diff dans les terminaux compatibles OSC 8. Pendant l’approbation, `approve all` valide tous les fichiers du patch courant. Utilise `/status`, `/help` ou `/exit`. Les commandes CLI restent disponibles. Nova utilise le dossier courant comme projet. Ajoute `--project "D:\Project\AutreProjet"` pour cibler un autre dossier. Sans installation globale : `npm.cmd run dev -- <commande>`.

## Premier lancement

### 1. Initialiser le projet cible

```powershell
npm run dev -- init "D:\Project\MonProjet"
```

Nova Agent crée `.novaignore` si le fichier est absent, crée `.nova_agents/`, génère `project-tree.txt`, un modèle `project-context.md` et la configuration locale. Les fichiers existants `.novaignore`, `config.json` et `project-context.md` ne sont pas écrasés.

Si un dépôt Git principal existe, Nova Agent ne le réinitialise pas et ne crée aucun commit dedans. L'ajout de `.nova_agents/` au `.gitignore` principal demande une confirmation. Tu peux également autoriser explicitement cette opération :

```powershell
npm run dev -- init "D:\Project\MonProjet" --add-gitignore
```

### 2. Compléter le contexte

```powershell
notepad "D:\Project\MonProjet\.nova_agents\project-context.md"
```

Renseigne les frameworks, l'architecture, les règles métier, les conventions et les commandes de test réellement utilisées. Ne mets jamais de mot de passe, clé API, cookie ou token dans ce fichier.

### 3. Ouvrir la session Edge dédiée

```powershell
npm run dev -- browser --project "D:\Project\MonProjet"
```

Une première connexion peut être nécessaire. Connecte-toi toi-même dans la fenêtre Edge ouverte. Nova Agent n'intercepte pas ton mot de passe et ne demande pas de cookies ou de jetons de session. Edge reste ouvert entre les commandes `fix` et `resume` et après `DONE`. Il se ferme à l’arrêt de Nova par `Ctrl+C` ou à la fermeture du terminal. La commande `browser` reste un contrôle manuel et se ferme lorsque tu appuies sur Entrée. Le profil persistant dédié est conservé dans :

```text
%USERPROFILE%\.nova-agent\edge-profile\
```

Il est indépendant du profil personnel Edge. Évite de lancer deux instances Nova Agent qui tenteraient d'utiliser en même temps ce profil, Playwright ne permettant pas plusieurs instances sur le même répertoire de profil.

### 4. Vérifier les fournisseurs

```powershell
npm run dev -- model list
```

`chatgpt-web` est l'adaptateur Web implémenté, mais nécessite Edge, une session valide et une interface compatible. `mock` sert aux tests locaux et ne réalise pas une correction réelle. `claude-web` et `gemini-web` sont des emplacements réservés et retournent une erreur explicite.

### 5. Lancer un diagnostic

```powershell
npm run dev -- fix "Le login retourne 401 pour un utilisateur valide" --provider chatgpt-web --no-apply
```

`--no-apply` autorise l'analyse et la préparation du patch, sans toucher aux sources. Vérifie ensuite :

```powershell
npm run dev -- status --project "D:\Project\MonProjet"
npm run dev -- diff --project "D:\Project\MonProjet"
npm run dev -- history --project "D:\Project\MonProjet"
```

Pour appliquer un patch préparé depuis un terminal interactif :

```powershell
npm run dev -- apply --project "D:\Project\MonProjet"
```

Ou annuler la dernière opération encore annulable :

```powershell
npm run dev -- undo --project "D:\Project\MonProjet"
```

## Commandes

| Commande | Fonction |
|---|---|
| `nova-agent init [project]` | Initialise les fichiers locaux et l'historique auxiliaire. |
| `nova-agent browser` | Ouvre ChatGPT avec le profil Edge dédié et vérifie la session. |
| `nova-agent status` | Affiche projet, fournisseur, nombre de fichiers, sessions, opérations et état Git auxiliaire. |
| `nova-agent context tree` | Régénère et affiche l'arborescence filtrée. |
| `nova-agent context show` | Affiche `project-context.md`. |
| `nova-agent context refresh` | Actualise le tree et les statistiques de scan. |
| `nova-agent fix "description"` | Démarre le workflow IA et prépare éventuellement un patch. |
| `nova-agent diff` | Affiche le patch en attente ou le dernier patch appliqué. |
| `nova-agent apply` | Prévisualise, confirme et applique un patch `PREPARED`. |
| `nova-agent undo` | Annule la dernière opération sûre et vérifiable. |
| `nova-agent history` | Liste rapports, statuts, tests et commits auxiliaires. |
| `nova-agent resume <session-id>` | Reprend une session locale persistée. |
| `nova-agent model list` | Liste les fournisseurs et leurs capacités connues. |
| `nova-agent model use <provider-id>` | Change le fournisseur par défaut. |

Les commandes qui prennent en charge un projet acceptent `--project <path>`. Exemple PowerShell avec espaces :

```powershell
npm run dev -- context tree --project "D:\Project\MonProjet"
```

## Cycle de correction

1. Le contexte initial comprend le `project-context.md` et le tree, tronqués si nécessaire par le budget local.
2. Le prompt général et le protocole `nova-agent/1` sont ajoutés au premier message de la session seulement ; les messages suivants du même fournisseur s’appuient sur le fil existant et ne répètent que les consignes propres à l’échange.
3. Le fournisseur répond par un unique objet JSON conforme au protocole `nova-agent/1`.
4. Lors de `NEED_FILES`, chaque chemin est normalisé et contrôlé. Les fichiers sont découpés en segments de 300 lignes et 12 KiB maximum ; Nova attend un `FILE_RECEIVED` avec le chemin et l’index du segment avant d’envoyer la suite. Si un secret potentiel est détecté dans un fichier demandé, Nova demande `approve` ou `rejected` avant tout envoi ; l’accord est associé à l’empreinte exacte du fichier et sera redemandé si son contenu change. Les contenus inchangés ne sont pas renvoyés et un budget total de 4 MiB par demande limite la taille cumulée des fichiers transmis.
5. Lors de `NEED_INFO`, la question est affichée dans le terminal et la réponse est enregistrée dans la session.
6. Lors de `PATCH_READY`, Nova Agent valide les chemins, les règles d'exclusion, les SHA-256 des sources et l'applicabilité du patch avant de le conserver.
7. Le résumé affiche une ligne par fichier avec les ajouts et suppressions ; le nom du fichier ouvre le rapport Markdown complet dans `.nova_agents/diff/`. L'utilisateur tape `approve` pour appliquer le patch ou `reject` pour le refuser. Aucune réponse de l'IA ne constitue une approbation.
8. Après confirmation, les originaux sont sauvegardés, le patch est appliqué, les tests explicitement configurés sont lancés, l'historique auxiliaire est mis à jour et le rapport Markdown est enrichi.
9. `undo` vérifie les empreintes post-application. Si un fichier a changé depuis, le rollback est refusé afin de préserver le travail externe.

### États de réponse de l'IA

```text
NEED_FILES  -> lecture contrôlée -> envoi un par un -> FILE_RECEIVED -> analyse
NEED_INFO   -> question utilisateur -> nouvel échange
PATCH_READY -> validation -> diff -> approbation -> application
DONE        -> fin sans patch
```

## Données locales

Dans le projet cible :

```text
mon-projet/
├── .novaignore
└── .nova_agents/
    ├── config.json
    ├── project-tree.txt
    ├── project-context.md
    ├── session.json
    ├── sessions/
    ├── diff/
    ├── backups/
    ├── patches/
    ├── logs/
    ├── operations.json
    └── history.git/
```

- `config.json` : fournisseur et limites.
- `project-tree.txt` : tree filtré ; les contenus des fichiers ne sont pas lus pour le générer.
- `project-context.md` : contexte éditable par l'utilisateur.
- `sessions/` et `session.json` : progression des tâches persistées, empreintes déjà transmises et métadonnées de reprise. Le contenu source n'est pas stocké dans la session.
- `patches/` : patchs préparés, y compris ceux qui n'ont pas été appliqués.
- `backups/` : contenus originaux exacts des fichiers touchés.
- `diff/` : rapports Markdown distincts, créés au plus tôt après un patch exploitable puis mis à jour.
- `operations.json` : index des opérations pour `history`, `apply` et `undo`.
- `history.git/` : dépôt Git auxiliaire bare, utilisé avec un worktree explicite. Les commandes Git de l'agent ciblent ce dépôt auxiliaire, pas le `.git` principal.

Les rapports et contenus de contexte restent locaux par défaut. Ils ne sont pas chiffrés ; protège les permissions et sauvegardes du répertoire projet.

## Configuration

Extrait de `.nova_agents/config.json` :

```json
{
  "version": 1,
  "defaultProvider": "chatgpt-web",
  "projectRoot": ".",
  "browser": {
    "channel": "msedge",
    "headless": false,
    "persistentProfile": true,
    "timeoutMs": 120000
  },
  "protocol": {
    "version": "nova-agent/1",
    "maxFilesPerRequest": 15,
    "maxFileSizeBytes": 1048576,
    "maxTotalFileBytes": 4194304,
    "maxContextChars": 60000,
    "maxResponseBytes": 2097152,
    "timeoutMs": 120000
  },
  "patches": {
    "requireConfirmation": true,
    "backupBeforeApply": true,
    "maxPatchBytes": 2097152
  },
  "history": {
    "enabled": true,
    "directory": ".nova_agents/history.git",
    "reportsDirectory": ".nova_agents/diff"
  },
  "tests": []
}
```

La configuration est validée au chargement. Les commandes suggérées par l'IA ne sont jamais exécutées automatiquement. Seules les commandes `tests` explicitement ajoutées par le propriétaire au fichier de configuration sont exécutées après l'application.

## `.novaignore`

Le fichier suit les règles de type `.gitignore`. Il est appliqué indépendamment de `.gitignore`. Les règles communes excluent notamment : `node_modules/`, `vendor/`, `dist/`, `build/`, les caches, `.git/`, `.nova_agents/`, les environnements Python, `.env` et les clés privées usuelles. `.env.example` et `.env.sample` sont autorisés par défaut, mais une détection du contenu peut encore bloquer un secret littéral suspect.

Pour ajouter une exclusion :

```gitignore
# Dossiers privés du projet
internal-data/
local-dumps/
```

Une demande explicite de l'IA ne peut pas contourner une exclusion ou une protection de chemin. Les symlinks ne sont pas suivis et les écritures sortant du projet sont refusées.

## Sécurité

- Les réponses IA sont des données non fiables.
- Les chemins absolus, `..`, symlinks en cible, chemins exclus, secrets évidents et écritures dans `.nova_agents/` sont bloqués.
- Aucun contenu `.env`, clé privée, profil Edge, cookie ou token de session n'est envoyé volontairement.
- Un patch doit passer la validation du protocole et `git apply --check` avant la prévisualisation, puis être revalidé avant écriture.
- Les empreintes SHA-256 détectent une source modifiée entre lecture, confirmation et application.
- Chaque application conserve les originaux. En cas d'échec de l'application ou d'enregistrement de l'historique, la restauration est tentée depuis la sauvegarde vérifiée.
- `undo` restaure uniquement si **tous** les fichiers touchés correspondent à l'état post-application attendu ; sinon, aucun rollback partiel silencieux n'est effectué.
- Le dépôt Git principal n'est jamais reset, supprimé ou commité par le code de l'agent.
- Les tests de l'IA restent des suggestions. Les seules commandes exécutées sont celles du tableau `tests` validé localement.

La détection heuristique des secrets ne garantit pas l'identification de chaque secret possible. Avant tout envoi, examine les fichiers et exclusions de ton projet.

## Fournisseurs IA

- **`chatgpt-web`** : Playwright ouvre Edge via `channel: "msedge"` et le profil dédié. La connexion est manuelle. Les sélecteurs et l'extraction sont centralisés pour faciliter le diagnostic, mais l'interface ChatGPT peut évoluer.
- **`mock`** : renvoie `DONE` de façon déterministe par défaut et permet d'injecter un scénario dans les tests. Il n'est pas destiné à réparer un vrai projet.
- **`claude-web`** : réservé, non implémenté. L'adaptateur échoue explicitement.
- **`gemini-web`** : réservé, non implémenté. L'adaptateur échoue explicitement.

Nova Agent ne contourne pas CAPTCHA, quotas, contrôles d'accès ou mécanismes de connexion. Il n'utilise pas les cookies ou jetons du profil personnel.

## Tests et vérifications

Avec les dépendances installées :

```powershell
npm run typecheck
npm test
npm run build
```

Les tests automatisés couvrent les réponses JSON, le protocole, les chemins, la détection de secrets, le tree et les exclusions, la lecture contrôlée, la préparation et l'application de patchs, la sauvegarde et la restauration exactes ainsi que le provider mock. Les tests unitaires ne requièrent pas de session ChatGPT.

L'intégration Edge doit être testée séparément sur une machine qui possède Microsoft Edge et une session ChatGPT accessible :

```powershell
npm run dev -- browser
npm run dev -- model list
npm run dev -- fix "Vérifier le flux de login" --provider chatgpt-web --no-apply
```

N'affirme pas que le test web a réussi sans l'avoir exécuté.

## Limites connues

- Les interfaces Web ne proposent pas de contrat DOM stable ; l'adaptateur ChatGPT peut nécessiter une mise à jour de sélecteurs.
- Ce dépôt n'inclut ni token API, ni connexion programmée, ni service distant.
- Claude Web et Gemini Web ne sont pas implémentés.
- Les patchs binaires et renamings de fichiers ne sont pas pris en charge par le validateur actuel.
- Le scanner applique les négations de type `.gitignore` mais les règles d'exclusion de sécurité (`node_modules`, `.git`, `.nova_agents`, etc.) restent prioritaires.
- La restauration des données est locale et ne constitue pas une sauvegarde hors machine.
- Le code n'a pas encore été validé dans un parcours réel Edge/ChatGPT depuis cet environnement.

## Structure du code

```text
src/
├── cli/                # Commandes et interactions terminal
├── ai/                 # Contrat et adaptateurs de fournisseurs
├── browser/            # Edge, sélecteurs, inspection et lecture de réponse
├── context/            # Scanner, tree, exclusions, budget et lecture contrôlée
├── protocol/           # Schéma JSON, parseur, validation et prompts
├── session/            # Orchestration, état et persistance
├── patches/            # Parsing, contrôle, préparation et application
├── history/             # Git auxiliaire, rapports, index et rollback
├── security/            # Chemins, permissions et détection de secrets
├── config/              # Schéma et chargement de configuration
└── utils/               # Erreurs et I/O atomiques
```

Le dossier `prompts/` contient le prompt système et la documentation du protocole ; `examples/` contient des exemples documentaires identifiés comme fictifs.
