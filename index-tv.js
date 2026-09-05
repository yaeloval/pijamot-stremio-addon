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
  version: '1.2.0',
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

const CACHE_MS = 6 * 60 * 60 * 1000;

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpisodeTitle(title) {
  const match = normalizeText(title).match(
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
  const url =
    `https://api.dailymotion.com/playlist/${playlistId}/videos` +
    `?fields=id,title,url&limit=100`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Playlist API HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const list =
    Array.isArray(data.list)
      ? data.list
      : [];

  const found = [];

  for (const video of list) {
    const parsed =
      parseEpisodeTitle(video.title);

    if (!parsed) {
      continue;
    }

    if (parsed.season !== season) {
      continue;
    }

    if (!video.id) {
      continue;
    }

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

  const results =
    await Promise.allSettled(
      Object.entries(PLAYLISTS).map(
        ([season, playlistId]) =>
          fetchPlaylist(
            Number(season),
            playlistId
          )
      )
    );

  const nextMap =
    new Map();

  for (const result of results) {
    if (
      result.status !==
      'fulfilled'
    ) {
      console.error(
        'Playlist error:',
        result.reason?.message ||
        result.reason
      );

      continue;
    }

    for (
      const item
      of result.value
    ) {
      nextMap.set(
        `${item.season}:${item.episode}`,
        item
      );
    }
  }

  if (nextMap.size > 0) {
    episodeMap =
      nextMap;

    lastRefresh =
      Date.now();

    console.log(
      `Loaded ${episodeMap.size} episodes`
    );
  }
}

async function getDirectVideoUrl(videoId) {
  const metadataUrl =
    `https://www.dailymotion.com/player/metadata/video/${videoId}`;

  console.log(
    `Fetching metadata for ${videoId}`
  );

  const response =
    await fetch(
      metadataUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 Chrome/120 Safari/537.36',

          'Accept':
            'application/json,text/plain,*/*',

          'Referer':
            'https://www.dailymotion.com/'
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Metadata HTTP ${response.status}`
    );
  }

  const metadata =
    await response.json();

  const qualities =
    metadata.qualities || {};

  const preferred = [
    '1080',
    '720',
    '480',
    '380',
    '360',
    '240'
  ];

  for (
    const quality
    of preferred
  ) {
    const sources =
      qualities[quality];

    if (
      !Array.isArray(sources)
    ) {
      continue;
    }

    const mp4 =
      sources.find(
        source =>
          source?.url &&
          source.type === 'video/mp4'
      );

    if (mp4) {
      console.log(
        `Found MP4 quality ${quality}`
      );

      return mp4.url;
    }
  }

  for (
    const sources
    of Object.values(qualities)
  ) {
    if (
      !Array.isArray(sources)
    ) {
      continue;
    }

    const hls =
      sources.find(
        source =>
          source?.url &&
          (
            source.type ===
              'application/x-mpegURL' ||
            source.url.includes('.m3u8')
          )
      );

    if (hls) {
      console.log(
        'Found HLS stream'
      );

      return hls.url;
    }
  }

  throw new Error(
    'No direct stream found'
  );
}

builder.defineStreamHandler(
  async ({ type, id }) => {

    console.log(
      `Stream request: ${type} ${id}`
    );

    if (
      type !== 'series'
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

    await refreshEpisodeMap(
      false
    );

    let item =
      episodeMap.get(key);

    if (!item) {
      await refreshEpisodeMap(
        true
      );

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
              directUrl,

            behaviorHints: {
              notWebReady: true,

              proxyHeaders: {
                request: {
                  'User-Agent':
                    'Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 Chrome/120 Safari/537.36',

                  'Referer':
                    'https://www.dailymotion.com/',

                  'Origin':
                    'https://www.dailymotion.com'
                }
              }
            }
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
);
