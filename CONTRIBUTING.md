# Contributing / Contribuer

## English

Use a feature branch and a pull request with the problem, resulting behavior and relevant checks. Run `npm ci` and `npm run check` using Node 22 or 24. SQLite is native: keep installation and runtime on the same Node major.

Use synthetic fixtures and mocked Freshdesk clients. Never add credentials, real tenants, customer ticket text, screenshots, exports, database files, logs or internal infrastructure details. `.env.example` must contain only empty secret fields and generic defaults. Check the files staged for commit and run `gitleaks git --redact` before pushing. The ignore file and CI checks reduce mistakes; they do not replace reviewing content.

Update both English and French documentation when behavior or configuration changes. Do not claim a Freshdesk write succeeded without verified readback. Preserve identity isolation, single-use write intents and interactive confirmation. The package remains `private: true` to prevent accidental npm publication; source distribution is through this Git repository.

## Français

Utiliser une branche de travail et une pull request décrivant le problème, le comportement obtenu et les contrôles pertinents. Exécuter `npm ci` puis `npm run check` sous Node 22 ou 24. SQLite est natif : conserver la même version majeure pour l'installation et l'exécution.

Utiliser des fixtures synthétiques et des clients Freshdesk simulés. Ne jamais ajouter d'identifiants, tenants réels, textes de tickets clients, captures, exports, bases, journaux ou détails d'infrastructure interne. `.env.example` doit conserver des champs secrets vides et des valeurs génériques. Examiner les fichiers indexés et lancer `gitleaks git --redact` avant le push. Les exclusions et contrôles CI réduisent les erreurs sans remplacer la revue du contenu.

Mettre à jour les documentations française et anglaise lors d'un changement de comportement ou de configuration. Ne pas annoncer une écriture Freshdesk réussie sans relecture vérifiée. Conserver l'isolation des identités, l'usage unique des intentions et la confirmation interactive. Le paquet reste `private: true` pour empêcher une publication npm accidentelle ; le code est distribué par ce dépôt Git.
