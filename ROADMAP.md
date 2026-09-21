# Roadmap

A task list, highest priority first. Write each task so an agent can pick it up cold: the current state, what to do, and how to check it worked. Update this file when you finish a task or find a new one.

## Tasks

- [ ] **Render cutover** (priority: high; blocks merging `development` into `main`)

  **Why it needs care.** `main` has a `render.yaml` with `autoDeploy: true`, so merging deploys. `development` changes that service from `runtime: node` to `runtime: docker`. Render does not allow changing a service's `runtime` after creation, so the existing Node service cannot be converted by the merge. The owner has to delete it in the Render dashboard first. An agent cannot do the dashboard steps.

  **State on 2026-09-21.**
  - `development` holds the whole change: the Python addon in `dd2f28b`, with the docs commits after it. It is not pushed and there is no PR.
  - The Python addon was tested on Stremio desktop and a phone, running as a Docker image on a datacenter IP (a Linode behind CapRover, since removed). It has **not** been run on Render and **not** tested on a TV.
  - A local Docker run with only Render-style settings (`PORT=10000`, `RENDER_EXTERNAL_URL` set, no `PUBLIC_BASE_URL`) served the manifest, a stream with the right URL, and the master.

  **New config.** `render.yaml`: web service `pijamot-stremio-addon`, `runtime: docker`, `plan: free`, `healthCheckPath: /manifest.json`, `autoDeploy: true`. It sets no env vars: the app takes its public URL from `RENDER_EXTERNAL_URL`, which Render sets on web services. `PUBLIC_BASE_URL` overrides it. The image listens on `$PORT` (Render injects it).

  **Old config, for rollback.** `main` at `510d65d` has:
  ```yaml
  services:
    - type: web
      name: pijamot-stremio-addon
      runtime: node
      plan: free
      buildCommand: npm install
      startCommand: npm start
      autoDeploy: true
  ```
  `npm start` ran `index.js` (manifest id `il.yael.pijamot.dailymotion`, v1.0.1, opens the Dailymotion page as an external link). `index-tv.js` (id `il.yael.pijamot.dailymotion.tv`, v2.0.0) hardcoded `https://pijamot-stremio-tv.onrender.com`, which suggests a **second** Render service, `pijamot-stremio-tv`, created by hand and started with `node index-tv.js`. `render.yaml` never defined it, so the merge will not touch it. It is broken today (the HLS 403 turns into a 500).

  **Steps.**
  1. In the Render dashboard, list the services. Note each one's name, URL, repo and branch, start command, and whether it was created from a Blueprint. Confirm which one `pijamot-stremio-addon` is, and whether `pijamot-stremio-tv` exists.
  2. Delete the Node service named `pijamot-stremio-addon`. The addon is down until the new service is up, and the first Docker build takes a few minutes.
  3. Push `development`, open a PR to `main`, and merge with the owner's go-ahead. If the service was created from a Blueprint, Render creates the Docker service from `render.yaml`. If it was created by hand, create a new Web Service in the dashboard instead: Docker runtime, this repo, branch `main`, health check path `/manifest.json`, Free plan, same name.
  4. Read the real hostname from the dashboard. If Render did not give it back the name `pijamot-stremio-addon`, the hostname will have a suffix. That is fine, because the app builds URLs from `RENDER_EXTERNAL_URL`, but the install URL changes.
  5. Verify (below).
  6. In Stremio, remove the old addons and install `https://<hostname>/manifest.json`. The manifest id `il.yael.pijamot.dailymotion.tv` is unchanged, so a stale install of the old TV addon may need removing first. Test a phone and then a TV.
  7. Once it works, the owner can delete `pijamot-stremio-tv` if it exists.

  **Verify.** Use the real hostname:
  ```bash
  BASE=https://pijamot-stremio-addon.onrender.com
  curl -s $BASE/manifest.json
  curl -s "$BASE/stream/series/tt0928368:1:1.json"
  curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $BASE/master/x9350zg.m3u8
  ```
  Expect: the manifest with version `3.0.0`; one stream whose `url` starts with `$BASE/master/x9350zg.m3u8`, which shows `RENDER_EXTERNAL_URL` was picked up; and `200 application/vnd.apple.mpegurl` for the master. Then play S1E1 in Stremio. Render's logs should show `Loaded 217 Pijamot episodes` and lines like `pijamot.hls: master x9350zg cache=miss resolve_ms=... step=randomized-headers formats=4 hd=yes retried=no`.

  **If something looks off.**
  - `step=` naming an impersonation, resolves failing with a 403, or `formats=0` means Render's IPs are treated differently from the ones we tested. Read the ladder task below and the Dailymotion section of `AGENTS.md` before changing anything.
  - `hd=no retried=yes` on many requests is the reduced-ladder problem, and is worse than on the test IP.
  - The free plan spins down when idle. The first request after a pause is slow, and Stremio may time out on it. Retry.

  **Rollback.** Deleting the old service cannot be undone from git. To restore it, recreate a Node service from `510d65d` with the config above. `git revert` on `main` only restores the files.
- [ ] **Update the manifest description** (priority: medium). `MANIFEST['description']` in `app/main.py` still reads `ניגון פרקי הפיג'מות דרך Render proxy.` ("playing Pijamot episodes via a Render proxy"). That is no longer true: the server only builds a playlist and the video comes from Dailymotion's CDN, and the addon can run on any Docker host. Stremio shows this text in the addon list, so it is worth fixing before the Render cutover, so the reinstall shows the right text the first time. The wording is user-facing Hebrew, so ask the owner for it. If it lands before the first deploy of `3.0.0`, keep the version. After that, bump `MANIFEST['version']`. No test checks the description text today.
- [ ] **Two small code gaps in `EpisodeCatalog`** (priority: medium). Both are inherited from the original `index.js`. Changing them departs from the old behavior, so confirm with the owner before implementing.
  - **Unknown episodes force a full refresh.** `EpisodeCatalog.get` in `app/episodes.py` calls `refresh(force=True)` on every miss, which fetches all 9 playlists from Dailymotion. Episodes missing from the archive (as of 2026-09-21: season 1 episodes 2 and 8, season 2 episode 10, season 4 episode 2, season 5 episodes 13 and 34) trigger it every time someone opens them, and the stream route is public. One direction: force a refresh only if the last one is older than a set interval. `test_catalog_forces_a_refresh_on_a_miss` in `tests/test_episodes.py` encodes the current behavior and would change.
  - **A failed season vanishes from the map.** In `EpisodeCatalog._load`, a season whose playlist fetch fails contributes nothing, and the new map (from the other seasons) replaces the old one. That season's episodes then show no links until the next refresh. The failure is logged as `[playlist refresh]`. The old map is only kept when a refresh finds nothing at all. One direction: carry over the previous episodes of any season whose fetch failed. `test_catalog_survives_a_failing_season` only checks that the other seasons still load.
- [ ] **Intermittent low-quality ladder** (priority: low). From a datacenter IP, yt-dlp sometimes gets a master with only 288p and 480p. `hls.resolve_with_retry` retries once, which lowered the rate from roughly 40–60 % to about 25 % of resolves on the test Linode, and the single retry is accepted for now. Not yet tried: a `Referer: https://www.dailymotion.com` header, `priority: u=1, i`, `Sec-CH-UA*` headers, forced Chrome impersonation (`curl-cffi` is already installed). Measure inside a container on a datacenter IP, since the problem did not appear from a residential one. See `AGENTS.md` for the numbers.
- [ ] Playlist requests use `limit=100` with no pagination, so a season with more than 100 videos would be truncated (priority: low).

## Done

- [x] **Bug: `index-tv.js` `/play/:videoId/master.m3u8` returned 500 (Dailymotion 403 on the HLS manifest)**
  - Cause: Dailymotion gates the `cdndirector` master by request fingerprint (Node `fetch` and HTTP/2 `curl` get a 403 even with browser headers), and the master's `sec=` token is bound to the IP that fetched it.
  - Fix: the server was rewritten in Python (FastAPI). yt-dlp resolves the video and returns one open variant URL per quality, the server serves a master built from them, and the player fetches variants and segments straight from Dailymotion's CDN.
  - Tested on Stremio desktop and phone. Not yet on Render or a TV (see the cutover task).
