# Modèle de sécurité

## Frontière de confiance

Le modèle IA, son interface Web et les contenus du projet sont non fiables. L'IA propose des chemins et un patch ; elle ne dispose d'aucun accès direct au disque et n'autorise jamais une écriture par elle-même.

## Contrôles

1. Normalisation des chemins et refus des chemins absolus / `..`.
2. Résolution confinée à la racine cible et refus des symlinks dans les cibles modifiées.
3. Exclusions `.novaignore`, `.gitignore` et règles de sécurité prioritaires.
4. Refus des chemins de secrets connus et détection heuristique de valeurs secrètes dans les fichiers demandés et les patchs.
5. Limites de taille par fichier, réponse, contexte et patch.
6. Empreintes SHA-256 pour identifier une source changée après lecture.
7. `git apply --check` avant d'afficher le patch ; seconde validation au moment de l'application.
8. Confirmation utilisateur en terminal interactif. En non-interactif, pas d'application automatique.
9. Sauvegarde exacte des contenus avant écriture et rollback refusé si les empreintes ne correspondent plus.
10. Historique Git ciblé sur le dépôt auxiliaire.

## Limites

La détection de secrets est heuristique et peut créer des faux positifs ou négatifs. Les rapports et sauvegardes restent en clair sur disque. Le code ne peut pas confirmer que les politiques ou la disponibilité de ChatGPT autorisent un parcours automatisé ; il n'essaie pas de contourner les mécanismes de protection. Vérifie le diff avant chaque application.
