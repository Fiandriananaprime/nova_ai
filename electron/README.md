# Nova Agent Desktop (Windows)

## Prérequis pour lancer depuis les sources
- Windows 10/11 x64
- Node.js 20.19+ et npm
- Un fournisseur Nova configuré (ChatGPT Web, Claude Web, Gemini Web ou mock)

## Installation de développement (PowerShell)
```powershell
git clone https://github.com/Fiandriananaprime/nova_ai.git
cd nova_ai
npm install
npm run build
npm run desktop
```

Au premier démarrage, le desktop vérifie la présence du paquet global `@xvortex/nova-agent` et propose/essaie son installation. La logique de la fenêtre utilise le moteur Nova compilé localement dans `dist` afin de ne pas dupliquer l'orchestrateur.

## Créer l'installateur Windows
```powershell
npm install
npm run desktop:dist
```
Le fichier NSIS sera produit dans `release/Nova-Agent-Setup-<version>.exe`.

## Notes
- Les patchs sont préparés sans appliquer les changements automatiquement.
- L'approbation des commandes et des fichiers sensibles est demandée par le moteur Nova.
- La mise à jour du desktop doit être distribuée par une release GitHub signée/publiée. Les builds locaux ne sont pas signés automatiquement.
- Si l'installation globale du CLI échoue, le moteur embarqué reste utilisable ; vérifiez Node.js, npm et l'accès au registre configuré.
