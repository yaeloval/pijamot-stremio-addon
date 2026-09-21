# Roadmap

## Tasks

- [ ] **Render cutover**
  - Render can't change a service's `runtime`, so the existing `pijamot-stremio-addon` service (Node) has to be deleted in the Render dashboard before this merges. The blueprint then creates the Docker service with the same name.
  - Reinstall the addon in Stremio from the new `https://<service>.onrender.com/manifest.json`. The manifest id is `il.yael.pijamot.dailymotion.tv`, version `3.0.0`.
  - After the first deploy, check `/manifest.json`, an episode stream, and that a master request logs `step=randomized-headers`.
- [ ] **Intermittent low-quality ladder**
  - From a datacenter IP, yt-dlp sometimes gets a master with only 288p and 480p. `hls.resolve_with_retry` retries once, which lowered the rate from roughly 40–60 % to about 25 % of resolves on the Linode used for testing.
  - Not yet tried: a `Referer: https://www.dailymotion.com` header, `priority: u=1, i`, `Sec-CH-UA*` headers, forced Chrome impersonation (`curl-cffi` is already installed). See `AGENTS.md` for the measurements.
  - Watch the `hd=` and `retried=` fields in the `pijamot.hls` log lines on Render, since its IPs may behave differently.
- [ ] Update the manifest description, which still says "via Render proxy".
- [ ] Playlist requests use `limit=100` with no pagination.

## Done

- [x] **Bug: `index-tv.js` `/play/:videoId/master.m3u8` returned 500 (Dailymotion 403 on the HLS manifest)**
  - Cause: Dailymotion gates the `cdndirector` master by request fingerprint (Node `fetch` and HTTP/2 `curl` get a 403 even with browser headers), and the master's `sec=` token is bound to the IP that fetched it.
  - Fix: the server was rewritten in Python (FastAPI). yt-dlp resolves the video and returns one open variant URL per quality, the server serves a master built from them, and the player fetches variants and segments straight from Dailymotion's CDN.
  - Tested on Stremio desktop and phone against a copy running on a datacenter IP. It has not been tested on Render or on a TV.
