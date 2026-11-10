import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticIndex, passages } from "../src/semantic.js";
import { SecretManager } from "../src/crypto.js";
import { FreshdeskApiError, FreshdeskClient } from "../src/freshdesk/client.js";
import type { FreshdeskTicket, FreshdeskConversation } from "../src/freshdesk/types.js";

const indexes: SemanticIndex[]=[];
afterEach(()=>{ indexes.splice(0).forEach(i=>i.close());vi.unstubAllGlobals(); });
function setup() {
  const index=new SemanticIndex(":memory:",new SecretManager(new Uint8Array(32))); indexes.push(index);
  vi.stubGlobal("fetch",vi.fn(async (_url,init) => {
    const inputs=JSON.parse(init.body as string).input as string[];
    return new Response(JSON.stringify({data:inputs.map((_,i)=>({index:i,embedding:[1,...Array<number>(767).fill(0)]}))}));
  }));
  const ticket:FreshdeskTicket={id:1,subject:"Wi-Fi roaming",description_text:"Connection fails when changing room",created_at:new Date().toISOString(),updated_at:"2026-11-08T10:00:00Z",status:4,company_id:10};
  const conversations:FreshdeskConversation[]=[{id:100,body_text:"Changed the radio configuration and customer confirmed recovery",incoming:false,private:false}];
  const client={ getHistoricalTicket:vi.fn(async()=>ticket),historicalConversations:vi.fn(async()=>conversations),ticketUrl:(id:number)=>`https://example.freshdesk.com/a/tickets/${id}` };
  return {index,ticket,conversations,client:client as unknown as FreshdeskClient,mocks:client};
}
const query={query:"wifi change room",limit:5,mode:"similar" as const};
describe("semantic retrieval access and evidence",()=>{
  it("never crosses agent/tenant ownership",async()=>{const s=setup();await s.index.indexTicket("tenant|alice",s.ticket,s.conversations);expect((await s.index.search("tenant|bob",s.client,query)).matches).toEqual([]);expect(s.mocks.getHistoricalTicket).not.toHaveBeenCalled();});
  it("does not store plaintext passages",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);const rows=s.index.db.prepare("SELECT payload FROM passages").all();expect(JSON.stringify(rows)).not.toContain("radio configuration");});
  it("returns fresh, source-verified evidence",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);const result=await s.index.search("alice",s.client,{...query,mode:"solutions"});expect(result.matches).toHaveLength(1);expect(result.matches[0]!.sourceVerified).toBe(true);});
  it("fails closed and removes inaccessible tickets",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);s.mocks.getHistoricalTicket.mockRejectedValue(new FreshdeskApiError("denied",403,"access_denied",{}));expect((await s.index.search("alice",s.client,query)).matches).toEqual([]);expect(s.index.status("alice").tickets).toBe(0);});
  it("does not expose cached content during upstream outages",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);s.mocks.getHistoricalTicket.mockRejectedValue(new Error("offline"));expect((await s.index.search("alice",s.client,query)).matches).toEqual([]);expect(s.index.status("alice").tickets).toBe(1);});
  it("hides edited or deleted conversations until reindexed",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);s.mocks.historicalConversations.mockResolvedValue([]);expect((await s.index.search("alice",s.client,{...query,mode:"solutions"})).matches).toEqual([]);});
  it("excludes private notes by default, including unspecified visibility",async()=>{const s=setup();s.conversations[0]!.private=true;await s.index.indexTicket("alice",s.ticket,s.conversations);expect((await s.index.search("alice",s.client,{...query,mode:"wording"})).matches).toEqual([]);expect((await s.index.search("alice",s.client,{...query,mode:"wording",includePrivate:true})).matches).toHaveLength(1);expect(passages(s.ticket,[{id:99,body_text:"internal"}]).at(-1)!.private).toBe(true);});
  it("rechecks company membership and resolution status",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);s.ticket.company_id=20;expect((await s.index.search("alice",s.client,{...query,companyId:10})).matches).toEqual([]);s.ticket.status=2;expect((await s.index.search("alice",s.client,{...query,mode:"solutions"})).matches).toEqual([]);});
  it("replaces a ticket atomically without duplicate passages",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);await s.index.indexTicket("alice",s.ticket,s.conversations);expect(s.index.status("alice").tickets).toBe(1);expect(s.index.status("alice").passages).toBe(2);});
  it("rejects invalid embedding dimensions without publishing incomplete tickets",async()=>{const s=setup();vi.stubGlobal("fetch",async()=>new Response(JSON.stringify({data:[{index:0,embedding:[1]}]})));await expect(s.index.indexTicket("alice",s.ticket,s.conversations)).rejects.toThrow("dimensions");expect(s.index.status("alice").tickets).toBe(0);});
  it("does not publish recurring groups without two live accessible members",async()=>{const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);await s.index.indexTicket("alice",{...s.ticket,id:2,created_at:new Date(Date.now()-86400_000).toISOString()},s.conversations);s.mocks.getHistoricalTicket.mockRejectedValue(new Error("offline"));expect((await s.index.discover("alice",s.client,90,0.82,3)).groups).toEqual([]);});
});

describe("historical Freshdesk acquisition",()=>{
  it("falls back to archive only on 404 and paginates conversations",async()=>{
    const calls:string[]=[];
    const client=new FreshdeskClient({origin:"https://example.freshdesk.com",apiKey:"fake",fetchFn:async(input)=>{
      const url=new URL(String(input));calls.push(url.pathname);
      if(url.pathname.endsWith('/conversations')) return new Response(JSON.stringify(url.searchParams.get('page')==='1'?Array.from({length:30},(_,i)=>({id:i})):[]));
      if(url.pathname==='/api/v2/tickets/1') return new Response(JSON.stringify({code:'not_found'}),{status:404});
      return new Response(JSON.stringify({id:1,archived:true}));
    }});
    expect((await client.getHistoricalTicket(1)).archived).toBe(true);
    expect(await client.historicalConversations(1,true)).toHaveLength(30);
    expect(calls).toEqual(['/api/v2/tickets/1','/api/v2/tickets/archived/1','/api/v2/tickets/archived/1/conversations','/api/v2/tickets/archived/1/conversations']);
  });
  it("does not bypass permission refusals through archived endpoints",async()=>{
    const fetchFn=vi.fn(async()=>new Response(JSON.stringify({code:'access_denied'}),{status:403}));
    const client=new FreshdeskClient({origin:"https://example.freshdesk.com",apiKey:"fake",fetchFn});
    await expect(client.getHistoricalTicket(1)).rejects.toMatchObject({status:403});expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("document context",()=>{
  it("does not reuse identical agent replies across unrelated ticket subjects",async()=>{
    const s=setup();
    await s.index.indexTicket("alice",s.ticket,s.conversations);
    await s.index.indexTicket("alice",{...s.ticket,id:2,subject:"BitLocker recovery"},s.conversations);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
    const inputs=vi.mocked(fetch).mock.calls.map(call=>JSON.parse(call[1]!.body as string).input[0] as string);
    expect(inputs.some(input=>input.startsWith("title: BitLocker recovery | text:"))).toBe(true);
  });
});

import { normalizeExportRecord } from "../src/semantic-export.js";
describe("native export mapping",()=>{
  it("preserves API identifiers, company links, visibility and UTC dates",()=>{
    const {ticket,conversations}=normalizeExportRecord({helpdesk_ticket:{id:19000000000,display_id:42,owner_id:88,description:"Problem",subject:"Example",created_at:"2026-11-08T12:00:00+01:00",notes:[{id:999,body:"Fix",incoming:false,private:true},{id:1000,body:"removed",deleted:true}]}});
    expect(ticket.id).toBe(42);expect(ticket.company_id).toBe(88);expect(ticket.created_at).toBe("2026-11-08T11:00:00.000Z");
    expect(conversations).toHaveLength(1);expect(conversations[0]).toMatchObject({id:999,body_text:"Fix",private:true,incoming:false});
  });
  it("rejects exports without a usable display ID",()=>{expect(()=>normalizeExportRecord({helpdesk_ticket:{id:19000000000}})).toThrow("identifier");});
});

import { redactSupportSecrets } from "../src/semantic.js";
describe("sensitive support evidence",()=>{
  it("masks historical recovery keys before embedding and returning evidence",()=>{
    const key=Array.from({length:8},()=>"123456").join("-");
    const chunk=passages({id:1,subject:"BitLocker",description_text:`Recovery key: ${key}`} as FreshdeskTicket,[])[0]!;
    expect(chunk.text).not.toContain(key);expect(chunk.text).toContain("masqué");
  });
  it("masks inline credentials without erasing ordinary repair instructions",()=>{
    expect(redactSupportSecrets("Mot de passe : super-secret\nRéparer Microsoft 365 puis tester HP Scan.")).toBe("Mot de passe : [secret masqué]\nRéparer Microsoft 365 puis tester HP Scan.");
  });
});

import { supportSignalKind } from "../src/semantic.js";
describe("relevance and recurrence",()=>{
  it("abstains below the similarity threshold before reading source tickets",async()=>{
    const s=setup();await s.index.indexTicket("alice",s.ticket,s.conversations);
    vi.stubGlobal("fetch",async()=>new Response(JSON.stringify({data:[{index:0,embedding:[0,1,...Array<number>(766).fill(0)]}]})));
    const result=await s.index.search("alice",s.client,query);
    expect(result.matches).toEqual([]);expect(result.abstained).toBe(true);expect(s.mocks.getHistoricalTicket).not.toHaveBeenCalled();
  });
  it("separates recovery notices, losses and routine digests",()=>{
    expect(supportSignalKind("Alert for PARIS - APs came up")).toBe("monitoring_recovery");
    expect(supportSignalKind("Alert for PARIS - APs went down")).toBe("monitoring_loss");
    expect(supportSignalKind("Your weekly PIM digest for Example")).toBe("routine");
    expect(supportSignalKind("Scanner PDF par email en panne")).toBe("support");
  });
  it("excludes monitoring by default and reports distinct days without asserting incident counts",async()=>{
    const s=setup(),tickets=new Map<number,FreshdeskTicket>();
    for(let id=1;id<=4;id++) {const ticket={...s.ticket,id,subject:"Alert for PARIS - APs came up",created_at:new Date(Date.now()-(id%2)*86400_000).toISOString()};tickets.set(id,ticket);await s.index.indexTicket("alice",ticket,[]);}
    s.mocks.getHistoricalTicket.mockImplementation(async(id?:number)=>tickets.get(id??1)!);
    expect((await s.index.discover("alice",s.client,90,0.82,3)).groups).toHaveLength(0);
    const result=await s.index.discover("alice",s.client,90,0.82,3,{includeMonitoringAlerts:true});
    expect(result.groups).toHaveLength(1);expect(result.groups[0]).toMatchObject({signalKind:"monitoring_recovery",observedDistinctDays:2,commonCauseConfirmed:false});
  });
});

describe("support interaction signals",()=>{
  it("requires support exchanges by default while allowing unanswered requests explicitly",async()=>{
    const s=setup(),tickets=new Map<number,FreshdeskTicket>();
    for(let id=1;id<=2;id++){const ticket={...s.ticket,id,created_at:new Date(Date.now()-(id-1)*86400_000).toISOString()};tickets.set(id,ticket);await s.index.indexTicket("alice",ticket,[]);}
    s.mocks.getHistoricalTicket.mockImplementation(async(id?:number)=>tickets.get(id??1)!);
    expect((await s.index.discover("alice",s.client,90,0.82,3)).groups).toHaveLength(0);
    expect((await s.index.discover("alice",s.client,90,0.82,3,{includeUnansweredTickets:true})).groups).toHaveLength(1);
  });
  it("recognizes one-way security and raw telephony notifications",()=>{
    expect(supportSignalKind("NAS-EXEMPLE - Risques de sécurité détectés sur NAS-EXEMPLE")).toBe("monitoring");
    expect(supportSignalKind("Nouveau ticket","Answered incoming call from 001 to 002. Transcription: Summary:")).toBe("routine");
    expect(supportSignalKind("Nouveau ticket","Notre scanner ne peut plus envoyer de PDF")).toBe("support");
  });
});

import { incidentTopics } from "../src/semantic.js";
describe("incident evidence",()=>{
  it("recognizes repeated fibre symptoms and rejects unrelated commercial correspondence",()=>{
    expect(incidentTopics("Client Exemple - Connectivité Appliwave/Eurofiber","Nous avons des pertes du lien fibre depuis ce matin")).toContain("wan");
    expect(incidentTopics("Re: Intervention réseau interne + WIFI","Merci pour ton retour, je joins le devis correspondant")).toEqual([]);
    expect(incidentTopics("Demande d'info - Restaurant Exemple","Pourriez-vous dire de quoi il s'agit ?")).toEqual([]);
  });
});
