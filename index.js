const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');

const SERIES_IMDB_ID = 'tt0928368';

const PLAYLISTS = {
  1: 'x8kmxm',
  2: 'x8kmxy',
  3: 'x8kmy6',
  4: 'x8kmy8',
  5: 'x8kmya',
  6: 'x8kmye',
  7: 'x8nroo',
  8: 'x8nroq',
  9: 'x8nrow'
};

const manifest = {
  id: 'il.yael.pijamot.dailymotion',
  version: '1.0.0',
  name: 'הפיג\'מות – Dailymotion Archive',
  description: 'מקורות צפייה לפרקי הפיג\'מות מהארכיון הציבורי ThePijamasArchive ב-Dailymotion.',
  resources: ['stream'],
  types: ['series'],
  catalogs: [],
  idPrefixes: [SERIES_IMDB_ID]
};

const builder = new addonBuilder(manifest);

// season:episode -> { url, title }
let episodeMap = new Map();
let lastRefresh = 0;
let refreshPromise = null;
const CACHE_MS = 6 * 60 * 60 * 1000;

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpisodeTitle(title) {
  const clean = normalizeText(title);
  const match = clean.match(/הפיג['׳’]?מות\s+עונה\s+(\d+)\s+פרק\s+(\d+)/u);
  if (!match) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

async function fetchPlaylist(season, playlistId) {
  const url = `https://www.dailymotion.com/playlist/${playlistId}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; PijamotStremioAddon/1.0)',
      'accept-language': 'he,en;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`Dailymotion playlist ${playlistId} returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const found = [];

  $('a').each((_, el) => {
    const title = normalizeText($(el).text());
    const parsed = parseEpisodeTitle(title);
    if (!parsed || parsed.season !== season) return;

    const href = $(el).attr('href') || '';
    const videoMatch = href.match(/\/video\/([a-zA-Z0-9]+)/);
    if (!videoMatch) return;

    found.push({
      season: parsed.season,
      episode: parsed.episode,
      title,
      url: `https://www.dailymotion.com/video/${videoMatch[1]}`
    });
  });

  // Some page variants keep useful video/title pairs in serialized JSON rather than anchors.
  // This fallback scans small windows around every Hebrew episode title for a video id.
  if (found.length === 0) {
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&');
    const titleRegex = /הפיג['׳’]?מות\s+עונה\s+(\d+)\s+פרק\s+(\d+)[^"<\\]{0,160}/gu;
    let m;
    while ((m = titleRegex.exec(decoded)) !== null) {
      if (Number(m[1]) !== season) continue;
      const start = Math.max(0, m.index - 700);
      const end = Math.min(decoded.length, m.index + 700);
      const window = decoded.slice(start, end);
      const idMatch = window.match(/(?:\/video\/|"id"\s*:\s*")([a-zA-Z0-9]{5,})/);
      if (!idMatch) continue;
      found.push({
        season: Number(m[1]),
        episode: Number(m[2]),
        title: normalizeText(m[0]),
        url: `https://www.dailymotion.com/video/${idMatch[1]}`
      });
    }
  }

  return found;
}

async function refreshEpisodeMap(force = false) {
  const now = Date.now();
  if (!force && episodeMap.size && now - lastRefresh < CACHE_MS) return;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const nextMap = new Map();
    const results = await Promise.allSettled(
      Object.entries(PLAYLISTS).map(async ([season, playlistId]) => {
        return fetchPlaylist(Number(season), playlistId);
      })
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') {
        console.error('[playlist refresh]', result.reason?.message || result.reason);
        continue;
      }
      for (const item of result.value) {
        nextMap.set(`${item.season}:${item.episode}`, item);
      }
    }

    // Never replace a working cache with an empty one if Dailymotion has a temporary issue.
    if (nextMap.size > 0) {
      episodeMap = nextMap;
      lastRefresh = Date.now();
      console.log(`Loaded ${episodeMap.size} Pijamot episodes from Dailymotion.`);
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'series' || !id.startsWith(`${SERIES_IMDB_ID}:`)) {
    return { streams: [] };
  }

  const match = id.match(/^tt0928368:(\d+):(\d+)$/);
  if (!match) return { streams: [] };

  const season = Number(match[1]);
  const episode = Number(match[2]);
  const key = `${season}:${episode}`;

  try {
    await refreshEpisodeMap(false);
  } catch (err) {
    console.error('Initial refresh failed:', err);
  }

  let item = episodeMap.get(key);

  // One forced refresh helps if a playlist was edited after the cache was built.
  if (!item) {
    try {
      await refreshEpisodeMap(true);
      item = episodeMap.get(key);
    } catch (err) {
      console.error('Forced refresh failed:', err);
    }
  }

  if (!item) return { streams: [] };

  return {
    streams: [
      {
        name: 'Dailymotion',
        title: item.title,
        externalUrl: item.url
      }
    ]
  };
});

const PORT = Number(process.env.PORT || 7000);
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Pijamot Stremio addon running on port ${PORT}`);
console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
