# Optional local semantic search

[Français](../fr/semantic-search.md) · [README](../../README.md)

Ordinary Freshdesk tools work without an embedding service or indexing worker. Six semantic tools are registered but searches require a populated index and a compatible local embedding runtime.

## Enable indexing

1. Install a local embedding runtime separately. The code requests model `ggml-org/embeddinggemma-2-GGUF:Q8_0`, expects **768 finite float values** per vector, and uses `task: search result | query: …` / `title: … | text: …` input prefixes. A server exposing an OpenAI-style endpoint must actually serve the matching model and preprocessing; arbitrary embeddings are not interchangeable. Model weights and runtime are not included; check their licenses.
2. Bind it to `127.0.0.1`, normally port `9932`. Set `FRESHDESK_EMBEDDING_URL` if needed: only HTTP on `127.0.0.1` is accepted. Do not publish this endpoint.
3. Connect at least one agent via OAuth. The worker reads registered identities and their encrypted credentials from the application database.
4. After `npm run build`, start a separate process using the same database, environment and master key:

```bash
node --env-file=.env dist/scripts/index-semantic.js
```

5. Run `freshdesk_semantic_index_status` as each agent and inspect coverage before using the results. Supervise the worker independently of the MCP server.

The index lives at `${DATABASE_PATH}.semantic.sqlite3`. Keep it and its WAL/SHM files outside Git and protect them like the application database. Store the master key separately. Stop workers before maintenance or native import.

## Coverage and access

Each `tenant|userId` has a separate index partition. The worker first acquires listed tickets, then scans historical IDs up to the observed maximum, including the archive endpoint. Subsequent passes fetch changed tickets with an overlapping checkpoint and recheck a bounded sample of older sources. Conversations have a 300-page safety cap; exceeding it fails instead of publishing a partial ticket.

`initialScanComplete` describes a completed acquisition pass, never proof that all tenant data is visible. Numerical gaps, agent permissions and the observed maximum constrain coverage. Attachments are not indexed. API quotas and model throughput can make the initial crawl expensive; monitor progress and rate limits.

Search re-reads tickets and conversations using the current agent key and checks that the quoted passage still matches. Edited, deleted, newly private or inaccessible cached evidence is withheld. Discovery verifies the current ticket description. Revoked identities are purged on a later worker pass; stopped workers do not perform cleanup.

Passage content is encrypted; vectors, operational metadata, IDs and HMAC fingerprints are not encrypted at application level. Treat the entire index as sensitive. Secret masking is heuristic and does not anonymize customer content.

## Interpreting results

The four query tools accept `query`, `limit` (1–10), `companyId`, `createdFrom`, `includePrivate` (false by default) and `minimumSimilarity` (default `0.72`). Empty results can expose `abstained=true`. Similarity is not confidence. Closed/resolved tickets do not prove that a suggested fix worked. Prior response wording must be adapted and must not reveal another customer's details.

Query-free discovery examines at most 300 eligible recent descriptions and returns bounded groups, normally within a known company across multiple Europe/Paris calendar days. Default threshold: `0.9`; range: `0.7`–`0.99`. Unanswered tickets, monitoring alerts, cross-company groups and same-day groups require explicit options. These are heuristic shared symptoms, not confirmed root causes or exhaustive incident counts. Use structured tools for exact IDs, SLA and counts.

## Advanced: native export bootstrap

The optional `stream-semantic-export.py` and `import-semantic-export.ts` scripts import an existing native ticket ZIP. They do not create or download an export. Only use an export you are authorized to process. Keep it and its manifest private; do not add real examples to this repository.

Create a protected `var/semantic-native-export.json` manifest with your registered source `userId`, the existing export job ID under `response.job.id`, and the UTC snapshot timestamp under `payload.date_range.end_date`. Stop the API worker and run from the repository root, with the configured database and master key:

```bash
python3 scripts/stream-semantic-export.py /path/to/tickets.zip | node --env-file=.env dist/scripts/import-semantic-export.js
```

The streamer accepts native ticket arrays and a final record-count trailer. Import requires at least 2 GiB free space and a matching trailer to mark coverage complete. It populates only same-tenant identities whose live Freshdesk `ticket_scope` is `1`; restricted users retain agent-specific API acquisition. Live checks still gate search output. Resume an interrupted import from the same authorized ZIP, inspect status, then restart the API worker. No export data, manifest, validation queries or results are distributed here.
