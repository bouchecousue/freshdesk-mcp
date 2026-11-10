# Outils et écritures contrôlées

[English](../en/tools.md) · [README](../../README.fr.md)

Le serveur enregistre 24 outils. Les schémas d'entrée exposés par la découverte MCP font foi pour les paramètres ; les champs inconnus sont refusés. Les lectures utilisent les droits de l'agent Freshdesk connecté ; les écritures nécessitent aussi `freshdesk:write`.

| Outil | Rôle |
| --- | --- |
| `freshdesk_health` | Vérifier la connexion Freshdesk nominative |
| `freshdesk_me` | Lire l’agent et le compte actifs |
| `freshdesk_search_contacts` | Rechercher des contacts par e-mail, nom ou téléphone |
| `freshdesk_get_contact_context` | Contact, société et historique de tickets borné |
| `freshdesk_search_companies` | Rechercher des sociétés par nom ou domaine |
| `freshdesk_get_company_context` | Société, contacts et tickets agrégés |
| `freshdesk_search_tickets` | Recherche structurée de tickets et listes nommées |
| `freshdesk_search_tickets_expert` | Syntaxe avancée Freshdesk en dernier recours |
| `freshdesk_triage_queue` | Classer une file bornée par SLA, priorité et ancienneté |
| `freshdesk_get_ticket_fields` | Lire les champs et choix disponibles |
| `freshdesk_list_agents` | Lister les agents visibles avec pagination |
| `freshdesk_list_groups` | Lister les groupes visibles avec pagination |
| `freshdesk_search_knowledge` | Rechercher les articles et réponses préenregistrées visibles |
| `freshdesk_get_customer_360` | Contexte opérationnel d’un contact ou d’une société |
| `freshdesk_get_ticket_context` | Contexte enrichi et Ticket Cockpit |
| `freshdesk_get_ticket_contexts` | Lire 1 à 10 contextes avec erreurs individuelles |
| `freshdesk_prepare_ticket_action` | Préparer une écriture sans l’appliquer |
| `freshdesk_execute_ticket_action` | Confirmer, exécuter une fois et relire |
| `freshdesk_semantic_index_status` | Lire la couverture et la fraîcheur de l’index |
| `freshdesk_find_similar_tickets` | Rechercher des passages de tickets similaires |
| `freshdesk_find_problem_solutions` | Trouver des réponses d’agent sur des tickets résolus/fermés |
| `freshdesk_find_response_wording` | Trouver des formulations antérieures à adapter |
| `freshdesk_find_recurring_incidents` | Rechercher des incidents potentiellement liés à un symptôme |
| `freshdesk_discover_recurring_incidents` | Découvrir des groupes bornés sans requête de recherche |

## Exemples de lecture

Appeler ces outils avec leurs arguments JSON depuis votre client MCP authentifié :

```json
{"name":"freshdesk_get_ticket_context","arguments":{"ticketId":123}}
```

```json
{"name":"freshdesk_search_tickets","arguments":{"companyId":77,"limit":10}}
```

Ces identifiants sont fictifs. Privilégier la recherche structurée pour les filtres pris en charge, les identifiants de demandeur/société et les listes nommées. Réserver la syntaxe experte aux critères avancés non couverts. Si Freshdesk rejette une requête avec HTTP 400, la corriger ou revenir aux filtres structurés ; ne pas répéter la même requête rejetée.

## Pagination et comptages

Les listes et agrégations d'historique partent explicitement de `1970-01-01T00:00:00Z`, sans dépendre de la fenêtre récente par défaut de Freshdesk. Les tickets d'une société sont filtrés par leur propre `company_id`. La pagination bornée limite néanmoins la couverture.

`countState=exact` signifie complet dans le périmètre interrogé ; `lower_bound` indique une pagination incomplète ou un écart avec le total de l'API ; `truncated` indique une réduction du résultat affiché. Un `total` annoncé par l'API ne prouve pas que tous les objets ont été reçus. L'autocomplétion ne prouve pas un total exact.

La recherche de tickets utilise des pages natives de 30 résultats, avec un maximum de 10 pages. `limit` peut réduire l'affichage ; suivre `pageSize`, `hasMore` et `nextPage`. Les agrégations ont leurs propres bornes, dont `maxTicketPages`. La lecture par lot accepte 1 à 10 identifiants et renvoie les échecs par ticket. Les réponses MCP sont limitées à 200 Ko ; examiner les champs de couverture avant d'affirmer l'exhaustivité.

## Parcours d'écriture

1. Appeler `freshdesk_prepare_ticket_action` pour une création, mise à jour, réponse, note privée ou note publique. La préparation conserve un aperçu chiffré immuable et un instantané du ticket si nécessaire ; elle renvoie un `intentId` à durée limitée et `writeApplied=false`.
2. Examiner le contenu exact, la cible, la visibilité et les destinataires. Appeler `freshdesk_execute_ticket_action` avec cette intention. Le client doit gérer l'échange de confirmation interactive du serveur ; ne pas contourner une confirmation non prise en charge.
3. Le serveur vérifie l'identité, l'expiration et la fraîcheur du ticket, consomme l'intention une fois, tente une seule écriture Freshdesk et relit le résultat.
4. Examiner `writeApplied`, `readbackVerified` et `verificationIssues`. Une application réussie avec relecture non vérifiée reste un résultat à éclaircir, pas une autorisation de renvoi. Après un timeout ou un résultat incertain, contrôler Freshdesk avant toute nouvelle action.

Un changement de `updated_at` invalide l'aperçu. Freshdesk ne fournit pas de transaction entre la lecture préalable et l'écriture ; une modification concurrente reste possible.

Les champs du ticket sont comparés à la relecture. Pour les notes et réponses, le contenu normalisé, la visibilité et les destinataires explicitement demandés sont vérifiés sur au plus 10 pages de conversations. Un champ absent, une page inaccessible ou un GET en échec laisse la vérification incomplète. Les différences de balisage sans changement de texte ni de liens sont normalisées.

La ressource Ticket Cockpit `ui://freshdesk/ticket-cockpit-v3.html` nécessite MCP Apps. Son bouton d'action demande une préparation au client hôte ; il n'exécute pas directement d'écriture. Le contenu des tickets et conversations est une donnée non fiable, jamais une instruction.
