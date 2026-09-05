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
  id: 'il.yael.pijamot.dailymotion.tv',
  version: '1.1.0',
  name: "הפיג'מות – Dailymotion TV",
  description: "ניגון ישיר של פרקי הפיג'מות ב-Stremio.",
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
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpisodeTitle(title) {
  const clean = normalizeText(title);

  const match = clean.match(
    /הפיג['׳’]?מות\s+עונה\s+(\d+)\s+פרק\s+(\d+)/u
  );

  if (!match) {
    return null;
  }

  return {
    season: Number(match[1]),
    episode: Number(match[2])
  };
}

async function fetchPlaylist(season, playlistId) {
  const apiUrl =
    `https://api.dailymotion.com/playlist/${playlistId}/videos` +
    `?fields=id,title,url&limit=100`;

  const response = await fetch(apiUrl);

  if (!response.ok) {
    throw new Error(
      `Playlist API HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!data || !Array.isArray(data.list)) {
    throw new Error(
      'Invalid playlist response'
    );
  }

  const found = [];

  for (const video of data.list) {
    const parsed =
      parseEpisodeTitle(video.title);

    if (!parsed) continue;
    if (parsed.season !== season) continue;
    if (!video.id) continue;

    found.push({
      season: parsed.season,
      episode: parsed.episode,
      title: normalizeText(video.title),
      videoId: video.id,
      pageUrl:
        video.url ||
        `https://www.dailymotion.com/video/${video.id}`
    });
  }

  console.log(
    `Season ${season}: ${found.length} episodes`
  );

  return found;
}

async function refreshEpisodeMap(force = false) {
  const now = Date.now();

  if (
    !force &&
    episodeMap.size &&
    now - lastRefresh < CACHE_MS
  ) {
    return;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {

    const nextMap = new Map();

    const results = await Promise.allSettled(
      Object.entries(PLAYLISTS).map(
        ([season, playlistId]) =>
          fetchPlaylist(
            Number(season),
            playlistId
          )
      )
    );

    for (const result of results) {

      if (result.status !== 'fulfilled') {
        console.error(
          'Playlist error:',
          result.reason
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
        `Loaded ${episodeMap.size} episodes`
      );
    }

  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function getDirectVideoUrl(videoId) {

  const metadataUrl =
    `https://www.dailymotion.com/player/metadata/video/${videoId}`;

  console.log(
    `Fetching metadata: ${metadataUrl}`
  );

  const response = await fetch(metadataUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept':
        'application/json,text/plain,*/*'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Metadata HTTP ${response.status}`
    );
  }

  const metadata =
    await response.json();

  const qualities =
    metadata.qualities || {};

  const preferred =
    ['1080', '720', '480', '380', '360', '240'];

  for (const quality of preferred) {

    const sources =
      qualities[quality];

    if (!Array.isArray(sources)) {
      continue;
    }

    for (const source of sources) {

      if (
        source &&
        source.url &&
        source.type === 'video/mp4'
      ) {
        console.log(
          `Found MP4 ${quality}`
        );

        return source.url;
      }
    }
  }

  for (const sources of Object.values(qualities)) {

    if (!Array.isArray(sources)) {
      continue;
    }

    for (const source of sources) {

      if (
        source &&
        source.url &&
        (
          source.type ===
            'application/x-mpegURL' ||
          source.url.includes('.m3u8')
        )
      ) {
        console.log(
          'Found HLS stream'
        );

        return source.url;
      }
    }
  }

  throw new Error(
    'No direct stream found'
  );
}

builder.defineStreamHandler(
  async ({ type, id }) => {

    console.log(
      `Stream request: ${id}`
    );

    if (
      type !== 'series' ||
      !id.startsWith(
        `${SERIES_IMDB_ID}:`
      )
    ) {
      return {
        streams: []
      };
    }

    const match =
      id.match(
        /^tt0928368:(\d+):(\d+)$/
      );

    if (!match) {
      return {
        streams: []
      };
    }

    const season =
      Number(match[1]);

    const episode =
      Number(match[2]);

    const key =
      `${season}:${episode}`;

    await refreshEpisodeMap(false);

    let item =
      episodeMap.get(key);

    if (!item) {

      await refreshEpisodeMap(true);

      item =
        episodeMap.get(key);
    }

    if (!item) {

      console.log(
        `Episode not found: ${key}`
      );

      return {
        streams: []
      };
    }

    try {

      const directUrl =
        await getDirectVideoUrl(
          item.videoId
        );

      console.log(
        `Direct stream found for ${key}`
      );

      return {
        streams: [
          {
            name:
              'Dailymotion Direct',
            title:
              item.title,
            url:
              directUrl
          }
        ]
      };

    } catch (error) {

      console.error(
        'Direct stream error:',
        error.message
      );

      return {
        streams: [
          {
            name:
              'Dailymotion',
            title:
              `${item.title} – פתיחה חיצונית`,
            externalUrl:
              item.pageUrl
          }
        ]
      };
    }
  }
);

const PORT =
  Number(
    process.env.PORT || 7000
  );

serveHTTP(
  builder.getInterface(),
  {
    port: PORT
  }
);

console.log(
  `Pijamot TV addon running on port ${PORT}`
);  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpisodeTitle(title) {
  const clean = normalizeText(title);

  const match = clean.match(
    /הפיג['׳’]?מות\s+עונה\s+(\d+)\s+פרק\s+(\d+)/u
  );

  if (!match) {
    return null;
  }

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
      'user-agent': 'PijamotStremioAddonTV/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Dailymotion API returned HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!data || !Array.isArray(data.list)) {
    throw new Error(
      `Unexpected Dailymotion response`
    );
  }

  const found = [];

  for (const video of data.list) {
    const title = normalizeText(video.title);
    const parsed = parseEpisodeTitle(title);

    if (!parsed) continue;
    if (parsed.season !== season) continue;
    if (!video.id) continue;

    found.push({
      season: parsed.season,
      episode: parsed.episode,
      title,
      videoId: video.id,

      pageUrl:
        video.url ||
        `https://www.dailymotion.com/video/${video.id}`,

      embedUrl:
        `https://www.dailymotion.com/embed/video/${video.id}`
    });
  }

  console.log(
    `Season ${season}: found ${found.length} episodes`
  );

  return found;
}

async function refreshEpisodeMap(force = false) {
  const now = Date.now();

  if (
    !force &&
    episodeMap.size &&
    now - lastRefresh < CACHE_MS
  ) {
    return;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const nextMap = new Map();

    const results = await Promise.allSettled(
      Object.entries(PLAYLISTS).map(
        ([season, playlistId]) =>
          fetchPlaylist(
            Number(season),
            playlistId
          )
      )
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') {
        console.error(
          '[playlist refresh]',
          result.reason?.message ||
          result.reason
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
        `Loaded ${episodeMap.size} episodes`
      );
    } else {
      console.error(
        'Loaded 0 episodes'
      );
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

builder.defineStreamHandler(
  async ({ type, id }) => {

    console.log(
      `[stream request] type=${type} id=${id}`
    );

    if (
      type !== 'series' ||
      !id.startsWith(
        `${SERIES_IMDB_ID}:`
      )
    ) {
      return {
        streams: []
      };
    }

    const match = id.match(
      /^tt0928368:(\d+):(\d+)$/
    );

    if (!match) {
      return {
        streams: []
      };
    }

    const season = Number(match[1]);
    const episode = Number(match[2]);

    const key =
      `${season}:${episode}`;

    try {
      await refreshEpisodeMap(false);
    } catch (err) {
      console.error(
        'Refresh failed:',
        err
      );
    }

    let item =
      episodeMap.get(key);

    if (!item) {
      try {
        await refreshEpisodeMap(true);

        item =
          episodeMap.get(key);

      } catch (err) {
        console.error(
          'Forced refresh failed:',
          err
        );
      }
    }

    if (!item) {
      console.log(
        `[stream miss] ${key}`
      );

      return {
        streams: []
      };
    }

    console.log(
      `[stream hit] ${key}`
    );

    return {
      streams: [
        {
          name: 'Dailymotion TV',
          title:
            `${item.title} – נגן בתוך Stremio`,

          playerFrameUrl:
            item.embedUrl
        },

        {
          name: 'Dailymotion',
          title:
            `${item.title} – פתיחה חיצונית`,

          externalUrl:
            item.pageUrl
        }
      ]
    };
  }
);

const PORT = Number(
  process.env.PORT || 7000
);

serveHTTP(
  builder.getInterface(),
  {
    port: PORT
  }
);

console.log(
  `Pijamot TV addon running on port ${PORT}`
);
