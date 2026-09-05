const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

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
  version: '1.0.1',
  name: "הפיג'מות – Dailymotion Archive",
  description: "מקורות צפייה לפרקי הפיג'מות מהארכיון הציבורי ThePijamasArchive ב-Dailymotion.",
  resources: ['stream'],
  types: ['series'],
  catalogs: [],
  idPrefixes: [SERIES_IMDB_ID]
};

const builder = new addonBuilder(manifest);

let episodeMap = new Map();
let lastRefresh = 0;
let refreshPromise = null;
const CACHE_MS = 6 * 60 * 60 * 1000;

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseEpisodeTitle(title) {
  const clean = normalizeText(title);

  const match = clean.match(
    /הפיג['׳’]?מות\s+עונה\s+(\d+)\s+פרק\s+(\d+)/u
  );

  if (!match) return null;

  return {
    season: Number(match[1]),
    episode: Number(match[2])
  };
}

async function fetchPlaylist(season, playlistId) {
  const apiUrl =
    `https://api.dailymotion.com/playlist/${playlistId}/videos` +
    `?fields=id,title,url&limit=100`;

  const response = await fetch(apiUrl, {
    headers: {
      'user-agent': 'PijamotStremioAddon/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Dailymotion API playlist ${playlistId} returned HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!data || !Array.isArray(data.list)) {
    throw new Error(
      `Unexpected Dailymotion response for playlist ${playlistId}`
    );
  }

  const found = [];

  for (const video of data.list) {
    const title = normalizeText(video.title);
    const parsed = parseEpisodeTitle(title);

    if (!parsed || parsed.season !== season) continue;
    if (!video.id) continue;

    found.push({
      season: parsed.season,
      episode: parsed.episode,
      title,
      url:
        video.url ||
        `https://www.dailymotion.com/video/${video.id}`
    });
  }

  console.log(
    `Playlist season ${season} (${playlistId}): found ${found.length} episodes`
  );

  return found;
}

async function refreshEpisodeMap(force = false) {
  const now = Date.now();

  if (!force && episodeMap.size && now - lastRefresh < CACHE_MS) {
    return;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const nextMap = new Map();

    const results = await Promise.allSettled(
      Object.entries(PLAYLISTS).map(([season, playlistId]) =>
        fetchPlaylist(Number(season), playlistId)
      )
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') {
        console.error(
          '[playlist refresh]',
          result.reason?.message || result.reason
        );
        continue;
      }

      for (const item of result.value) {
        nextMap.set(
          `${item.season}:${item.episode}`,
          item
        );
      }
    }

    if (nextMap.size > 0) {
      episodeMap = nextMap;
      lastRefresh = Date.now();

      console.log(
        `Loaded ${episodeMap.size} Pijamot episodes from Dailymotion.`
      );
    } else {
      console.error(
        'Dailymotion refresh returned 0 matching Pijamot episodes.'
      );
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream request] type=${type} id=${id}`);

  if (
    type !== 'series' ||
    !id.startsWith(`${SERIES_IMDB_ID}:`)
  ) {
    return { streams: [] };
  }

  const match = id.match(
    /^tt0928368:(\d+):(\d+)$/
  );

  if (!match) {
    return { streams: [] };
  }

  const season = Number(match[1]);
  const episode = Number(match[2]);
  const key = `${season}:${episode}`;

  try {
    await refreshEpisodeMap(false);
  } catch (err) {
    console.error(
      'Initial refresh failed:',
      err
    );
  }

  let item = episodeMap.get(key);

  if (!item) {
    try {
      await refreshEpisodeMap(true);
      item = episodeMap.get(key);
    } catch (err) {
      console.error(
        'Forced refresh failed:',
        err
      );
    }
  }

  if (!item) {
    console.log(`[stream miss] ${key}`);

    return {
      streams: []
    };
  }

  console.log(
    `[stream hit] ${key} -> ${item.url}`
  );

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

const PORT = Number(
  process.env.PORT || 7000
);

serveHTTP(
  builder.getInterface(),
  { port: PORT }
);

console.log(
  `Pijamot Stremio addon running on port ${PORT}`
);
