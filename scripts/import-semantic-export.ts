import { createInterface } from "node:readline";
import { readFileSync, statfsSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { SecretManager } from "../src/crypto.js";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { SemanticIndex, INDEX_FORMAT, passages } from "../src/semantic.js";
import { normalizeExportRecord } from "../src/semantic-export.js";

const config = loadConfig(), database = new AppDatabase(config.databasePath), secrets = new SecretManager(config.masterKey);
const index = new SemanticIndex(`${config.databasePath}.semantic.sqlite3`, secrets);
const record = JSON.parse(readFileSync("var/semantic-native-export.json", "utf8")) as { userId: string; response: {job:{id:number}}; payload:{date_range:{end_date:string}} };
const source = database.getUser(record.userId);
if (!source) throw new Error("Export source identity is revoked");
const targets: string[] = [];
for (const id of database.listUserIds()) {
  const user = database.getUser(id)!;
  if (user.tenantOrigin !== source.tenantOrigin) continue;
  const client = new FreshdeskClient({origin:user.tenantOrigin, apiKey:secrets.decrypt(user.encryptedApiKey,`user:${id}:api-key`)});
  const agent = await client.getMe();
  // Only all-ticket agent scopes can bootstrap from the tenant export. Restricted users keep
  // their nominative API crawl. All search outputs still require live ticket/conversation access.
  if (agent.ticket_scope !== 1) continue;
  targets.push(`${user.tenantOrigin}|${id}`);
}
if (!targets.length) throw new Error("No eligible all-ticket identity");
let total = 0, eligible = 0, imported = 0, maximum = 0;
let batch: ReturnType<typeof normalizeExportRecord>[] = [];
async function flush() {
  if (!batch.length) return;
  const disk = statfsSync("var");
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error("Insufficient disk space; import checkpoint preserved");
  const pending = batch.filter(({ticket})=>targets.some(owner=>{
    const row=index.db.prepare("SELECT updated,format FROM indexed_tickets WHERE owner=? AND ticket=?").get(owner,Number(ticket.id)) as {updated:string;format:number}|undefined;
    return !row || Date.parse(row.updated)!==Date.parse(String(ticket.updated_at??"")) || row.format!==INDEX_FORMAT;
  }));
  await index.warmCache(pending.flatMap(({ticket,conversations})=>passages(ticket,conversations).map(p=>({text:p.text,title:String(ticket.subject??"")}))));
  for (const {ticket,conversations} of pending) {
    for (const owner of targets) {
      if (!database.getUser(owner.split("|").at(-1)!)) throw new Error("Target identity revoked during import");
      await index.indexTicket(owner,ticket,conversations);
    }
    imported++;
  }
  for (const owner of targets) index.saveState(owner,{state:"indexing",phase:"native_export",exportJobId:record.response.job.id,exportSnapshotAt:record.payload.date_range.end_date,exportRecordsRead:total,exportEligibleRead:eligible,maximumId:maximum,initialScanComplete:false,lastSyncAt:new Date().toISOString()});
  console.log(JSON.stringify({event:"export_import_progress",records:total,eligible,imported,targetIdentities:targets.length,maximumId:maximum}));
  batch = [];
}
try {
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  let declaredTotal: number | null = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const raw=JSON.parse(line) as Record<string,unknown>;
    if (raw._exportTrailer === true) { declaredTotal=Number(raw.total); continue; }
    const normalized=normalizeExportRecord(raw);total++;maximum=Math.max(maximum,Number(normalized.ticket.id));
    if (normalized.ticket.deleted || normalized.ticket.spam) { for(const owner of targets) index.remove(owner,Number(normalized.ticket.id)); continue; }
    eligible++;batch.push(normalized);if(batch.length>=100) await flush();
  }
  await flush();
  if (declaredTotal === null || declaredTotal !== total) throw new Error("Export stream incomplete; coverage remains partial");
  for (const owner of targets) index.saveState(owner,{state:"ready",phase:"native_export",exportJobId:record.response.job.id,exportSnapshotAt:record.payload.date_range.end_date,exportRecords:total,exportEligibleTickets:eligible,maximumId:maximum,nextId:0,listComplete:true,initialScanComplete:true,lastFullScanAt:Date.now(),lastSyncAt:new Date().toISOString()});
  console.log(JSON.stringify({event:"export_import_complete",records:total,eligible,imported,targetIdentities:targets.length}));
} finally { index.close();database.close(); }
