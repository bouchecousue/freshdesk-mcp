# Sécurité et exploitation

[English](../en/security.md) · [README](../../README.fr.md)

## Confiance et authentification

Le MCP sert de serveur d'autorisation OAuth pour les clients et utilise des clés API personnelles vers Freshdesk. Chaque utilisateur autorise son propre tenant et agent ; aucun identifiant administrateur partagé n'est fourni. Seules les origines natives HTTPS `*.freshdesk.com`, sans chemin personnalisé ni identifiants, sont acceptées.

Les codes d'autorisation utilisent PKCE S256. Les jetons d'accès sont opaques et de courte durée ; les refresh tokens sont rotatifs avec détection de rejeu. Les clés API Freshdesk et intentions d'écriture sont chiffrées en AES-256-GCM avec une clé maîtresse propre au déploiement et des données additionnelles liées au contexte. Les jetons OAuth sont conservés sous forme d'empreintes à clé. Un client limité à `freshdesk:read` ne peut pas exécuter d'écriture.

L'enregistrement et la découverte des métadonnées ne vérifient pas l'appartenance à votre organisation. Cette version ne fournit ni liste de tenants autorisés ni approbation administrative des inscriptions. L'exploitant contrôle l'accès à son déploiement ; vérifier les exigences d'inscription et d'accès avant exposition.

## Données conservées

| Donnée | Stockage |
| --- | --- |
| Clés API Freshdesk et intentions préparées | Chiffrées dans la base SQLite applicative |
| Identité utilisateur/agent, tenant, métadonnées des clients OAuth | Données d'exploitation SQLite pouvant identifier des personnes |
| Jetons OAuth | Empreintes à clé et métadonnées de cycle de vie |
| Audit et statistiques quotidiennes | Identité, tenant, outil, action, résultat, volumes, durée et vérification des écritures |
| Passages sémantiques et métadonnées de contenu | Chiffrés dans la base sémantique optionnelle distincte |
| Vecteurs, identifiants, empreintes HMAC et état de synchronisation | Non chiffrés au niveau applicatif ; à traiter comme sensibles |

L'audit ne conserve ni corps brut de ticket/conversation ni texte brut de recherche. Les requêtes expertes laissent une empreinte non réversible à clé. Le logger masque les champs sensibles et réduit les objets d'erreur, sans constituer un anonymiseur général. L'index sémantique conserve volontairement des copies protégées du contenu des tickets. Aucune donnée d'exploitation ne doit entrer dans ce dépôt public.

L'application crée les fichiers SQLite en mode `0600` et les nouveaux répertoires de stockage en `0700`. Protéger aussi les fichiers WAL/SHM, exports, sauvegardes, fichiers d'environnement et journaux. Utiliser un umask restrictif, le chiffrement du stockage et des accès hôte adaptés. Des embeddings locaux ne rendent pas les vecteurs anonymes.

## Sauvegarde et restauration

Utiliser la sauvegarde en ligne SQLite ou arrêter tous les processus serveur/indexeur avant de copier une base. Copier uniquement le fichier principal d'une base active peut perdre l'état du WAL. Sauvegarder la base applicative et, si utilisée, la base sémantique ; conserver séparément la clé maîtresse dans un stockage protégé.

Restaurer d'abord dans un répertoire protégé distinct. Vérifier l'intégrité, les permissions et les accès avec la même clé avant de basculer les services. La perte de la clé empêche le déchiffrement ; changer seulement la variable d'environnement ne constitue pas une rotation de clé. Cette version ne propose pas de commande automatisée de migration de clé maîtresse.

## Surveillance et mises à jour

`/health` vérifie le processus, pas les identifiants des agents ni l'exhaustivité de l'index. Utiliser `freshdesk_health` authentifié pour la connexion et `freshdesk_semantic_index_status` pour la couverture individuelle. Surveiller les quotas API, l'espace disque, les erreurs OAuth et les échecs de vérification des écritures.

Un administrateur local peut lancer le rapport d'usage, sans l'exposer comme outil aux utilisateurs du workspace :

```bash
npm run --silent usage-report -- --database /path/to/freshdesk-mcp.sqlite3 --days 30
```

Le rapport contient les noms/e-mails connus : restreindre l'accès à sa sortie. Définir une politique de conservation ; le nettoyage des jetons expirés ne couvre pas toute la rétention d'audit et d'index.

Avant une mise à jour, sauvegarder bases et clé, arrêter les workers concernés, installer/compiler le code et vérifier santé, découverte et une lecture. Tester séparément les écritures sur un ticket de test. Ne pas utiliser des écritures répétées comme contrôle de santé. Examiner les migrations avant un retour arrière : restaurer le code seul ne rétablit pas forcément un ancien schéma.

## Signalement de vulnérabilités

Voir [SECURITY.md](../../SECURITY.md). Ne pas mettre d'identifiants de production ou de contenu client dans les issues publiques. Ces contrôles documentés ne constituent pas une certification de sécurité indépendante.
