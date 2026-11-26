# Bridgefin

Watch your Stremio addons on iPhone, iPad and Apple TV through **Infuse** or **Swiftfin**.

Bridgefin is a small server that speaks the Jellyfin API. Jellyfin apps see it as a normal
Jellyfin server, but everything they show comes from your Stremio addons, and every stream
plays from your **TorBox** account. Only results already cached on TorBox are listed, so
playback starts straight away.

- No transcoding, no ffmpeg, no torrent engine: ~35 MB of memory when idle.
- Works on its own. Linking a Stremio account is optional, and Bridgefin keeps working when
  Stremio's servers are down (details are cached locally).
- One user, one password, a settings page at `/admin`.

## What you get in Infuse / Swiftfin

| Stremio | In Infuse / Swiftfin |
|---|---|
| Addon catalogs (Popular, Featured, …) | One library per catalog you pick |
| Your library | **My Movies** and **My Shows**. Favorite a title to add it |
| Search | Searches every addon that supports search |
| Title page (poster, plot, cast, rating, trailer) | Details page, with IMDb/TMDB ids so Infuse adds its own artwork |
| Stream picker | **Versions**, e.g. `4K DV · REMUX · HEVC · Atmos · 58.0 GB · Torrentio`, best first |
| Subtitles addons (OpenSubtitles) | Extra subtitle tracks, on top of those inside the file |
| Continue watching, watched marks | Resume points, watched marks, **Continue Watching** and **Next Up** |
| New episodes of shows you follow | **Latest** row under My Shows, and upcoming episodes |

## Run it

You need Docker. On the machine that will run Bridgefin:

```powershell
git clone <this repo> bridgefin
cd bridgefin
```

Edit `compose.yaml` and set `BRIDGEFIN_PASSWORD`. Then:

```powershell
docker compose up -d --build
```

Open `http://<that machine's IP>:8096/admin`, sign in with `admin` and your password, then:

1. **Streams**: paste your TorBox API key (torbox.app → Settings → API key).
2. **Addons**: press **Add Torrentio**, or paste any addon manifest link you use in Stremio.
   Bridgefin checks raw torrent results against your TorBox cache itself, so plain Torrentio
   works. Addon links already configured with your TorBox key also work.
3. **Libraries**: pick which catalogs show up as libraries (Cinemeta's Popular and Featured
   are on by default).
4. Optional, **Stremio account**: link it to import your addons, library and progress.

If you leave `BRIDGEFIN_PASSWORD` empty, a password is generated on first start and printed
once in the logs (`docker compose logs bridgefin`).

### Connect from Infuse

Settings → **Add Files** → **Jellyfin** → enter the address shown at the top of the settings page,
plus your username and password.

- Under **Advanced**, choose **Direct Mode**. Catalogs are browsed live and stay current.
- Library Mode also works, but it downloads every catalog into Infuse up front. Expect a
  slower first sync with big catalogs.

### Connect from Swiftfin

**Connect to Server** → the same address → sign in.

### Watching away from home

Your phone gets video straight from TorBox, so Bridgefin itself uses almost no bandwidth. To
reach it outside your home network, pick one:

- **Tailscale** (simplest): install it on the server and the iPhone, then use the server's
  Tailscale address in Infuse.
- **A VPS or reverse proxy**: put Bridgefin behind HTTPS (Caddy, Nginx, Cloudflare Tunnel) and
  use a strong password.

## How playback works

1. When you open a title, Bridgefin asks every stream addon for results.
   - Torrent results are checked against TorBox's cache in one batch, and uncached ones are dropped.
   - Direct links from debrid-configured addons are kept unless the addon marks them uncached
     (`[TB download]`, `⬇️`, `⏳`).
2. The remaining results become Jellyfin versions, filtered and sorted by your stream preferences.
3. **Nothing is added to your TorBox account until you press play.** Then Bridgefin adds that one
   cached torrent, picks the right file (including the right episode from a season pack), gets
   a download link and redirects your player to it.
4. If that version fails, it tries the next two before giving up.

**How video reaches your player** (settings page) has two options:
- **Straight from TorBox** (default): the player is redirected to TorBox's CDN.
- **Through this server**: the video is streamed through Bridgefin. Use this if a player refuses
  redirects.

## Stremio account sync

- Linking stores only Stremio's sign-in key, never your password.
- **Import** (always on once linked): addons, library, resume positions and watched episodes,
  every 15 minutes. A remote change only replaces local data when it's newer. Watched marks are
  merged, never removed.
- **Sending changes back** is **off by default**. Turn it on under *Stremio account* to push
  favorites, progress and watched marks from your iPhone to Stremio on your other devices.
- If Stremio is unreachable, changes queue up and are sent later.

## Settings via environment

| Variable | Default | |
|---|---|---|
| `BRIDGEFIN_USERNAME` | `admin` | Login for apps and the settings page |
| `BRIDGEFIN_PASSWORD` | generated | Applied at every start when set |
| `TORBOX_API_KEY` | | Can also be set on the settings page |
| `PLAYBACK_MODE` | `redirect` | `redirect` or `proxy` |
| `PORT` | `8096` | |
| `SERVER_NAME` | `Bridgefin` | Name shown in apps |
| `CATALOG_LIMIT` | `300` | Max items per catalog library |
| `JELLYFIN_VERSION` | `12.4.0` | Version reported to apps |
| `LOG_LEVEL` | `info` | `debug` logs every request |
| `DATA_DIR` | `/data` | SQLite database location |

## Development

Requires Node 24 (it runs the TypeScript directly; there is no build step).

```powershell
npm install
```

```powershell
npm test
```

```powershell
npm run dev
```

- `src/jellyfin/`: the Jellyfin API (routes, item mapping, playback)
- `src/stremio/`: the addon protocol, addon management, account sync, watched-episode format
- `src/streams/`: stream parsing, cache filtering, sorting, link resolution
- `src/torbox.ts`: the TorBox API client
- `src/admin/`: the settings page

The settings page's **Troubleshooting** section lists any request your apps made that
Bridgefin doesn't answer yet.

## Not yet confirmed on a real iPhone

Bridgefin was checked against a real Jellyfin 10.11 server's responses, the official Jellyfin web
client, and Swiftfin/Infuse behaviour documented in their source and community reports. These
still need confirming on a device:

- Infuse search in Direct Mode
- Infuse's version picker (it may only offer versions that were loaded recently; otherwise it
  plays the best one)
- Infuse following the redirect to TorBox (switch to *Through this server* if it doesn't)
- Real TorBox resolution and Stremio account sync with a live account
