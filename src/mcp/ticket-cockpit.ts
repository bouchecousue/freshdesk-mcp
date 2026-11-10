export const TICKET_COCKPIT_URI = "ui://freshdesk/ticket-cockpit-v3.html";
export const TICKET_COCKPIT_MIME_TYPE = "text/html;profile=mcp-app";

export const TICKET_COCKPIT_HTML = String.raw`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{color-scheme:light dark;--bg:#f6f7f4;--card:#fff;--ink:#17221f;--muted:#65716d;--line:#dce3df;--accent:#0b755d;--warn:#9a4d00;--danger:#aa2430;--soft:#e9f4f0}
    @media(prefers-color-scheme:dark){:root{--bg:#111714;--card:#19211e;--ink:#f3f7f5;--muted:#aab7b1;--line:#35413c;--accent:#6bd7b6;--warn:#ffbd73;--danger:#ff8992;--soft:#203c33}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}.shell{padding:16px;display:grid;gap:12px}.hero,.panel{background:var(--card);border:1px solid var(--line);border-radius:16px}.hero{padding:16px}.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.eyebrow{font-size:12px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}.title{margin:3px 0 10px;font-size:21px;line-height:1.2}.badges{display:flex;gap:6px;flex-wrap:wrap}.badge{background:var(--soft);color:var(--accent);border-radius:999px;padding:4px 8px;font-weight:650}.badge.warn{color:var(--warn)}.badge.danger{color:var(--danger)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.panel{padding:14px}.panel h2{font-size:13px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.metric{font-size:22px;font-weight:750}.label{color:var(--muted);font-size:12px}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.fact{border-top:1px solid var(--line);padding-top:8px}.timeline{display:grid;gap:8px}.event{border-left:3px solid var(--line);padding:7px 10px;background:color-mix(in srgb,var(--card) 80%,var(--bg));border-radius:0 10px 10px 0}.event.private{border-color:var(--warn)}.meta{color:var(--muted);font-size:12px;margin-bottom:3px}.body{white-space:pre-wrap;overflow-wrap:anywhere}.actions{display:flex;gap:8px;flex-wrap:wrap}.button{appearance:none;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit;font-weight:650;padding:9px 12px;cursor:pointer;text-decoration:none}.button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.empty{color:var(--muted)}.error{padding:18px;color:var(--danger)}
    @media(max-width:700px){.grid{grid-template-columns:1fr}.facts{grid-template-columns:1fr}.top{display:block}.actions{margin-top:12px}}
  </style>
</head>
<body><main id="app" class="shell" aria-live="polite"><section class="panel">Chargement du cockpit…</section></main>
<script>
  const app=document.getElementById("app");let latest=null;let nextId=1;const pending=new Map();
  const notify=(method,params={})=>window.parent.postMessage({jsonrpc:"2.0",method,params},"*");
  const esc=(v)=>String(v??"").replace(/[&<>\"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const date=(v)=>v?new Intl.DateTimeFormat(document.documentElement.lang||"fr-FR",{dateStyle:"medium",timeStyle:"short"}).format(new Date(v)):"—";
  const request=(method,params)=>{const id=nextId++;window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*");return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));};
  function sendFollowUp(text){
    if(window.openai&&typeof window.openai.sendFollowUpMessage==="function")return window.openai.sendFollowUpMessage({prompt:text});
    return request("ui/message",{role:"user",content:[{type:"text",text}]});
  }
  function render(data){
    latest=data;if(!data||!data.ticket){app.innerHTML='<section class="error">Le contexte ticket est indisponible.</section>';return;}
    const t=data.ticket, conv=Array.isArray(data.conversations)?data.conversations:[], entries=Array.isArray(data.timeEntries)?data.timeEntries:[], ratings=Array.isArray(data.satisfactionRatings)?data.satisfactionRatings:[];
    const overdue=t.dueBy&&new Date(t.dueBy)<new Date()&&!([4,5].includes(Number(t.status)));
    const sla=overdue?'<span class="badge danger">SLA dépassé</span>':(t.escalated?'<span class="badge warn">Escaladé</span>':'');
    const attachments=[...(Array.isArray(t.attachments)?t.attachments:[]),...conv.flatMap((c)=>Array.isArray(c.attachments)?c.attachments:[])];
    const timeline=conv.slice(-12).reverse().map((c)=>'<article class="event '+(c.private?'private':'')+'"><div class="meta">'+(c.private?'Note privée':'Échange public')+' · '+esc(date(c.createdAt))+'</div><div class="body">'+esc(c.bodyText||'—')+'</div></article>').join('');
    app.setAttribute("data-llm","Ticket "+t.id+" — "+(t.subject||"")+" — statut "+(t.statusLabel||t.status||"inconnu"));
    app.innerHTML='<section class="hero"><div class="top"><div><div class="eyebrow">Ticket #'+esc(t.id)+'</div><h1 class="title">'+esc(t.subject||'Sans objet')+'</h1><div class="badges"><span class="badge">'+esc(t.statusLabel||t.status||'Statut inconnu')+'</span><span class="badge">'+esc(t.priorityLabel||t.priority||'Priorité inconnue')+'</span>'+sla+'</div></div><div class="actions">'+(t.freshdeskUrl?'<a class="button" id="open-native" href="'+esc(t.freshdeskUrl)+'" target="_blank" rel="noreferrer">Ouvrir Freshdesk</a>':'')+'<button class="button primary" id="prepare">Préparer une action</button></div></div></section>'+
      '<section class="grid"><article class="panel"><h2>Client</h2><div class="metric">'+esc(t.requester&&t.requester.name||'Non chargé')+'</div><div class="label">'+esc(t.requester&&t.requester.email||'')+'</div><div class="label">'+esc(t.company&&t.company.name||'Sans société')+'</div></article><article class="panel"><h2>SLA</h2><div class="metric">'+(overdue?'Dépassé':'Sous contrôle')+'</div><div class="label">Échéance '+esc(date(t.dueBy))+'</div><div class="label">1re réponse '+esc(date(t.firstResponseDueBy))+'</div></article><article class="panel"><h2>Historique client</h2><div class="metric">'+esc(data.customerHistory&&data.customerHistory.total||0)+'</div><div class="label">tickets parcourus · couverture '+esc(data.customerHistory&&data.customerHistory.countState||'inconnue')+'</div></article></section>'+
      '<section class="grid"><article class="panel"><h2>Attribution</h2><div class="facts"><div class="fact"><div class="label">Agent</div>'+esc(t.responderId||'Non assigné')+'</div><div class="fact"><div class="label">Groupe</div>'+esc(t.groupId||'Non assigné')+'</div><div class="fact"><div class="label">Source</div>'+esc(t.sourceLabel||t.source||'—')+'</div><div class="fact"><div class="label">Mise à jour</div>'+esc(date(t.updatedAt))+'</div></div></article><article class="panel"><h2>Pièces jointes</h2>'+(attachments.length?attachments.slice(0,10).map((a)=>'<div>'+esc(a.name||'Fichier')+' <span class="label">'+esc(a.contentType||'')+'</span></div>').join(''):'<div class="empty">Aucune</div>')+'</article><article class="panel"><h2>Temps & satisfaction</h2><div class="metric">'+entries.length+'</div><div class="label">entrées de temps</div><div class="metric" style="margin-top:8px">'+ratings.length+'</div><div class="label">évaluations</div></article></section>'+
      '<section class="panel"><h2>Description</h2><div class="body">'+esc(t.descriptionText||'Aucune description')+'</div></section><section class="panel"><h2>Conversation · '+conv.length+'</h2><div class="timeline">'+(timeline||'<div class="empty">Aucun échange</div>')+'</div></section>';
    const prepare=document.getElementById("prepare");if(prepare)prepare.onclick=()=>sendFollowUp("Pour le ticket Freshdesk #"+t.id+", propose-moi la prochaine action puis prépare-la sans l’exécuter. Attends ma confirmation explicite avant toute écriture.");
  }
  window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const m=event.data;if(!m||m.jsonrpc!=="2.0")return;if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);return;}if(m.method==="ui/notifications/tool-result")render(m.params&&m.params.structuredContent);},{passive:true});
  if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);
  request("ui/initialize",{appInfo:{name:"freshdesk-ticket-cockpit",version:"0.3.4"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"})
    .then(()=>notify("ui/notifications/initialized"))
    .catch(()=>{app.innerHTML='<section class="error">Le cockpit n’a pas pu s’initialiser dans cette application.</section>';});
</script></body></html>`;
