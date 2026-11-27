# Bridgefin

Watch your Stremio addons on iPhone, iPad and Apple TV with **Infuse** or **Swiftfin**.

There's no Stremio app for iPhone. Bridgefin fixes that by running a small server on your
computer that Infuse and Swiftfin treat as a normal **Jellyfin** server. Everything they show
comes from your Stremio addons, and everything plays from your **TorBox** account. Only
results already cached on TorBox are listed, so playback starts straight away.

- Light: about 35 MB of memory, no video conversion, no torrent downloading on your computer.
- Works on its own. Linking your Stremio account is optional.
- One username and password, and a settings page in your browser.

## What you get

| In Stremio | In Infuse / Swiftfin |
|---|---|
| Addon catalogs (Popular, Featured, …) | One library per catalog you pick |
| Your library | **My Movies** and **My Shows**. Favorite a title to add it |
| Search | Search across every addon that supports it |
| Title pages (poster, plot, cast, rating, trailer) | Details pages, with artwork |
| Choosing a stream | Choosing a **version**, e.g. `4K DV · REMUX · Atmos · 58.0 GB`, best first |
| Subtitles addons | Extra subtitle tracks |
| Continue watching, watched marks | **Continue Watching**, **Next Up**, resume points, watched marks |
| Binge watching | The next episode keeps the same release you were watching |
| New episodes of shows you follow | **Latest** row under My Shows |

---

## Set it up (about 15 minutes)

### What you need

- A computer that stays on while you watch: Windows, Mac or Linux.
- A **TorBox** account and its API key (torbox.app → Settings → API key).
- **Infuse** or **Swiftfin** on your iPhone, iPad or Apple TV, on the **same Wi-Fi** as the computer.
- The **links of the Stremio addons** you use for streams. Or just your Stremio login:
  Bridgefin can import your addons from it.

### 1. Install Docker Desktop

Download it from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/),
install it and open it once. It needs to be running whenever Bridgefin runs.

### 2. Download Bridgefin

On [this project's GitHub page](https://github.com/ryanrocksize5/bridgefin), click the green **Code**
button → **Download ZIP**, then unzip it somewhere easy, like your Documents folder.

(If you use git: `git clone https://github.com/ryanrocksize5/bridgefin.git`)

### 3. Choose your password

Open the `compose.yaml` file from the unzipped folder in any text editor (Notepad is fine). Find
this line:

```yaml
      BRIDGEFIN_PASSWORD: change-me
```

Replace `change-me` with a password of your own, and save the file. You'll type this password
into Infuse later. The username is `admin`.

### 4. Start Bridgefin

Open a terminal **in the Bridgefin folder**:

- **Windows:** open the folder in File Explorer, click the address bar, type `powershell` and
  press Enter.
- **Mac:** right-click the folder in Finder → **New Terminal at Folder**. If you don't see it,
  open Terminal, type `cd `, drag the folder into the window and press Enter.

Then run:

```sh
docker compose up -d --build
```

The first time takes a minute or two. When it finishes, Bridgefin is running and starts again
by itself whenever Docker Desktop starts.

### 5. Find your computer's address

Your phone needs your computer's address on your home network. It looks like `192.168.1.23`.

- **Windows:** Settings → Network & internet → Wi-Fi (or Ethernet) → your network → **IPv4 address**.
- **Mac:** System Settings → Wi-Fi → **Details…** next to your network → **IP address**.

From now on, wherever this guide says `YOUR-IP`, use that address.

> **Windows only:** if Windows calls your network *Public*, it blocks your phone. On that same
> settings screen, set **Network profile type** to **Private**.

### 6. Set up Bridgefin in your browser

On your computer, open **http://localhost:8096/admin** and sign in with `admin` and your
password. Then, going down the page:

1. **Stremio account** (optional, but the quickest): sign in to import your addons, library
   and watch progress. Your Stremio password is only used once and is not stored.
2. **Addons**: if you didn't link Stremio, paste the manifest link of each stream addon you
   use (the link ending in `/manifest.json`, from the addon's install or configure page).
   - Addon links already set up with your TorBox key work.
   - Addons that only list torrents work too. Bridgefin checks them against your TorBox
     cache itself.
3. **Streams**: paste your **TorBox API key**. The page should then say *TorBox connected*.
4. **Libraries**: pick which catalogs you want to browse (Popular and Featured are on already).

### 7. Connect your iPhone, iPad or Apple TV

First, check your phone can reach Bridgefin: open Safari and go to `http://YOUR-IP:8096/health`.
It should say **Healthy**. If it doesn't, see [Troubleshooting](#troubleshooting).

**Infuse (iPhone and iPad)**

1. Tap the **Settings** (gear) icon → **Add Files**.
2. Under **Media Servers**, tap **Add Media Server**, then choose **Jellyfin**.
3. Address: `http://YOUR-IP:8096`. Username: `admin`. Password: your password.
4. Under **Advanced**, leave **Library Mode** **off**. Infuse then browses Bridgefin live,
   which suits catalogs that change every day.

**Infuse (Apple TV):** Settings → **Shares** → **Add Media Server** → **Jellyfin**, then the same
details as above.

**Swiftfin:** tap **Connect to Server**, enter `http://YOUR-IP:8096`, then sign in with `admin`
and your password.

That's it. Your libraries, Continue Watching and search are all there.

---

## Everyday use

- **Add to your library:** favorite a title (the heart). It appears in My Movies or My Shows.
- **Pick a version:** open a title and choose a version before you press play. Bridgefin
  remembers it, so resuming plays the same file.
- **Fewer or more versions:** settings page → **Streams** → *Versions per quality*.
- **Settings page:** `http://YOUR-IP:8096/admin` works from your phone too.

### Update Bridgefin

Download the new version the same way, copy your `compose.yaml` over (or set your password
again), then run `docker compose up -d --build` in the folder. Your settings and library are
kept.

### Stop or remove it

Run these in the Bridgefin folder:

```sh
docker compose down
```

This stops it. Your settings and library are kept for next time.

```sh
docker compose down --volumes
```

This also deletes everything Bridgefin saved, including your TorBox key.

---

## Troubleshooting

**My phone can't connect (Safari can't open `/health`).**
- Check your phone and computer are on the same Wi-Fi.
- Use the computer's address, not `localhost`.
- On Windows, set your network to **Private** (step 5). If it still fails, allow the port by
  running this in PowerShell **as administrator**:
  ```powershell
  New-NetFirewallRule -DisplayName "Bridgefin" -Direction Inbound -Protocol TCP -LocalPort 8096 -Action Allow -Profile Any
  ```
- Check Docker Desktop is running.

**I can't find Jellyfin in Infuse.** Jellyfin is listed after you tap **Add Media Server**, in
the **Media Servers** section under Settings → Add Files. It is not in the main list of file
sources.

**Titles show no versions, or say nothing is available.**
- Check that the **Streams** section of the settings page says *TorBox connected*.
- Check that the **Addons** section says at least one addon is *giving streams*.
- Very new or rare titles may simply not be cached on TorBox yet. Bridgefin only lists cached
  results.

**A version won't play.** On the settings page, under **Streams**, set *How video reaches your
player* to **Through this server**, then try again.

**I forgot my password.** In `compose.yaml`, set a new `BRIDGEFIN_PASSWORD` and add a line
`BRIDGEFIN_RESET_PASSWORD: "1"` under it. Run `docker compose up -d`, then remove that line
again. All your devices will need to sign in again.

**Something else is wrong.** Look at the **Troubleshooting** section at the bottom of the
settings page and at the logs (`docker compose logs bridgefin`), and include both when you open
an issue.

---

## Watching away from home

Your phone gets video straight from TorBox, so Bridgefin itself uses almost no internet. To
reach it when you're out:

- **Tailscale** (easiest and safe): install [Tailscale](https://tailscale.com) on the computer
  and the phone, then use the computer's Tailscale address in Infuse instead of `YOUR-IP`.
- **A server or reverse proxy** (advanced): run Bridgefin behind HTTPS (Caddy, Nginx, Cloudflare
  Tunnel) with a strong password, and set `TRUST_PROXY: "1"`.

Don't open port 8096 on your router directly: your password would travel unencrypted.

## Security

- **Login protection:** after 10 wrong passwords from one address (or 100 overall), logins are
  refused for 15 minutes, both in apps and on the settings page.
- **Your password after setup:** `BRIDGEFIN_PASSWORD` only sets the **first** login. Change it
  later on the settings page; restarts won't undo the change.
- **What's stored:** your TorBox key and your Stremio sign-in key, in Bridgefin's database inside
  Docker. Your Stremio password is never stored.
- **`TRUST_PROXY`:** only set it behind your own reverse proxy. Otherwise anyone could fake their
  address and get around login protection.

---

## How it works

1. When you open a title, Bridgefin asks every stream addon for results.
   - Torrent results are checked against your TorBox cache in one go, and uncached ones are
     dropped.
   - Direct links from TorBox-configured addons are kept unless the addon marks them as not
     cached (`[TB download]`, `⬇️`, `⏳`).
2. The results become Jellyfin versions, filtered and sorted by your stream preferences.
   - The version you last played comes first.
   - For episodes, the release you were bingeing comes first.
3. **Nothing is added to your TorBox account until you press play.** Then Bridgefin adds that one
   cached torrent, picks the right file (including the right episode from a season pack) and
   sends your player straight to TorBox's download link.
4. If a version fails, it tries the next two before giving up.

### Stremio account sync

- **Import** (always on once linked): addons, library, resume points and watched episodes,
  every 15 minutes. A change from Stremio only replaces local data when it's newer. Watched
  marks are added, never removed.
- **Sending changes back** is **off by default**. Turn it on under *Stremio account* to send
  favorites, progress and watched marks from your iPhone to Stremio on your other devices.
- If Stremio is unreachable, changes wait and are sent later. Bridgefin keeps working
  without Stremio's servers, since it keeps its own copy of titles' details.

### Settings in `compose.yaml`

| Setting | Default | What it does |
|---|---|---|
| `BRIDGEFIN_USERNAME` | `admin` | Username for apps and the settings page |
| `BRIDGEFIN_PASSWORD` | generated | First login only (see Security) |
| `BRIDGEFIN_RESET_PASSWORD` | | `1` = replace the saved login, once (forgotten password) |
| `TORBOX_API_KEY` | | Optional; you can paste it on the settings page instead |
| `PLAYBACK_MODE` | `redirect` | `redirect` (straight from TorBox) or `proxy` (through Bridgefin) |
| `SERVER_NAME` | `Bridgefin` | Name shown in your apps |
| `CATALOG_LIMIT` | `300` | Most titles shown per catalog library |
| `TRUST_PROXY` | | `1` only behind your own reverse proxy |
| `PORT` | `8096` | Port inside the container |
| `JELLYFIN_VERSION` | `12.4.0` | Jellyfin version reported to apps |
| `LOG_LEVEL` | `info` | `debug` logs every request |

If you leave `BRIDGEFIN_PASSWORD` empty, a password is generated on first start and printed once
in the logs (`docker compose logs bridgefin`).

## What's been tested

**Confirmed on a real iPhone with Swiftfin 1.7.1:**
- signing in and browsing
- choosing versions and playing streams from TorBox-configured addons
- resuming with the same version

**Also confirmed:**
- importing a real Stremio account's addons and library
- the official Jellyfin web app
- response formats checked field by field against a real Jellyfin 12.4 server
- 34 automated tests

**Not yet confirmed on a device:**
- Infuse: search, its version picker, and playback (if a version won't play, switch to
  *Through this server*)
- Torrent-only addons resolved through TorBox (the automated tests cover this)
- Sending changes back to a Stremio account
- Infuse Library Mode with very large catalogs (the first sync can be slow)

## Development

Requires Node 24, which runs the TypeScript directly, so there's no build step.

```sh
npm install
npm test
npm run dev
```

- `src/jellyfin/`: the Jellyfin API (routes, item mapping, playback)
- `src/stremio/`: the addon protocol, addon management, account sync, watched-episode format
- `src/streams/`: stream parsing, cache filtering, sorting, link resolution
- `src/torbox.ts`: the TorBox API client
- `src/admin/`: the settings page

## Disclaimer

Bridgefin contains no media and no addons that provide media. It only connects apps that speak
the Jellyfin API to Stremio addons and a debrid account that **you** choose and configure. You
are responsible for the addons you install and for making sure your use complies with the laws
where you live and with the terms of the services you use.

Bridgefin is not affiliated with Jellyfin, Stremio, TorBox, Firecore (Infuse) or Swiftfin.

## License

[MIT](LICENSE)
