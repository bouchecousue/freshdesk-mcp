# Recherche sémantique locale optionnelle

[English](../en/semantic-search.md) · [README](../../README.fr.md)

Les outils Freshdesk classiques fonctionnent sans service d'embeddings ni worker. Six outils sémantiques sont enregistrés, mais les recherches nécessitent un index alimenté et un moteur local compatible.

## Activer l'indexation

1. Installer séparément un moteur d'embeddings local. Le code demande le modèle `ggml-org/embeddinggemma-2-GGUF:Q8_0`, attend **768 flottants finis** par vecteur et utilise les préfixes `task: search result | query: …` / `title: … | text: …`. Un endpoint de style OpenAI doit réellement servir ce modèle avec le bon prétraitement ; les embeddings ne sont pas interchangeables. Moteur et poids ne sont pas inclus ; vérifier leurs licences.
2. Lier le moteur à `127.0.0.1`, normalement au port `9932`. Définir `FRESHDESK_EMBEDDING_URL` si nécessaire : seul HTTP sur `127.0.0.1` est accepté. Ne pas publier cet endpoint.
3. Connecter au moins un agent via OAuth. Le worker utilise les identités enregistrées et leurs identifiants chiffrés dans la base applicative.
4. Après `npm run build`, démarrer un processus séparé avec les mêmes base, environnement et clé maîtresse :

```bash
node --env-file=.env dist/scripts/index-semantic.js
```

5. Appeler `freshdesk_semantic_index_status` sous chaque identité et examiner la couverture. Superviser le worker séparément du serveur MCP.

L'index se trouve dans `${DATABASE_PATH}.semantic.sqlite3`. Conserver ce fichier et ses WAL/SHM hors de Git et les protéger comme la base applicative. Conserver la clé séparément. Arrêter les workers avant maintenance ou import natif.

## Couverture et accès

Chaque `tenant|userId` possède une partition distincte. Le worker acquiert d'abord les tickets listés, puis parcourt les identifiants historiques jusqu'au maximum observé, avec l'endpoint d'archives. Les passages suivants récupèrent les changements avec recouvrement du point de synchronisation et relisent un échantillon borné de sources anciennes. Les conversations ont une borne de sécurité de 300 pages ; son dépassement provoque un échec au lieu de publier un ticket partiel.

`initialScanComplete` décrit un parcours d'acquisition terminé, jamais la visibilité de toutes les données du tenant. Les trous d'identifiants, droits et maximum observé limitent la couverture. Les pièces jointes ne sont pas indexées. Quotas API et débit du modèle peuvent rendre le premier parcours coûteux ; surveiller progression et limites d'appels.

La recherche relit tickets et conversations avec la clé courante de l'agent et vérifie que le passage cité correspond toujours. Les sources modifiées, supprimées, devenues privées ou inaccessibles ne sont pas restituées depuis le cache. La découverte vérifie la description courante du ticket. Les identités révoquées sont purgées lors d'un passage ultérieur du worker ; un worker arrêté ne nettoie rien.

Le contenu des passages est chiffré ; vecteurs, métadonnées opérationnelles, identifiants et empreintes HMAC ne sont pas chiffrés au niveau applicatif. Tout l'index est sensible. Le masquage de secrets est heuristique et n'anonymise pas le contenu client.

## Interpréter les résultats

Les quatre recherches acceptent `query`, `limit` (1–10), `companyId`, `createdFrom`, `includePrivate` (false par défaut) et `minimumSimilarity` (défaut `0.72`). Un résultat vide peut exposer `abstained=true`. La similarité n'est pas une confiance statistique. Un ticket fermé/résolu ne prouve pas le succès de la solution. Les formulations antérieures doivent être adaptées sans révéler les informations d'un autre client.

La découverte sans requête examine au plus 300 descriptions récentes éligibles et renvoie des groupes bornés, normalement au sein d'une société connue sur plusieurs jours Europe/Paris. Seuil par défaut : `0.9` ; plage : `0.7`–`0.99`. Tickets sans réponse, alertes, groupes inter-sociétés et groupes sur une seule journée nécessitent des options explicites. Ces regroupements heuristiques suggèrent des symptômes communs, sans prouver une cause ni un décompte exhaustif. Utiliser les outils structurés pour les identifiants exacts, SLA et comptages.

## Avancé : amorçage par export natif

Les scripts optionnels `stream-semantic-export.py` et `import-semantic-export.ts` importent un ZIP de tickets natif existant. Ils ne créent ni ne téléchargent d'export. Utiliser uniquement un export dont le traitement est autorisé. Conserver le ZIP et son manifeste privés ; aucun exemple réel ne doit entrer dans ce dépôt.

Créer le manifeste protégé `var/semantic-native-export.json` avec le `userId` source enregistré, l'identifiant du job existant dans `response.job.id` et la date UTC de l'instantané dans `payload.date_range.end_date`. Arrêter le worker API et lancer depuis la racine, avec les base et clé configurées :

```bash
python3 scripts/stream-semantic-export.py /path/to/tickets.zip | node --env-file=.env dist/scripts/import-semantic-export.js
```

Le lecteur accepte les tableaux de tickets natifs et produit un marqueur final de comptage. L'import exige au moins 2 Gio libres et un marqueur cohérent pour déclarer sa couverture complète. Il alimente seulement les identités du même tenant dont le `ticket_scope` Freshdesk courant vaut `1` ; les agents restreints gardent leur acquisition nominative API. La restitution reste soumise aux vérifications en direct. Reprendre un import interrompu depuis le même ZIP autorisé, contrôler l'état puis relancer le worker API. Aucun export, manifeste, requête de validation ou résultat réel n'est distribué ici.
