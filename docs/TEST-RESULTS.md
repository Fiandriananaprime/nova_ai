# Résultats des vérifications — Nova Agent

Date de la vérification : 18 octobre 2026.

## Réussis dans l'environnement de génération

- Transpilation de syntaxe : 57 fichiers TypeScript dans `src/`, sans erreur de syntaxe, après les dernières modifications.
- Vérification stricte du code source et des tests avec le compilateur TypeScript global, les définitions Node installées dans l'environnement et des déclarations temporaires pour les dépendances de bibliothèque absentes : aucune erreur détectée après les dernières modifications. Ce contrôle n'est pas un remplacement du typecheck contre les déclarations réelles des packages.
- Smoke test hors ligne : 23 assertions réussies couvrant les chemins, les fichiers sensibles, le parseur de diff, la machine à états, la persistance JSON, les rapports Markdown, les identifiants de session/opération et le refus des liens symboliques vers le stockage interne.
- La stratégie Git auxiliaire `--git-dir`/`--work-tree` a été vérifiée au niveau de commandes Git : elle permet de faire un commit dans le dépôt auxiliaire sans déplacer le `HEAD` du dépôt principal.

## Non exécutés

- `npm install`, `npm run typecheck`, `npm test` et `npm run build` contre les dépendances exactes du `package.json` : l'accès au registre npm a échoué dans l'environnement de génération (`EAI_AGAIN registry.npmjs.org`). Les dépendances ne sont donc pas incluses dans l'archive.
- La suite Vitest n'a pas été exécutée. Les tests sont fournis dans `tests/` pour exécution après installation.
- Le parcours réel Microsoft Edge + session ChatGPT n'a pas été exécuté. Les sélecteurs Web peuvent nécessiter une adaptation en fonction de l'interface réelle.
- Claude Web et Gemini Web sont des adaptateurs réservés, explicitement non implémentés.

## Première validation sur Windows

Dans PowerShell, après extraction de l'archive :

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run dev -- init "D:\\chemin\\vers\\projet"
npm run dev -- model list
```

Pour tester l'interface Web, connecte-toi manuellement dans le profil Edge dédié :

```powershell
npm run dev -- browser --project "D:\\chemin\\vers\\projet"
npm run dev -- fix "Décrire le problème" --provider chatgpt-web --no-apply --project "D:\\chemin\\vers\\projet"
```

`--no-apply` n'applique aucun patch. Inspecte ensuite le diff et lance explicitement `npm run dev -- apply --project "D:\\chemin\\vers\\projet"` si tu approuves la modification.
