import { loadConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { SecretManager } from "../src/crypto.js";
import { FreshdeskApiError, FreshdeskClient } from "../src/freshdesk/client.js";
import { SemanticIndex, INDEX_FORMAT } from "../src/semantic.js";

const config=loadConfig(); const database=new AppDatabase(config.databasePath);
const secrets=new SecretManager(config.masterKey);
const index=new SemanticIndex(`${config.databasePath}.semantic.sqlite3`,secrets);
let lastCacheSweep=0;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function run() {
  const ids=database.listUserIds();
  const owners=ids.map(id=>{const user=database.getUser(id)!;return `${user.tenantOrigin}|${id}`;});
  for (const table of ["passages","indexed_tickets","sync_state"]) {
    for (const row of index.db.prepare(`SELECT DISTINCT owner FROM ${table}`).all() as Array<{owner:string}>) if (!owners.includes(row.owner)) index.db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(row.owner);
  }
  if(Date.now()-lastCacheSweep>3600_000) { index.db.exec("DELETE FROM embedding_cache WHERE hash NOT IN (SELECT fingerprint FROM passages)"); lastCacheSweep=Date.now(); }
  // Process a bounded slice per identity, then rotate, so one historical crawl cannot starve colleagues.
  for (const id of ids) {
    const user=database.getUser(id); if (!user) continue;
    const owner=`${user.tenantOrigin}|${id}`; const state=index.state(owner);
    try {
      const client=new FreshdeskClient({origin:user.tenantOrigin,apiKey:secrets.decrypt(user.encryptedApiKey,`user:${id}:api-key`)});
      await client.getMe();
      const latest=await client.listIndexTickets(1);
      const maximum=Math.max(Number(state.maximumId ?? 0),...latest.map(t=>Number(t.id)),0);
      if(state.initialScanComplete===true) {
        const startedAt=new Date().toISOString();
        const since=String(state.lastIncrementalAt ?? state.exportSnapshotAt ?? state.lastSyncAt ?? "1970-01-01T00:00:00Z");
        const overlap=new Date(Math.max(0,Date.parse(since)-120_000)).toISOString();
        for(let page=1;page<=300;page++) {
          const changed=await client.listChangedIndexTickets(overlap,page);
          for(const ticket of changed) {
            const full=await client.getHistoricalTicket(Number(ticket.id));
            if(full.deleted || full.spam) index.remove(owner,Number(ticket.id));
            else { const conversations=await client.historicalConversations(Number(ticket.id),full.archived===true); await index.indexTicket(owner,full,conversations); }
            await sleep(700);
          }
          if(changed.length<100) break;
          if(page===300) throw new Error("Incremental index pagination capped; checkpoint not advanced");
        }
        // Recheck a bounded set of older sources as well as timestamp-based changes.
        const stale=index.db.prepare("SELECT ticket FROM indexed_tickets WHERE owner=? AND checked<? ORDER BY checked LIMIT 20").all(owner,Date.now()-7*86400_000) as Array<{ticket:number}>;
        for(const {ticket:id} of stale) {
          try { const ticket=await client.getHistoricalTicket(id); const conversations=await client.historicalConversations(id,ticket.archived===true); if(ticket.deleted || ticket.spam) index.remove(owner,id); else await index.indexTicket(owner,ticket,conversations); }
          catch(error) { if(error instanceof FreshdeskApiError && [403,404].includes(error.status)) index.remove(owner,id); else throw error; }
          await sleep(700);
        }
        index.saveState(owner,{...state,state:"ready",maximumId:maximum,lastIncrementalAt:startedAt,lastSyncAt:new Date().toISOString()});
        continue;
      }
      // Keep recent changed tickets fresh while the archived backfill is still running.
      const recent=await client.listIndexTickets(1,"updated_at");
      for(const ticket of recent) {
        const row=index.db.prepare("SELECT updated,format FROM indexed_tickets WHERE owner=? AND ticket=?").get(owner,Number(ticket.id)) as {updated:string;format:number}|undefined;
        if(row && Date.parse(row.updated)===Date.parse(String(ticket.updated_at??"")) && row.format===INDEX_FORMAT) continue;
        const full=ticket.description_text || ticket.description ? ticket : await client.getHistoricalTicket(Number(ticket.id));
        const conversations=await client.historicalConversations(Number(ticket.id),full.archived===true);
        await index.indexTicket(owner,full,conversations); await sleep(700);
      }
      // First acquire actual listed ticket IDs, avoiding historical numeric gaps and making useful coverage available quickly.
      if (state.listComplete !== true) {
        const page=Number(state.listNextPage ?? 1);
        const batch=page===1?latest:await client.listIndexTickets(page);
        for(const [offset,ticket] of batch.entries()) {
          if(offset<Number(state.listOffset ?? 0)) continue;
          const full=ticket.description_text || ticket.description ? ticket : await client.getHistoricalTicket(Number(ticket.id));
          const conversations=await client.historicalConversations(Number(ticket.id),full.archived===true);
          await index.indexTicket(owner,full,conversations);
          index.saveState(owner,{...state,state:"indexing",phase:"listed_tickets",maximumId:maximum,listNextPage:page,listOffset:offset+1,lastSyncAt:new Date().toISOString()});
          await sleep(700);
        }
        index.saveState(owner,{...state,state:"indexing",phase:"listed_tickets",maximumId:maximum,listNextPage:page+1,listOffset:0,listComplete:batch.length<100 || page>=300,listPaginationCapped:page>=300 && batch.length===100,lastSyncAt:new Date().toISOString()});
        console.log(JSON.stringify({event:"listed_page_indexed",identity:ids.indexOf(id)+1,...index.status(owner)}));
        continue;
      }
      let cursor=typeof state.nextId === "number" ? state.nextId : maximum;
      let processed=0; let inaccessible=Number(state.inaccessibleIds ?? 0);
      while(cursor>0 && processed<100) {
        if (!database.getUser(id)) break;
        try {
          const existing=index.db.prepare("SELECT checked,format FROM indexed_tickets WHERE owner=? AND ticket=?").get(owner,cursor) as {checked:number;format:number}|undefined;
          if(existing && existing.format===INDEX_FORMAT && Date.now()-existing.checked<7*86400_000) { cursor--;processed++; continue; }
          const ticket=await client.getHistoricalTicket(cursor);
          if(ticket.deleted || ticket.spam) index.remove(owner,cursor);
          else { const conversations=await client.historicalConversations(cursor,ticket.archived===true); await index.indexTicket(owner,ticket,conversations); }
        } catch(error) {
          if(error instanceof FreshdeskApiError && [403,404].includes(error.status)) {index.remove(owner,cursor);inaccessible++;}
          else throw error;
        }
        cursor--;processed++;
        index.saveState(owner,{...state,phase:"historical_ids",state:cursor===0?"ready":"indexing",maximumId:maximum,nextId:cursor,initialScanComplete:cursor===0,lastFullScanAt:cursor===0?Date.now():state.lastFullScanAt??null,lastSyncAt:new Date().toISOString(),inaccessibleIds:inaccessible});
        if(processed%20===0) console.log(JSON.stringify({event:"index_progress",identity:ids.indexOf(id)+1,...index.status(owner)}));
        await sleep(700);
      }
      // Persist even when the entire slice reused already indexed tickets.
      index.saveState(owner,{...state,phase:"historical_ids",state:cursor===0?"ready":"indexing",maximumId:maximum,nextId:cursor,initialScanComplete:cursor===0,lastFullScanAt:cursor===0?Date.now():state.lastFullScanAt??null,lastSyncAt:new Date().toISOString(),inaccessibleIds:inaccessible});
    } catch(error) {
      const current=index.state(owner);
      index.saveState(owner,{...current,state:"retrying",lastErrorAt:new Date().toISOString(),errorCode:error instanceof FreshdeskApiError ? error.code : "indexing_error",httpStatus:error instanceof FreshdeskApiError?error.status:null});
      console.log(JSON.stringify({event:"index_retry",identity:ids.indexOf(id)+1,httpStatus:error instanceof FreshdeskApiError?error.status:null}));
      if(error instanceof FreshdeskApiError && error.status===429) await sleep(Math.min(300_000,Math.max(60_000,(error.rateLimit.retryAfterSeconds??60)*1000)));
    }
  }
}
try { for(;;) { await run(); await sleep(30_000); } }
finally { index.close(); database.close(); }
