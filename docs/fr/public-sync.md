# Garder le dépôt public à jour

[English](../en/public-sync.md) · [README](../../README.fr.md)

Le MCP privé reste la source des évolutions fonctionnelles. Cet exporteur local lit
une liste explicite de fichiers de code committés et prépare une mise à jour publique.
Il ne copie ni historique Git, messages de commit privés, identifiants de commits
sources ou remotes privés. Aucun jeton du dépôt privé n'est nécessaire dans la CI publique.

## Prévisualiser, préparer, relire

Prérequis : un clone public propre, un clone privé local distinct dont les évolutions
MCP sont committées, Node 22 ou 24, les dépendances npm installées et `gitleaks` dans le PATH.
Conserver la même version majeure de Node pour l'installation et l'exécution.

Depuis ce dépôt public :

```sh
npm run sync:private -- --source /path/to/private/mcp
```

Cette prévisualisation ne crée ni fichier, branche, commit ou push dans le clone public.
Le candidat est contrôlé dans un répertoire temporaire protégé, puis supprimé.
Pour préparer la mise à jour après examen :

```sh
npm run sync:private -- --source /path/to/private/mcp --apply
npm ci
npm run check
```

`--apply` crée une branche locale `codex/sync-mcp-…` et copie uniquement les changements
validés. Sans changement, aucune branche n'est créée. La commande n'indexe, ne committe,
ne pousse, n'ouvre de PR et ne publie rien. Si un test échoue, les changements préparés
restent locaux. Examiner `git diff`, adapter les deux documentations si nécessaire,
committer uniquement les fichiers voulus, puis scanner l'historique avant de pousser :

```sh
gitleaks git --redact --no-banner --log-opts=--all .
git push -u origin HEAD
gh pr create --base main
```

Fusionner seulement après revue du diff public et validation de la CI. Ne jamais
merger l'historique privé dans le public ni utiliser de push miroir. Ne pas reprendre
un SHA source ou un texte de commit privé dans le commit ou la description de PR publics.

## Frontière d'export

[public-sync.manifest.json](../../public-sync.manifest.json) liste les chemins un par un.
Les nouveaux fichiers source/tests, fichiers supprimés et liens symboliques source ou
destination bloquent l'export jusqu'à revue explicite. Les nouveaux scripts restent
exclus tant que la frontière de code et le manifeste ne sont pas modifiés volontairement.

Les documents privés, déploiements, fichiers d'environnement, données d'exploitation,
journaux et exports ne sont ni sélectionnés ni lus. Documentation, illustration, CI et
outils de publication publics restent gérés ici. Le paquet conserve ses métadonnées et
scripts publics ; seuls version, moteurs et dépendances privés sont repris. Les URL du
lockfile doivent utiliser le registre npm public sans identifiants ni jetons d'URL ;
les liens locaux et références de dépendances hors registre sont refusés.

L'exporteur applique des transformations précises au défaut de base de données et aux
textes de connexion. Un changement non reconnu du défaut de base bloque l'export.
Il recherche chemins hôte, adresses privées, tenants Freshdesk et e-mails non fictifs,
puis lance Gitleaks sans autoriser les commentaires d'exemption. Un scanner absent ou
un échec empêche la copie. La revue reste nécessaire : aucun scanner ne reconnaît toute
information métier confidentielle dans du code ou une fixture apparemment synthétique.

## Liste d'exclusion privée locale

Conserver les repères propres à votre installation hors de ce dépôt public. Fournir
un JSON avec un tableau `deniedLiterals` de chaînes non vides d'au moins trois caractères :

```sh
npm run sync:private -- --source /path/to/private/mcp --policy /path/to/private/export-policy.json --apply
```

Cette liste est lue localement, comparée sans distinction de casse et jamais copiée
dans le dépôt public. Les erreurs indiquent le fichier rejeté, sans la valeur privée.
Ajouter les domaines internes et repères clients au fil des évolutions ; ne pas mettre
d'identifiants secrets dans ce fichier. Un Makefile privé peut fournir automatiquement
le chemin source et cette politique.

Reporter les corrections fonctionnelles dans le privé également : une correction MCP
uniquement publique serait écrasée lors d'un export ultérieur si elle n'a pas été reprise.
Cette procédure ne modifie ni ne déploie de service en production.
