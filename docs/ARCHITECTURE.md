# Architecture

Nova Agent garde la CLI, l'orchestrateur, le navigateur, les fournisseurs, le protocole, le contexte, les patchs et l'historique séparés.

## Flux principal

```text
CLI fix
  -> Scanner / project-context / tree
  -> Provider (AIProvider)
  -> Parser JSON + Zod
     -> NEED_FILES -> permissions -> lecture + SHA-256 -> Provider
     -> NEED_INFO  -> saisie utilisateur -> Provider
     -> PATCH_READY -> validateur de patch -> rapport PREPARED
                   -> diff visible -> approbation utilisateur
                   -> backup -> git apply -> tests locaux configurés
                   -> commit auxiliaire -> rapport APPLIED
     -> DONE -> clôture
```

## Contrats

Tous les fournisseurs implémentent `AIProvider` et `AIRequest`/`AIResponse` dans `src/protocol/schema.ts`. Aucun adaptateur ne lit directement le système de fichiers du projet. L'orchestrateur est la seule couche qui autorise les lectures et fournit leur contenu. Un changement de fournisseur reconstruit le contexte à partir de l'état local et ne suppose pas que l'historique interne de la plateforme soit transférable.

## État local

Une session persistée se trouve dans `.nova_agents/sessions/<id>.json`. Les transitions sont contrôlées par `session/state-machine.ts`; les étapes importantes restent dans le journal de session. Les patchs sont dans `.nova_agents/patches/`, sauvegardes dans `.nova_agents/backups/`, rapports dans `.nova_agents/diff/`, et l'index chronologique dans `operations.json`.

## Git auxiliaire

`.nova_agents/history.git/` est un dépôt bare utilisé explicitement avec `--git-dir` et `--work-tree`. Les snapshots ne font le staging que des chemins que le scanner a autorisés. Après une correction, seuls les chemins touchés sont ajoutés au commit auxiliaire. Aucun reset du dépôt principal n'est utilisé.
