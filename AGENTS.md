# AGENTS.md

Guidance for AI agents working in this repo. `README.md` (Hebrew) is the user-facing doc and `ROADMAP.md` tracks open work.

## What this project is

A [Stremio](https://www.stremio.com) stream addon for the Israeli kids' series **הפיג'מות** (IMDb `tt0928368`). It looks up episodes in the public Dailymotion playlists of `ThePijamasArchive` and returns them as playable streams. It stores no video.

### Stremio addon primer

A Stremio addon is an HTTP service that serves a `manifest.json` and answers resource requests. This addon only implements `stream`:

- Stremio requests `GET /stream/series/tt0928368:<season>:<episode>.json` (ids arrive percent-encoded, `%3A` for `:`).
- The addon replies with `{ "streams": [...] }`. An empty array means "no source".
- Every route must send `Access-Control-Allow-Origin: *`. Addon URLs must be HTTPS, except `127.0.0.1`.
- **Never send both `title` and `description` on a stream.** Stremio's parser (stremio-core) treats `title` as an alias of `description`, so a stream with both fails to parse and Stremio shows "no links". This repo sends `title` only.
- Protocol: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

## Layout

| Path | Role |
|---|---|
| `app/main.py` | FastAPI app: manifest, stream and master routes, CORS, public base URL |
| `app/episodes.py` | `SERIES_IMDB_ID`, `PLAYLISTS`, title parsing, playlist fetch, `EpisodeCatalog` (6 h cache) |
| `app/hls.py` | yt-dlp resolve, one retry for a missing HD ladder, master playlist synthesis, 60 s cache |
| `tests/` | pytest suite. Offline by default; `test_live.py` hits the real Dailymotion (`-m live`) |
| `Dockerfile` | `python:3.12-slim`, listens on `${PORT}` (default 80) |
| `render.yaml` | Render web service `pijamot-stremio-addon`, `runtime: docker`, `autoDeploy: true` |
| `requirements.txt`, `requirements-dev.txt` | Runtime and dev dependencies |
| `ROADMAP.md` | Open tasks |

## How it works

1. At startup `EpisodeCatalog` loads the 9 season playlists (about 217 episodes). The season and episode come from the **video title**, never from playlist position.
2. `GET /stream/...` maps the episode to a Dailymotion video id and returns one stream whose `url` is `<public base>/master/<videoId>.m3u8`, with `behaviorHints.notWebReady: true`. It never calls yt-dlp, so it stays fast when Dailymotion is broken. Unknown episodes, wrong types and malformed ids get `200 {"streams": []}`.
3. `GET|HEAD /master/<videoId>.m3u8` answers 404 for ids not in the catalog, then resolves the video with yt-dlp (about 0.5 to 1 s) and **synthesizes** an HLS master from the formats yt-dlp returns (lowest bandwidth first). It is cached for 60 s, since Stremio requests it several times and sends `HEAD` probes.
4. The player fetches the variant playlists and segments straight from Dailymotion's CDN. No video passes through this server.

The public base URL is `PUBLIC_BASE_URL` if set, otherwise `RENDER_EXTERNAL_URL` (Render sets that itself). The app refuses to start without one of them.

## Dailymotion behavior we measured

These drove the design. Re-check them before changing the approach.

- **Only the master manifest is gated** (`cdndirector.dailymotion.com`, Cloudflare 403 with `x-error-code: E005`). It is gated by request fingerprint: a Chrome User-Agent over HTTP/1.1 passes in Python, while Node `fetch` and HTTP/2 `curl` get a 403 even with identical headers. Variant playlists and segments (`vod3.cf.dmcdn.net`) are open to any client.
- **The master's `sec=` token is bound to the IP that fetched it.** A URL resolved on one machine got a 403 from another. Never hand Stremio Dailymotion's own master URL: the server and the player have different IPs.
- **Variant and segment tokens are not IP-bound**, and stayed valid for at least 60 minutes. The longest episode is about 28 minutes.
- yt-dlp's Dailymotion extractor already handles the gate (randomized headers, then Chrome and Firefox impersonation; upstream issue [#15526](https://github.com/yt-dlp/yt-dlp/issues/15526)). That is why our code never makes the gated request itself.
- **Intermittent reduced ladder.** From a datacenter IP, yt-dlp sometimes gets a master with only 288p and 480p (the 720p60 and 1080p60 variants are missing). It happened in roughly 40 to 60 % of resolves from a Linode and about 25 % after the single retry in `hls.resolve_with_retry`. It did not happen from a residential IP. Plain `urllib` requests from the same datacenter IP always got the full ladder, so the trigger is in yt-dlp's own request path. Upstream reports describe similar soft degradation but no fix. Untried ideas: a `Referer` header, `priority: u=1, i`, `Sec-CH-UA*` headers, forced Chrome impersonation.

## Commands

Python 3.12.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

PUBLIC_BASE_URL=http://127.0.0.1:7000 .venv/bin/uvicorn app.main:app --port 7000

.venv/bin/python -m pytest             # offline suite
.venv/bin/python -m pytest -m live     # real Dailymotion (network)

docker build -t pijamot .
docker run --rm -p 7000:80 -e PUBLIC_BASE_URL=http://127.0.0.1:7000 pijamot
```

pytest prints a Starlette deprecation warning about `httpx`. It is harmless.

## Verifying changes

Tests cover the protocol shape, but only real playback catches Stremio-side problems (the `title`/`description` bug passed the server checks and failed in the app).

1. `pytest`, then `pytest -m live` if you touched `hls.py` or `episodes.py`.
2. Run the server and `curl` `/manifest.json`, `/stream/series/tt0928368:1:1.json`, `/master/x9350zg.m3u8` (season 1, episode 1) and `HEAD` on the master.
3. Install `http://127.0.0.1:7000/manifest.json` in Stremio desktop and play an episode. A phone or TV needs a public HTTPS URL.

Say so if you could not run the live tests.

## Rules

- **Do not change `SERIES_IMDB_ID` or the `PLAYLISTS` ids without asking.** They are the core data.
- **Do not add dependencies without asking.** Runtime: `fastapi`, `uvicorn`, `yt-dlp[default,curl-cffi]`. Dev: `pytest`, `httpx`.
- **Do not fetch Dailymotion's master from our own code.** Let yt-dlp do it. Hand-tuned headers rot when Dailymotion changes the gate.
- Keep `/master` restricted to ids in the episode catalog. It is public, and resolving costs time and yt-dlp work.
- When Dailymotion breaks playback, try upgrading yt-dlp first (`pip install -U yt-dlp`, rebuild the image). Extractor fixes land upstream.
- The manifest `id` (`il.yael.pijamot.dailymotion.tv`) stays. Keep user-facing Hebrew strings as they are.
- `README.md` is in Hebrew and `ROADMAP.md` in English. Update `README.md` when user-visible behavior changes.

## Deployment

`render.yaml` defines a Render Docker web service with `autoDeploy: true`, so **pushing to `main` deploys**. Do not push or change it without asking.

- Render does not allow changing a service's `runtime` after creation. Changing it means creating a new service.
- Render injects `PORT`; the image's default of 80 is for other hosts (for example CapRover), where `PUBLIC_BASE_URL` must be set to the public HTTPS URL.
- The free plan spins down when idle, so the first request after a pause is slow and the caches start empty.

## Known gaps

- Playlist requests use `limit=100` with no pagination. A season with more than 100 videos would be truncated.
- A season whose playlist fetch fails is missing from the map until the next refresh (it is logged). The old map is only kept when a refresh finds nothing at all.
- Every request for an unknown episode forces a refresh of all 9 playlists.
- Episodes missing from the archive always show no links, as of 2026-09-21: season 1 (2, 8), season 2 (10), season 4 (2), season 5 (13, 34).
- The manifest description still says "via Render proxy", which is no longer accurate.
