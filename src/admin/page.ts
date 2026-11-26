// Server-rendered settings page. No client framework, no external assets.

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{--ink:#16243F;--paper:#EDF0F3;--card:#FFFFFF;--teal:#0B7F74;--amber:#B7700A;--slate:#465265;--rule:#CBD3DC;--red:#B3261E;
--display:ui-rounded,"SF Pro Rounded","Nunito","Segoe UI Variable Display",system-ui,sans-serif;
--body:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Consolas,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 var(--body)}
main{max-width:760px;margin:0 auto;padding:24px 20px 80px}
h1,h2,h3{font-family:var(--display);line-height:1.2;margin:0}
h1{font-size:1.25rem;font-weight:700;letter-spacing:.01em}
h2{font-size:1.3rem;font-weight:700}
h3{font-size:1rem;font-weight:650}
p{margin:.4rem 0}
a{color:var(--teal)}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.top form{margin:0}
.connect{background:var(--ink);color:#fff;border-radius:18px;padding:22px 22px 20px;margin-bottom:28px}
.connect p{color:#C6D0DE;margin:0 0 6px}
.addr{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0 14px}
.addr code{font:600 clamp(1.15rem,4.6vw,1.6rem)/1.2 var(--mono);color:#fff;word-break:break-all}
.connect dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:.95rem}
.connect dt{color:#9FB0C6}.connect dd{margin:0}
.chain{position:relative;padding-left:30px}
.chain:before{content:"";position:absolute;left:8px;top:10px;bottom:10px;width:2px;background:var(--rule)}
.stage{position:relative;margin:0 0 30px}
.stage:before{content:"";position:absolute;left:-28px;top:6px;width:14px;height:14px;border-radius:50%;background:var(--paper);border:3px solid var(--teal)}
.stage.warn:before{border-color:var(--amber)}
.stage>header{margin-bottom:10px}
.state{color:var(--slate);font-size:.95rem}
.stage.warn .state{color:var(--amber)}
.panel{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:14px 16px}
.panel+.panel{margin-top:10px}
.rows{list-style:none;margin:0;padding:0}
.rows li{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid #E4E9EF}
.rows li:first-child{border-top:0;padding-top:2px}
.rows .who{min-width:0}
.rows .who small{display:block;color:var(--slate);font-size:.85rem;overflow-wrap:anywhere}
.off .who{opacity:.55}
.acts{display:flex;gap:6px;flex-shrink:0}
.acts form{margin:0}
label{display:block;font-weight:600;font-size:.92rem;margin:10px 0 4px}
label.inline{display:flex;gap:8px;align-items:center;font-weight:500}
input[type=text],input[type=password],input[type=url],input[type=number],input[type=email],select{width:100%;font:inherit;padding:9px 11px;border:1px solid var(--rule);border-radius:9px;background:#fff;color:var(--ink)}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--teal)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
@media (max-width:520px){.grid2{grid-template-columns:1fr}}
button{font:600 .92rem var(--body);border-radius:9px;border:1px solid var(--ink);background:var(--ink);color:#fff;padding:8px 14px;cursor:pointer}
button.ghost{background:transparent;color:var(--ink);border-color:var(--rule)}
button.small{padding:5px 10px;font-size:.85rem}
button.danger{background:transparent;color:var(--red);border-color:#E7B9B5}
.connect button{background:#fff;color:var(--ink);border-color:#fff}
.row{display:flex;gap:8px;align-items:flex-end;margin-top:10px}
.row>*:first-child{flex:1}
.flash{border-radius:10px;padding:10px 14px;margin-bottom:18px;background:#DDF1EE;color:#06463F}
.flash.err{background:#F8E1DF;color:#7A1A14}
.suggest{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.muted{color:var(--slate);font-size:.9rem}
table{width:100%;border-collapse:collapse;font-size:.88rem}
td{padding:6px 4px;border-top:1px solid #E4E9EF;vertical-align:top;overflow-wrap:anywhere}
.group{margin:12px 0 2px;color:var(--slate);font-size:.9rem;font-weight:600}
:focus-visible{outline:3px solid #5FB3AA;outline-offset:2px}
.login{max-width:380px;margin:12vh auto 0}
`;

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>
<script>
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
navigator.clipboard&&navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)})})});
document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.getAttribute('data-confirm')))e.preventDefault()})});
</script></body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    'Bridgefin – sign in',
    `<div class="login"><h1 style="font-size:1.6rem;margin-bottom:6px">Bridgefin</h1>
<p class="muted">Sign in with the same username and password you use in Infuse.</p>
${error ? `<div class="flash err">${esc(error)}</div>` : ''}
<form method="post" action="/admin/login" class="panel">
<label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" required>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<div style="margin-top:14px"><button type="submit">Sign in</button></div></form></div>`,
  );
}

/** A small POST button form. */
export function act(action: string, fields: Record<string, string | number>, label: string, cls = 'ghost small', confirmText?: string): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<form method="post" action="/admin/do"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ''}><input type="hidden" name="action" value="${esc(action)}">${hidden}<button class="${cls}" type="submit">${label}</button></form>`;
}
