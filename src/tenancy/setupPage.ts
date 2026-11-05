/**
 * GET /setup - a single self-contained page over the management API, so an
 * organization can connect the app without curl:
 *   1. copy its manifest into Deeluge,
 *   2. paste the signing secret Deeluge gives it,
 *   3. see which workspaces installed it, adjust settings, manage keys.
 * With an admin key it also lists every organization and creates new ones.
 *
 * Everything is rendered with textContent (never innerHTML with data), and the
 * key is kept in sessionStorage only.
 */
export const SETUP_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Company Categorizer setup</title>
<style>
  :root { --bg:#f6f6f4; --card:#fff; --ink:#1d1d1b; --muted:#6b6b66; --line:#e3e2dd; --accent:#2f5bd3; --ok:#1f8a4c; --warn:#b26b00; --bad:#c23b2b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --card:#1e1e1c; --ink:#ecebe6; --muted:#9a9993; --line:#33322f; --accent:#7d9bff; --ok:#4cc27f; --warn:#e0a24a; --bad:#ff7a6b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 0 0 12px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  label { display:block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
  input[type=text], input[type=password], textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); font: inherit; }
  textarea { font: 12px/1.45 ui-monospace, Menlo, monospace; min-height: 220px; }
  button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); }
  button.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
  .row { display:flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
  table { width:100%; border-collapse: collapse; font-size: 14px; } th, td { text-align:left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .pill { display:inline-block; font-size:12px; padding: 1px 8px; border-radius: 999px; border:1px solid currentColor; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  .step { display:flex; gap: 12px; } .num { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color:#fff; display:grid; place-items:center; font-size: 13px; }
  .secret { font: 13px ui-monospace, Menlo, monospace; background: var(--bg); border: 1px dashed var(--warn); padding: 8px; border-radius: 6px; word-break: break-all; }
  #msg { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 6px; display:none; max-width: 90vw; }
  a { color: var(--accent); } code { font-size: 13px; }
  .checks label { display:flex; gap: 8px; align-items:center; color: var(--ink); font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Company Categorizer</h1>
  <p class="sub">Connect the categorizer to a Deeluge workspace.</p>
  <section id="signin" class="card">
    <h2>Sign in</h2>
    <label for="key">Your categorizer API key (organization or admin)</label>
    <input id="key" type="password" autocomplete="off" placeholder="cc_live_…">
    <div class="row"><button id="go">Continue</button></div>
  </section>
  <div id="app"></div>
</main>
<div id="msg"></div>
<script>
(() => {
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  let KEY = '';
  try { KEY = sessionStorage.getItem('cc_key') || ''; } catch (e) {}

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === 'class') n.className = v; else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
    return n;
  }
  function toast(t) { const m = $('#msg'); m.textContent = t; m.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (m.style.display = 'none'), 4000); }
  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
    return data;
  }
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed: select and copy by hand'));
  const status = (s) => el('span', { class: 'pill ' + (s === 'ready' ? 'ok' : s === 'disabled' ? 'bad' : 'warn') }, s === 'ready' ? 'Ready' : s === 'disabled' ? 'Disabled' : 'Needs signing secret');
  function oneTimeKey(key) {
    return el('div', { class: 'card' }, el('h2', {}, 'New API key: copy it now'),
      el('p', { class: 'muted' }, 'It is shown only once. Give it to the organization so it can manage its connection here.'),
      el('div', { class: 'secret' }, key), el('div', { class: 'row' }, el('button', { on: { click: () => copy(key) } }, 'Copy key')));
  }

  async function start() {
    if (!KEY) return;
    try {
      const me = await api('GET', '/v1/me');
      $('#signin').style.display = 'none';
      if (me.role === 'admin') return adminHome();
      return detail(me.registration.id, false);
    } catch (e) { toast(e.message); }
  }
  $('#go').addEventListener('click', () => { KEY = $('#key').value.trim(); try { sessionStorage.setItem('cc_key', KEY); } catch (e) {} start(); });

  async function adminHome(extra) {
    const { data } = await api('GET', '/v1/registrations');
    app.replaceChildren();
    if (extra) app.append(extra);
    const name = el('input', { type: 'text', placeholder: 'e.g. Ridgeline Capital' });
    const secret = el('input', { type: 'password', placeholder: 'whsec_… (optional, can be added later)' });
    app.append(el('section', { class: 'card' }, el('h2', {}, 'Add an organization'),
      el('label', {}, 'Organization name'), name, el('label', {}, 'Signing secret of their Deeluge app'), secret,
      el('div', { class: 'row' }, el('button', { on: { click: async () => {
        try {
          const out = await api('POST', '/v1/registrations', { name: name.value, signing_secret: secret.value || undefined });
          await detail(out.registration.id, true, oneTimeKey(out.api_key));
        } catch (e) { toast(e.message); }
      } } }, 'Create'))));
    app.append(el('section', { class: 'card' }, el('h2', {}, 'Organizations'),
      data.length ? el('table', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Status'), el('th', {}, 'Last request'), el('th', {})),
        data.map((r) => el('tr', {}, el('td', {}, r.name, el('div', { class: 'muted' }, r.id)), el('td', {}, status(r.status)),
          el('td', { class: 'muted' }, r.lastRequestAt ? new Date(r.lastRequestAt).toLocaleString() : 'never'),
          el('td', {}, el('button', { class: 'secondary', on: { click: () => detail(r.id, true) } }, 'Open')))))
        : el('p', { class: 'muted' }, 'None yet.')));
  }

  async function detail(id, isAdmin, extra) {
    const reg = await api('GET', '/v1/registrations/' + encodeURIComponent(id));
    const manifest = await api('GET', '/v1/registrations/' + encodeURIComponent(id) + '/manifest');
    const keys = (await api('GET', '/v1/registrations/' + encodeURIComponent(id) + '/api-keys')).data;
    const manifestText = JSON.stringify(manifest, null, 2);
    app.replaceChildren();
    if (isAdmin) app.append(el('div', { class: 'row', style: 'margin-bottom:12px' }, el('button', { class: 'secondary', on: { click: () => adminHome() } }, '← All organizations')));
    if (extra) app.append(extra);
    app.append(el('section', { class: 'card' }, el('h2', {}, reg.name, ' ', status(reg.status)),
      el('div', { class: 'muted' }, 'Registration ', el('code', {}, reg.id), reg.deelugeAppId ? ' · Deeluge app ' + reg.deelugeAppId : '')));

    const secret = el('input', { type: 'password', placeholder: 'whsec_…' });
    app.append(el('section', { class: 'card' },
      el('div', { class: 'step' }, el('div', { class: 'num' }, '1'), el('div', { style: 'flex:1;min-width:0' },
        el('h2', {}, 'Register the app in Deeluge'),
        el('p', { class: 'muted' }, 'Deeluge → Settings → Developers → Apps. Register a new app with this manifest. If you already registered the Company Categorizer, paste it over the old manifest instead and keep its "key".'),
        el('textarea', { readonly: true }, manifestText),
        el('div', { class: 'row' }, el('button', { on: { click: () => copy(manifestText) } }, 'Copy manifest'), el('a', { href: reg.manifest_url, target: '_blank', rel: 'noopener' }, 'Open as JSON')))),
      el('hr', { style: 'border:0;border-top:1px solid var(--line);margin:18px 0' }),
      el('div', { class: 'step' }, el('div', { class: 'num' }, '2'), el('div', { style: 'flex:1' },
        el('h2', {}, 'Give the categorizer the signing secret'),
        el('p', { class: 'muted' }, reg.hasSigningSecret ? 'A secret is saved (since ' + new Date(reg.signingSecretAddedAt).toLocaleString() + '). Paste a new one here whenever you roll it in Deeluge.' : 'On the app\\'s row in Deeluge, select the key icon and copy the secret.'),
        secret, el('div', { class: 'row' }, el('button', { on: { click: async () => {
          try { await api('PUT', '/v1/registrations/' + encodeURIComponent(id) + '/signing-secret', { signing_secret: secret.value }); toast('Signing secret saved'); detail(id, isAdmin); } catch (e) { toast(e.message); }
        } } }, 'Save secret')))),
      el('hr', { style: 'border:0;border-top:1px solid var(--line);margin:18px 0' }),
      el('div', { class: 'step' }, el('div', { class: 'num' }, '3'), el('div', { style: 'flex:1' },
        el('h2', {}, 'Install it'),
        el('p', { class: 'muted' }, 'Install the app in your workspace (or uninstall and install again). The workspace\\'s key reaches the categorizer by itself. To let other firms use it, share the app in Deeluge and send them the install link: their workspaces appear below.')))));

    app.append(el('section', { class: 'card' }, el('h2', {}, 'Workspaces using it'),
      reg.installations.length ? el('table', {}, el('tr', {}, el('th', {}, 'Workspace'), el('th', {}, 'Columns'), el('th', {}, 'Categorized'), el('th', {}, 'Installed')),
        reg.installations.map((i) => el('tr', {}, el('td', {}, i.workspace_name || '—', el('div', { class: 'muted' }, i.workspace_id)),
          el('td', { class: 'muted' }, Object.values(i.columns).map((c) => c.object + '.' + c.attribute_key).join(', ') || '—'),
          el('td', {}, String(i.categorized_count)), el('td', { class: 'muted' }, new Date(i.installed_at).toLocaleDateString()))))
        : el('p', { class: 'muted' }, 'No workspace has installed it yet.')));

    const s = reg.settings;
    const objects = el('input', { type: 'text', value: s.objects.join(', ') });
    const auto = el('input', { type: 'text', value: s.auto_objects.join(', ') });
    const appKey = el('input', { type: 'text', value: s.app_key });
    const box = (k, text) => { const c = el('input', { type: 'checkbox' }); c.checked = !!s[k]; c.dataset.k = k; return el('label', {}, c, text); };
    const checks = el('div', { class: 'checks' }, box('categorize_on_create', 'Categorize new records automatically'), box('categorize_on_domain_change', 'Categorize again when a record\\'s domain changes'),
      box('sub_category_column', 'Add a Sub-category column'), box('recategorize_action', 'Add "Research category again" to the record menu'));
    const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
    app.append(el('section', { class: 'card' }, el('h2', {}, 'Settings'),
      el('label', {}, 'App key (must match the key of the app registered in Deeluge)'), appKey,
      el('label', {}, 'Objects with the Category column, action and panel'), objects,
      el('label', {}, 'Objects categorized automatically'), auto, checks,
      el('div', { class: 'row' }, el('button', { on: { click: async () => {
        const settings = { app_key: appKey.value.trim(), objects: list(objects.value), auto_objects: list(auto.value) };
        checks.querySelectorAll('input').forEach((c) => (settings[c.dataset.k] = c.checked));
        try { await api('PATCH', '/v1/registrations/' + encodeURIComponent(id), { settings }); toast('Saved. Paste the updated manifest into Deeluge.'); detail(id, isAdmin); } catch (e) { toast(e.message); }
      } } }, 'Save settings'))));

    app.append(el('section', { class: 'card' }, el('h2', {}, 'API keys'),
      el('p', { class: 'muted' }, 'For this page and for calling POST /v1/companies/categorize directly.'),
      el('table', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Key'), el('th', {}, 'Last used'), el('th', {})),
        keys.map((k) => el('tr', {}, el('td', {}, k.name), el('td', {}, el('code', {}, k.key_prefix + '…')),
          el('td', { class: 'muted' }, k.revoked_at ? 'revoked' : k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'),
          el('td', {}, k.revoked_at ? '' : el('button', { class: 'danger', on: { click: async () => {
            if (!confirm('Revoke ' + k.name + '? Anything using it stops working.')) return;
            try { await api('DELETE', '/v1/api-keys/' + encodeURIComponent(k.id)); detail(id, isAdmin); } catch (e) { toast(e.message); }
          } } }, 'Revoke'))))),
      el('div', { class: 'row' }, el('button', { class: 'secondary', on: { click: async () => {
        try { const out = await api('POST', '/v1/registrations/' + encodeURIComponent(id) + '/api-keys', {}); detail(id, isAdmin, oneTimeKey(out.api_key)); } catch (e) { toast(e.message); }
      } } }, 'New key'))));
  }

  start();
})();
</script>
</body>
</html>`;
