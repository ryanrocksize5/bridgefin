# Stremio → Jellyfin bridge ("Bridgefin") — design

## Intent

iPhones have no native Stremio app, so Stremio addon content is hard to watch there.
This server speaks the Jellyfin API so Jellyfin clients on iOS — **Infuse first, Swiftfin
second** — can browse and play Stremio addon content as if it were a Jellyfin library.
Streams come from the user's **TorBox** account, cached torrents only, so playback is a
plain HTTPS file from TorBox's CDN.

The owner tried Gelato (a plugin inside a full Jellyfin server) and did not like it; they
want something **very lightweight** that does only this job.

## Goals

- Log in from Infuse / Swiftfin with a username + password.
- Home: Continue Watching, Next Up, My Library, and chosen addon catalogs.
- Browse each chosen addon catalog as a library (live, paged); genre filtering where the
  catalog supports it.
- Search across every addon catalog that supports search.
- Details pages: poster, backdrop, logo, plot, cast, rating, year, runtime, trailers,
  IMDb/TMDB ids (Infuse enriches from these itself).
- Series → seasons → episodes.
- Stream picker: every cached TorBox stream for a title is one Jellyfin "version",
  labelled like Stremio (`4K HDR · 18.2 GB · Torrentio`), best first.
- Playback by direct play only — no transcoding, no ffmpeg.
- Subtitles from subtitle addons (e.g. OpenSubtitles v3) as external tracks.
- Favorites = Stremio library (add/remove).
- Watched marks, resume position, Continue Watching, Next Up.
- Small web settings page: TorBox key, addons (install by URL, order, enable/disable),
  which catalogs appear as libraries, stream preferences, Stremio account link.
- **Works with no Stremio account and survives Stremio's servers being down.**
  Optional Stremio account link imports addons and library and syncs progress.
- Ships as a Docker image (docker compose), runs on a home PC or a small VPS.

## Non-goals

- Transcoding / remuxing, the official Jellyfin iOS app.
- Uncached torrents, P2P torrent streaming, local files.
- Multiple users (one user, as Stremio has one account).
- Trakt (Infuse does Trakt itself).
- Live TV / channel addons (possible later, after testing Infuse support).

## Anti-goals (failure even if it "works")

- Heavy: large image, high idle RAM/CPU, many dependencies.
- Adding torrents to the user's TorBox account just because they browsed a page.
- Corrupting the user's real Stremio library through bad sync writes.
- Hard dependence on Stremio's own servers being up.

## Constraints

- No iPhone/Infuse available during development: compatibility is checked against a real
  Jellyfin 10.11 server's responses (captured in Docker) and against jellyfin-web.
- No TorBox key or Stremio login during development: TorBox is mocked in tests; Cinemeta
  and plain Torrentio are public and used live.
- Node 24 (built-in `node:sqlite`, native TypeScript type-stripping) — pinned in Docker.

## Approaches considered

1. **Node 24 + TypeScript, zero/near-zero runtime deps** (built-in http, fetch, sqlite,
   zlib). Small image (~60 MB alpine), ~40–60 MB RAM. Same language as the Stremio
   ecosystem (addon SDK, stremio-core JS ports), JSON-heavy work is natural. **Chosen.**
2. **Go single binary** — smallest footprint (~15 MB image, ~10 MB RAM), but Go isn't
   installed here and the big gain over (1) is marginal for a single-user server.
3. **Jellyfin plugin (Gelato-style)** — rejected: requires a full Jellyfin server, which is
   exactly what the owner wants to avoid.

The owner handed over the "how"; approach 1 is my call.

## Decided by the owner

- Infuse primary, Swiftfin must also work → direct play only.
- TorBox API key, cached streams only.
- Local-first, with optional Stremio account sync (both modes).
- Docker packaging.
- Feature mapping (table in conversation) accepted as-is.

## Design

### Components

```
iPhone (Infuse/Swiftfin) ──Jellyfin API──► Bridgefin ──► Stremio addons (catalog/meta/stream/subtitles)
        │                                     │  └────► TorBox API (check cache, add, request link)
        └──── video bytes (302 → TorBox CDN) ◄┘  └────► api.strem.io (optional sync)
                                             SQLite (settings, addons, ids, library, progress, caches)
```

- **http/router** — tiny case-insensitive router on `node:http`; strips optional
  `/emby` / `/jellyfin` prefixes; parses all Jellyfin auth header variants; logs every
  unhandled route (method, path, query, user agent) and returns a harmless empty result.
- **ids** — persistent table mapping Stremio keys (`movie:tt123`, `series:tt123`,
  `season:tt123:1`, `episode:tt123:1:2`, `catalog:<addon>:<type>:<id>`) ↔ 32-hex ids
  (MD5 of the key). Deterministic and reversible via DB.
- **addons** — manifest fetch/cache, catalog/meta/stream/subtitle calls with timeouts,
  per-response caching (catalog pages 6 h, meta 7 days stored in SQLite so Cinemeta
  outages don't break the library, streams 30 min in memory).
- **streams** — collects streams for a video from all stream addons, keeps:
  `url` streams (addon already resolved via TorBox; uncached markers filtered) and
  `infoHash` streams that TorBox reports cached (batched `checkcached`). Parses quality,
  HDR/DV, codec, size, source from name/title/filename; sorts by user preference.
- **torbox** — check cached (batched), create torrent only at play time, find file
  (fileIdx / filename / largest video, episode match), request download link; cache
  resolved links in SQLite with TTL.
- **playback** — `PlaybackInfo` returns one MediaSource per stream (lazy: no TorBox
  writes). `/Videos/{id}/stream` resolves the chosen source then 302-redirects
  (default) or proxies with Range support (`PLAYBACK_MODE=proxy`).
- **jellyfin mappers** — Stremio meta → BaseItemDto (Movie/Series/Season/Episode),
  catalogs → CollectionFolder views, images via `/Items/{id}/Images/...` proxy.
- **userdata** — favorites (= library), played, position, play count, last played;
  Continue Watching, Next Up, Latest derived from it.
- **stremio sync** (optional) — login stores only the authKey; imports addons and library;
  pulls periodically; **write-back is off by default** and behind a setting, and the
  watched-bitfield encoder must pass stremio-core test vectors before enabling it.
- **admin UI** — server-rendered HTML at `/admin`, same password.

### Data model (SQLite)

settings(k,v) · addons(id, transport_url, manifest, position, enabled) ·
catalogs_enabled(addon_id, type, catalog_id, enabled, position) · ids(hex, key) ·
meta_cache(key, json, fetched_at) · library(key, type, name, poster, added_at, removed,
mtime) · userdata(key, played, position_ticks, play_count, last_played, favorite, mtime) ·
link_cache(stream_key, url, expires_at) · tokens(token, device_id, device, client,
created_at) · sync_state(k, v).

### Paging & limits

Catalog libraries are paged live; Library-Mode recursive walks are capped per catalog
(`CATALOG_LIMIT`, default 200) with an honest `TotalRecordCount`.

## Left to the builder

Exact Jellyfin JSON shapes (copy from the reference server), heuristics for stream
labelling, cache TTL tuning, admin page styling.

## Unverifiable here — must be tested on a real device

Infuse Direct-Mode search, Infuse version picker, Infuse following 302 to TorBox CDN,
real TorBox resolution, Stremio account sync.
