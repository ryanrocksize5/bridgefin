import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import { clientIp } from '../app.ts';
import { getJsonSetting, getSetting, setJsonSetting, setSetting } from '../db.ts';
import type { Ctx } from '../http/router.ts';
import { log } from '../log.ts';
import { catalogBlocker, catalogBrowsable, catalogSupports, SUGGESTED_ADDONS } from '../stremio/addons.ts';
import { addonSupports } from '../stremio/addon-client.ts';
import { DEFAULT_PREFS, type StreamPrefs } from '../streams/service.ts';
import { act, esc, layout, loginPage } from './page.ts';

const COOKIE = 'bf_admin';
const ADMIN_DEVICE = 'bridgefin-settings-page';
const PLAN: Record<number, string> = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };

function cookieToken(c: Ctx): string | undefined {
  const raw = String(c.req.headers.cookie ?? '');
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(raw);
  return m?.[1];
}

function redirect(c: Ctx, to: string, cookie?: string): void {
  const headers: Record<string, string> = { location: to, 'cache-control': 'no-store' };
  if (cookie !== undefined) headers['set-cookie'] = cookie;
  c.res.writeHead(303, headers);
  c.res.end();
}

function html(c: Ctx, body: string, status = 200): void {
  c.res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
  c.res.end(body);
}

const tokenHash = (t: string) => createHash('md5').update(t).digest('hex').slice(0, 12);

export function registerAdminRoutes(app: App): void {
  const r = app.router;
  const authed = (c: Ctx) => app.auth.validToken(cookieToken(c));

  r.get('/admin', (c) => {
    if (!authed(c)) return html(c, loginPage());
    html(c, renderSettings(app, c));
  }, { public: true });

  r.post('/admin/login', (c) => {
    const b = c.body ?? {};
    const ip = clientIp(c.req);
    const result = app.auth.attempt(String(b.username ?? ''), String(b.password ?? ''), ip);
    if (!result.ok) {
      if (result.retryAfter > 0) {
        log.warn(`settings page: sign-in locked out for ${ip}`);
        return html(c, loginPage(`Too many failed attempts. Try again in ${Math.ceil(result.retryAfter / 60)} minutes.`), 429);
      }
      log.warn(`settings page: failed sign-in from ${ip}`);
      return html(c, loginPage('That username and password did not match.'), 401);
    }
    const token = app.auth.issueToken({ client: 'Bridgefin settings', device: 'Browser', deviceId: ADMIN_DEVICE, version: '1' });
    redirect(c, '/admin', `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }, { public: true });

  r.post('/admin/logout', (c) => {
    const t = cookieToken(c);
    if (t) app.auth.revoke(t);
    redirect(c, '/admin', `${COOKIE}=; Path=/admin; Max-Age=0`);
  }, { public: true });

  r.post('/admin/do', async (c) => {
    if (!authed(c)) return redirect(c, '/admin');
    const b: Record<string, string> = c.body ?? {};
    let msg = '';
    let err = '';
    try {
      msg = await doAction(app, b, cookieToken(c)!);
    } catch (e) {
      err = (e as Error).message || 'Something went wrong';
      log.warn(`settings action ${b.action} failed`, e);
    }
    const q = err ? `err=${encodeURIComponent(err)}` : msg ? `msg=${encodeURIComponent(msg)}` : '';
    redirect(c, `/admin${q ? '?' + q : ''}#${esc(b.anchor ?? '')}`);
  }, { public: true });
}

async function doAction(app: App, b: Record<string, string>, ownToken: string): Promise<string> {
  const { addons, sync, streams } = app;
  switch (b.action) {
    case 'torbox_key': {
      const key = (b.key ?? '').trim();
      if (!key) {
        setSetting(app.db, 'torboxApiKey', null);
        setSetting(app.db, 'torboxInfo', null);
        return 'TorBox key removed.';
      }
      setSetting(app.db, 'torboxApiKey', key);
      try {
        const me = await streams.torbox.me();
        setJsonSetting(app.db, 'torboxInfo', { plan: me.plan, expires: me.premium_expires_at, checked: Date.now() });
        return `TorBox connected (${PLAN[me.plan ?? -1] ?? 'unknown'} plan).`;
      } catch (e) {
        setSetting(app.db, 'torboxInfo', null);
        throw new Error(`Saved, but TorBox rejected the key: ${(e as Error).message}`);
      }
    }
    case 'playback_mode':
      setSetting(app.db, 'playbackMode', b.mode === 'proxy' ? 'proxy' : 'redirect');
      return b.mode === 'proxy' ? 'Video now streams through this server.' : 'Players now fetch video straight from TorBox.';
    case 'addon_install': {
      const a = await addons.install(b.url ?? '', { enableCatalogs: b.enable === '1' });
      return `Installed ${a.manifest.name}.`;
    }
    case 'addon_remove': {
      const a = addons.get(b.id);
      addons.uninstall(b.id);
      return `Removed ${a?.manifest.name ?? 'addon'}.`;
    }
    case 'addon_toggle': {
      const a = addons.get(b.id);
      if (a) addons.setEnabled(a.id, !a.enabled);
      return a ? `${a.manifest.name} ${a.enabled ? 'turned off' : 'turned on'}.` : '';
    }
    case 'addon_move':
      addons.move(b.id, Number(b.delta));
      return '';
    case 'addons_refresh':
      await addons.refreshManifests();
      return 'Addon details refreshed.';
    case 'catalog_toggle':
      addons.setCatalogEnabled(b.addon, b.type, b.cid, b.on === '1');
      return '';
    case 'catalog_move':
      addons.moveCatalog(b.addon, b.type, b.cid, Number(b.delta));
      return '';
    case 'prefs': {
      const p: StreamPrefs = {
        maxResolution: Number(b.maxResolution) || 0,
        minResolution: Number(b.minResolution) || 0,
        excludeCam: b.excludeCam === '1',
        excludeKeywords: (b.excludeKeywords ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        maxResults: Math.min(100, Math.max(1, Number(b.maxResults) || DEFAULT_PREFS.maxResults)),
        perQuality: Math.min(50, Math.max(0, Number.isFinite(Number(b.perQuality)) && b.perQuality !== '' ? Number(b.perQuality) : DEFAULT_PREFS.perQuality)),
        sort: (['quality', 'size_desc', 'size_asc'].includes(b.sort) ? b.sort : 'quality') as StreamPrefs['sort'],
        includeUnknownCache: b.includeUnknownCache === '1',
        subtitleLanguages: (b.subtitleLanguages ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        subtitlesPerLanguage: Math.min(20, Math.max(1, Number(b.subtitlesPerLanguage) || DEFAULT_PREFS.subtitlesPerLanguage)),
      };
      setJsonSetting(app.db, 'streamPrefs', p);
      return 'Stream preferences saved.';
    }
    case 'stremio_login':
      await sync.login((b.email ?? '').trim(), b.password ?? '');
      try {
        const imp = await sync.importAddons();
        const pulled = await sync.pull();
        return `Stremio linked. Imported ${imp.added} addons and ${pulled.items} library items.`;
      } catch (e) {
        return `Stremio linked, but the first sync failed: ${(e as Error).message}`;
      }
    case 'stremio_logout':
      await sync.logout();
      return 'Stremio account unlinked. Your local library stays as it is.';
    case 'stremio_import_addons': {
      const r = await sync.importAddons();
      return `Imported ${r.added} addons (${r.skipped} already here or not usable).`;
    }
    case 'stremio_pull': {
      const r = await sync.pull();
      const pushed = await sync.flush();
      return `Synced ${r.items} library items${pushed ? `, sent ${pushed} changes` : ''}.`;
    }
    case 'stremio_writeback':
      sync.setWriteBack(b.on === '1');
      return b.on === '1' ? 'Changes made here will now be sent to Stremio.' : 'Changes stay on this server only.';
    case 'password': {
      const check = app.auth.attempt(app.auth.username(), b.current ?? '', `settings:${ownToken.slice(0, 8)}`);
      if (!check.ok) throw new Error(check.retryAfter ? 'Too many wrong attempts. Try again later.' : 'Current password is wrong.');
      const user = (b.username ?? '').trim() || app.auth.username();
      if ((b.newpass ?? '').length < 6) throw new Error('New password needs at least 6 characters.');
      app.auth.setCredentials(user, b.newpass);
      return 'Login updated. Sign in again on your devices with the new password.';
    }
    case 'device_revoke': {
      const d = app.auth.devices().find((x) => tokenHash(x.token) === b.id);
      if (d && d.token !== ownToken) app.auth.revoke(d.token);
      return d ? `Signed out ${d.client ?? 'device'}.` : '';
    }
    case 'cache_clear':
      app.db.exec('DELETE FROM link_cache; DELETE FROM meta_cache; DELETE FROM previews;');
      return 'Caches cleared.';
    default:
      return '';
  }
}

function renderSettings(app: App, c: Ctx): string {
  const { addons, sync } = app;
  const msg = c.query.msg ? `<div class="flash" role="status">${esc(c.query.msg)}</div>` : c.query.err ? `<div class="flash err" role="alert">${esc(c.query.err)}</div>` : '';
  const host = String(c.req.headers['x-forwarded-host'] ?? c.req.headers.host ?? `localhost:${app.cfg.port}`);
  const proto = String(c.req.headers['x-forwarded-proto'] ?? 'http');
  const address = `${proto}://${host}`;
  const tbKey = app.torboxKey();
  const tbInfo = getJsonSetting<{ plan?: number; expires?: string } | null>(app.db, 'torboxInfo', null);
  const installed = addons.list();
  const streamAddons = installed.filter((a) => a.enabled && (a.manifest.resources ?? []).some((r) => (typeof r === 'string' ? r : r.name) === 'stream'));
  const catalogs = addons.catalogs();
  const libs = catalogs.filter((x) => x.enabled);
  const prefs = app.streams.prefs();
  const st = sync.status();
  const mode = app.playbackMode();

  const resources = (a: (typeof installed)[number]) => {
    const names = new Set((a.manifest.resources ?? []).map((r) => (typeof r === 'string' ? r : r.name)));
    const parts: string[] = [];
    if (names.has('catalog')) parts.push('catalogs');
    if (names.has('meta')) parts.push('details');
    if (names.has('stream')) parts.push('streams');
    if (names.has('subtitles')) parts.push('subtitles');
    return parts.join(', ') || 'nothing usable';
  };

  // ---------- hero
  const hero = `<section class="connect" aria-labelledby="connect-h">
<p id="connect-h">Add this server in Infuse or Swiftfin as a Jellyfin server</p>
<div class="addr"><code>${esc(address)}</code><button type="button" class="small" data-copy="${esc(address)}">Copy</button></div>
<dl><dt>Username</dt><dd>${esc(app.auth.username())}</dd>
<dt>Password</dt><dd>the one you signed in with here</dd>
<dt>Infuse</dt><dd>Settings → Add Files → Jellyfin. Choose Direct Mode to browse catalogs live.</dd>
<dt>Swiftfin</dt><dd>Connect to Server, then sign in.</dd></dl></section>`;

  // ---------- addons
  const addonRows = installed
    .map(
      (a, i) => `<li class="${a.enabled ? '' : 'off'}"><div class="who"><strong>${esc(a.manifest.name)}</strong> <span class="muted">${esc(a.manifest.version ?? '')}</span><small>${esc(resources(a))}</small></div>
<div class="acts">${i > 0 ? act('addon_move', { id: a.id, delta: -1, anchor: 'addons' }, '<span aria-label="Move up">↑</span>') : ''}${i < installed.length - 1 ? act('addon_move', { id: a.id, delta: 1, anchor: 'addons' }, '<span aria-label="Move down">↓</span>') : ''}
${act('addon_toggle', { id: a.id, anchor: 'addons' }, a.enabled ? 'Turn off' : 'Turn on')}${act('addon_remove', { id: a.id, anchor: 'addons' }, 'Remove', 'danger small', `Remove ${a.manifest.name}?`)}</div></li>`,
    )
    .join('');
  const suggestions = SUGGESTED_ADDONS.filter((s) => !installed.some((a) => a.transportUrl === s.url))
    .map((s) => act('addon_install', { url: s.url, anchor: 'addons' }, `Add ${esc(s.name)}`))
    .join('');
  const addonsWarn = !streamAddons.length;
  const addonsSection = `<section class="stage${addonsWarn ? ' warn' : ''}" id="addons"><header><h2>Addons</h2>
<p class="state">${addonsWarn ? 'No addon gives streams yet. Paste the manifest link of a stream addon you use in Stremio, or link your Stremio account to import them.' : `${installed.length} installed, ${streamAddons.length} giving streams. Earlier addons are asked first for details.`}</p></header>
<div class="panel"><ul class="rows">${addonRows || '<li class="muted">No addons yet.</li>'}</ul></div>
<div class="panel"><form method="post" action="/admin/do"><input type="hidden" name="action" value="addon_install"><input type="hidden" name="anchor" value="addons">
<label for="addon-url">Install from a manifest link</label>
<div class="row"><input id="addon-url" name="url" type="url" placeholder="https://…/manifest.json" required><button type="submit">Install</button></div>
<label class="inline"><input type="checkbox" name="enable" value="1"> Show its catalogs as libraries</label>
<p class="muted">Configured addon links (with your TorBox key inside) work too. Copy them from the addon's configure page.</p></form>
${suggestions ? `<div class="suggest">${suggestions}</div>` : ''}
<div class="suggest">${act('addons_refresh', { anchor: 'addons' }, 'Refresh addon details')}</div></div></section>`;

  // ---------- libraries (catalogs)
  let lastAddon = '';
  const catRows = catalogs
    .filter((x) => x.def.type === 'movie' || x.def.type === 'series')
    .map((x, i, all) => {
      const group = x.addon.id !== lastAddon ? `</ul><p class="group">${esc(x.addon.manifest.name)}</p><ul class="rows">` : '';
      lastAddon = x.addon.id;
      const browsable = catalogBrowsable(x.def);
      const kind = x.def.type === 'movie' ? 'Movies' : 'Shows';
      const extras = [catalogSupports(x.def, 'genre') ? 'genres' : '', catalogSupports(x.def, 'search') ? 'search' : ''].filter(Boolean).join(', ');
      const f = { addon: x.addon.id, type: x.def.type, cid: x.def.id, anchor: 'libraries' };
      return `${group}<li class="${x.enabled ? '' : 'off'}"><div class="who"><strong>${esc(x.def.name ?? x.def.id)} ${kind}</strong><small>${browsable ? (extras ? `Supports ${extras}` : '') : esc(catalogBlocker(x.def) ?? '')}</small></div>
<div class="acts">${x.enabled && i > 0 ? act('catalog_move', { ...f, delta: -1 }, '<span aria-label="Move up">↑</span>') : ''}${x.enabled && i < all.length - 1 ? act('catalog_move', { ...f, delta: 1 }, '<span aria-label="Move down">↓</span>') : ''}
${browsable ? act('catalog_toggle', { ...f, on: x.enabled ? 0 : 1 }, x.enabled ? 'Hide' : 'Show') : ''}</div></li>`;
    })
    .join('');
  const libsSection = `<section class="stage${libs.length ? '' : ' warn'}" id="libraries"><header><h2>Libraries</h2>
<p class="state">${libs.length ? `${libs.length} catalogs shown as libraries, after My Movies and My Shows.` : 'No catalogs shown yet. Pick some below so there is something to browse.'}</p></header>
<div class="panel"><ul class="rows">${catRows.replace(/^<\/ul>/, '')}</ul>
<p class="muted">Favorite a title in Infuse or Swiftfin to add it to My Movies or My Shows, the same as adding it to your Stremio library.</p></div></section>`;

  // ---------- streams
  const tbWarn = !tbKey;
  const sel = (name: string, value: string | number, opts: [string | number, string][]) =>
    `<select id="${name}" name="${name}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const res: [number, string][] = [[0, 'No limit'], [2160, '4K'], [1080, '1080p'], [720, '720p'], [480, 'SD']];
  const streamsSection = `<section class="stage${tbWarn ? ' warn' : ''}" id="streams"><header><h2>Streams</h2>
<p class="state">${tbWarn ? 'Add your TorBox API key so torrent results can be checked and played.' : `TorBox connected${tbInfo?.plan !== undefined ? ` (${PLAN[tbInfo.plan] ?? 'plan unknown'})` : ''}. Only already-cached results are listed, and nothing is added to TorBox until you press play.`}</p></header>
<div class="panel"><form method="post" action="/admin/do"><input type="hidden" name="action" value="torbox_key"><input type="hidden" name="anchor" value="streams">
<label for="tbkey">TorBox API key</label>
<div class="row"><input id="tbkey" name="key" type="password" autocomplete="off" placeholder="${tbKey ? 'Saved. Enter a new key to replace it.' : 'From torbox.app → Settings → API key'}"><button type="submit">Save key</button></div></form></div>
<div class="panel"><form method="post" action="/admin/do"><input type="hidden" name="action" value="prefs"><input type="hidden" name="anchor" value="streams">
<div class="grid2"><div><label for="maxResolution">Highest quality</label>${sel('maxResolution', prefs.maxResolution, res)}</div>
<div><label for="minResolution">Lowest quality</label>${sel('minResolution', prefs.minResolution, res)}</div>
<div><label for="sort">Put first</label>${sel('sort', prefs.sort, [['quality', 'Best quality'], ['size_asc', 'Smallest file'], ['size_desc', 'Largest file']])}</div>
<div><label for="perQuality">Versions per quality</label><input id="perQuality" name="perQuality" type="number" min="0" max="50" value="${prefs.perQuality}"></div>
<div><label for="maxResults">Most versions in total</label><input id="maxResults" name="maxResults" type="number" min="1" max="100" value="${prefs.maxResults}"></div></div>
<p class="muted">For example 3 per quality lists up to 3 at 4K, 3 at 1080p, 3 at 720p, and so on. 0 means no limit per quality.</p>
<label for="excludeKeywords">Hide results containing (comma separated)</label><input id="excludeKeywords" name="excludeKeywords" type="text" value="${esc(prefs.excludeKeywords.join(', '))}" placeholder="e.g. 3D, HDTS, dubbed">
<label class="inline"><input type="checkbox" name="excludeCam" value="1"${prefs.excludeCam ? ' checked' : ''}> Hide cinema recordings (CAM, TS)</label>
<label class="inline"><input type="checkbox" name="includeUnknownCache" value="1"${prefs.includeUnknownCache ? ' checked' : ''}> Keep direct links that don't say whether they're cached</label>
<div class="grid2"><div><label for="subtitleLanguages">Subtitle languages</label><input id="subtitleLanguages" name="subtitleLanguages" type="text" value="${esc(prefs.subtitleLanguages.join(', '))}" placeholder="eng, spa (empty = all)"></div>
<div><label for="subtitlesPerLanguage">Subtitles per language</label><input id="subtitlesPerLanguage" name="subtitlesPerLanguage" type="number" min="1" max="20" value="${prefs.subtitlesPerLanguage}"></div></div>
<div style="margin-top:14px"><button type="submit">Save preferences</button></div></form></div>
<div class="panel"><form method="post" action="/admin/do"><input type="hidden" name="action" value="playback_mode"><input type="hidden" name="anchor" value="streams">
<label for="mode">How video reaches your player</label>
<div class="row">${sel('mode', mode, [['redirect', 'Straight from TorBox (recommended, uses no server bandwidth)'], ['proxy', 'Through this server (if your player refuses redirects)']])}<button type="submit">Save</button></div></form></div></section>`;

  // ---------- stremio account
  const lastPull = st.lastPull ? new Date(st.lastPull).toLocaleString() : 'never';
  const stremioSection = `<section class="stage" id="stremio"><header><h2>Stremio account</h2>
<p class="state">${st.loggedIn ? `Linked to ${esc(st.email ?? 'your account')}. Last synced ${esc(lastPull)}.${st.lastError ? ` Last attempt failed: ${esc(st.lastError)}.` : ''}` : 'Optional. Everything works without it; linking copies your Stremio addons, library and progress here.'}</p></header>
<div class="panel">${
    st.loggedIn
      ? `<div class="suggest">${act('stremio_pull', { anchor: 'stremio' }, 'Sync now', 'small')}${act('stremio_import_addons', { anchor: 'stremio' }, 'Import addons again')}${act('stremio_logout', { anchor: 'stremio' }, 'Unlink', 'danger small', 'Unlink your Stremio account? Your local library stays.')}</div>
<form method="post" action="/admin/do" style="margin-top:12px"><input type="hidden" name="action" value="stremio_writeback"><input type="hidden" name="anchor" value="stremio"><input type="hidden" name="on" value="${st.writeBack ? 0 : 1}">
<p class="muted">${st.writeBack ? 'Favorites, progress and watched marks from your iPhone are sent to Stremio.' : 'Changes you make on your iPhone stay on this server. Turn on sending to keep Stremio on your other devices up to date.'}${st.pending ? ` ${st.pending} changes waiting to send.` : ''}</p>
<button class="${st.writeBack ? 'ghost small' : 'small'}" type="submit">${st.writeBack ? 'Stop sending changes to Stremio' : 'Send my changes to Stremio'}</button></form>`
      : `<form method="post" action="/admin/do"><input type="hidden" name="action" value="stremio_login"><input type="hidden" name="anchor" value="stremio">
<div class="grid2"><div><label for="se">Stremio email</label><input id="se" name="email" type="email" autocomplete="off" required></div>
<div><label for="sp">Stremio password</label><input id="sp" name="password" type="password" autocomplete="off" required></div></div>
<p class="muted">Your password is used once to sign in; only Stremio's sign-in key is kept.</p>
<div style="margin-top:10px"><button type="submit">Link account</button></div></form>`
  }</div></section>`;

  // ---------- devices & login
  const devices = app.auth
    .devices()
    .map(
      (d) => `<li><div class="who"><strong>${esc(d.client ?? 'Unknown app')}</strong> <span class="muted">${esc(d.version ?? '')}</span><small>${esc(d.device ?? '')} · last seen ${esc(new Date(d.last_seen).toLocaleString())}</small></div>
<div class="acts">${d.token === cookieToken(c) ? '<span class="muted">This browser</span>' : act('device_revoke', { id: tokenHash(d.token), anchor: 'devices' }, 'Sign out', 'danger small')}</div></li>`,
    )
    .join('');
  const devicesSection = `<section class="stage" id="devices"><header><h2>Your apps</h2>
<p class="state">Apps signed in to this server.</p></header>
<div class="panel"><ul class="rows">${devices}</ul></div>
<div class="panel"><form method="post" action="/admin/do"><input type="hidden" name="action" value="password"><input type="hidden" name="anchor" value="devices">
<h3>Change login</h3>
<div class="grid2"><div><label for="nu">Username</label><input id="nu" name="username" type="text" value="${esc(app.auth.username())}" autocomplete="username"></div>
<div><label for="np">New password</label><input id="np" name="newpass" type="password" autocomplete="new-password" minlength="6" required></div></div>
<label for="cp">Current password</label><input id="cp" name="current" type="password" autocomplete="current-password" required>
<div style="margin-top:12px"><button type="submit">Update login</button></div></form></div></section>`;

  // ---------- diagnostics
  const unhandled = [...app.unhandled.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, 30);
  const diag = `<section class="stage" id="diagnostics"><header><h2>Troubleshooting</h2>
<p class="state">${unhandled.length ? 'Your apps asked for things Bridgefin does not answer yet. Include this list when reporting a problem.' : 'Nothing unusual from your apps so far.'}</p></header>
<div class="panel">${unhandled.length ? `<table><tbody>${unhandled.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.count}×</td><td>${esc(v.ua)}</td></tr>`).join('')}</tbody></table>` : ''}
<div class="suggest">${act('cache_clear', { anchor: 'diagnostics' }, 'Clear cached details and links')}</div>
<p class="muted">Bridgefin 0.1 · Jellyfin API ${esc(app.cfg.jellyfinVersion)} · ${addonSupports.name ? 'Node ' + esc(process.versions.node) : ''}</p></div></section>`;

  return layout(
    'Bridgefin settings',
    `<div class="top"><h1>Bridgefin</h1><form method="post" action="/admin/logout"><button class="ghost small" type="submit">Sign out</button></form></div>
${msg}${hero}<div class="chain">${addonsSection}${libsSection}${streamsSection}${stremioSection}${devicesSection}${diag}</div>`,
  );
}
