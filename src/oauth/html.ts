function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface PageOptions {
  title: string;
  heading: string;
  body: string;
  nonce: string;
}

export function renderPage(options: PageOptions): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style nonce="${escapeHtml(options.nonce)}">
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f5f7; color: #151719; padding: 24px; }
    main { width: min(100%, 520px); background: #fff; border: 1px solid #dfe3e6; border-radius: 18px; padding: 32px; box-shadow: 0 18px 50px rgba(18, 28, 38, .10); }
    .brand { display: inline-flex; align-items: center; gap: 10px; color: #44515c; font-size: 13px; font-weight: 650; letter-spacing: .02em; }
    .mark { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: white; background: #0b6e4f; font-weight: 800; }
    h1 { font-size: 28px; line-height: 1.15; margin: 22px 0 10px; letter-spacing: -.025em; }
    p { color: #4c5964; line-height: 1.55; }
    label { display: block; margin: 18px 0 7px; font-size: 14px; font-weight: 650; }
    input { width: 100%; border: 1px solid #b9c2c9; border-radius: 10px; padding: 12px 13px; font: inherit; color: inherit; background: white; }
    input:focus { outline: 3px solid rgba(11, 110, 79, .18); border-color: #0b6e4f; }
    .hint { margin-top: 6px; font-size: 12px; color: #64717c; }
    .notice { margin: 18px 0; padding: 13px 14px; border-radius: 10px; background: #eef7f3; color: #185d47; font-size: 13px; line-height: 1.45; }
    .error { margin: 18px 0; padding: 13px 14px; border-radius: 10px; background: #fff0f0; color: #9c2525; font-size: 13px; line-height: 1.45; }
    .actions { display: flex; gap: 10px; margin-top: 24px; }
    button { border: 0; border-radius: 10px; padding: 12px 16px; font: inherit; font-weight: 700; cursor: pointer; }
    button.primary { flex: 1; background: #0b6e4f; color: white; }
    button.secondary { background: #e8ecef; color: #303a42; }
    code { font-size: .92em; }
    footer { margin-top: 22px; padding-top: 18px; border-top: 1px solid #e7eaec; color: #74808a; font-size: 12px; line-height: 1.45; }
    @media (prefers-color-scheme: dark) {
      body { background: #101416; color: #f4f6f7; }
      main { background: #181e21; border-color: #313a3f; box-shadow: none; }
      p, .hint { color: #aeb9bf; }
      input { background: #111719; border-color: #536067; }
      .notice { background: #18352c; color: #b5ead7; }
      .error { background: #3c2020; color: #ffc5c5; }
      .actions .secondary { background: #30393e; color: #e5e9eb; }
      footer { border-color: #30383c; color: #96a2a9; }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark">F</span> Freshdesk MCP · BoucheCousue</div>
    <h1>${escapeHtml(options.heading)}</h1>
    ${options.body}
  </main>
</body>
</html>`;
}

export function renderConnectionForm(input: {
  nonce: string;
  requestId: string;
  clientName: string;
  scopes: string[];
  error?: string;
  tenant?: string;
}): string {
  const error = input.error ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>` : "";
  const scopes = input.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(", ");
  return renderPage({
    title: "Connecter Freshdesk",
    heading: "Connecter votre compte Freshdesk",
    nonce: input.nonce,
    body: `
      <p><strong>${escapeHtml(input.clientName)}</strong> demande l’accès à Freshdesk avec votre identité d’agent.</p>
      <div class="notice">Freshdesk utilise une clé API personnelle pour son API v2. Elle sera chiffrée sur ce serveur MCP et ne sera jamais transmise à ChatGPT.</div>
      ${error}
      <form method="post" action="/oauth/authorize" autocomplete="off">
        <input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
        <label for="tenant">Domaine Freshdesk natif</label>
        <input id="tenant" name="tenant" type="text" required maxlength="253" value="${escapeHtml(input.tenant ?? "")}" placeholder="monentreprise.freshdesk.com" autocapitalize="none" spellcheck="false">
        <div class="hint">Utilisez le domaine <code>*.freshdesk.com</code>, pas une adresse personnalisée.</div>
        <label for="api_key">Clé API personnelle</label>
        <input id="api_key" name="api_key" type="password" required maxlength="1000" autocomplete="off">
        <div class="hint">Freshdesk → Profil → Paramètres du profil → Votre clé API.</div>
        <p class="hint">Autorisations demandées : ${scopes}</p>
        <div class="actions">
          <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Annuler</button>
          <button class="primary" type="submit" name="decision" value="allow">Vérifier et autoriser</button>
        </div>
      </form>
      <footer>Les droits disponibles resteront ceux de votre rôle Freshdesk. Toute écriture exige une confirmation distincte dans ChatGPT.</footer>
    `,
  });
}

export function renderCompletion(input: { nonce: string; agentName: string; tenantOrigin: string }): string {
  return renderPage({
    title: "Freshdesk connecté",
    heading: "Connexion réussie",
    nonce: input.nonce,
    body: `
      <p>Le compte <strong>${escapeHtml(input.agentName)}</strong> est connecté à <strong>${escapeHtml(input.tenantOrigin)}</strong>.</p>
      <div class="notice">Vous pouvez fermer cette fenêtre et revenir dans ChatGPT.</div>
      <footer>La clé Freshdesk reste chiffrée sur ce serveur MCP.</footer>
    `,
  });
}
