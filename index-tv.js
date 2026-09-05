const express = require('express');

const {
  addonBuilder,
  getRouter
} = require('stremio-addon-sdk');

const SERIES_IMDB_ID = 'tt0928368';

const PUBLIC_BASE_URL =
  'https://pijamot-stremio-tv.onrender.com';

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
  version: '2.0.0',
  name: "הפיג'מות – Dailymotion TV",
  description: "ניגון פרקי הפיג'מות דרך Render proxy.",
  resources: ['stream'],
  types: ['series'],
  catalogs: [],
  idPrefixes: [SERIES_IMDB_ID]
};

const builder =
  new addonBuilder(manifest);

let episodeMap =
  new Map();

let lastRefresh = 0;

const CACHE_MS =
  6 * 60 * 60 * 1000;

const DM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 Chrome/120 Safari/537.36',

  'Referer':
    'https://www.dailymotion.com/',

  'Origin':
    'https://www.dailymotion.com',

  'Accept':
    '*/*'
};

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpisodeTitle(title) {
  const match =
    normalizeText(title).match(
      /הפיג['׳’]?מות\s+עונה\s+(\d+)\s+פרק\s+(\d+)/u
    );

  if (!match) {
    return null;
  }

  return {
    season:
      Number(match[1]),

    episode:
      Number(match[2])
  };
}

async function fetchPlaylist(
  season,
  playlistId
) {
  const url =
    `https://api.dailymotion.com/playlist/${playlistId}/videos` +
    `?fields=id,title,url&limit=100`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Playlist HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const list =
    Array.isArray(data.list)
      ? data.list
      : [];

  const result = [];

  for (const video of list) {

    const parsed =
      parseEpisodeTitle(
        video.title
      );

    if (!parsed) {
      continue;
    }

    if (
      parsed.season !== season
    ) {
      continue;
    }

    if (!video.id) {
      continue;
    }

    result.push({
      season:
        parsed.season,

      episode:
        parsed.episode,

      title:
        normalizeText(
          video.title
        ),

      videoId:
        video.id
    });
  }

  return result;
}

async function refreshEpisodeMap(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    episodeMap.size &&
    now - lastRefresh < CACHE_MS
  ) {
    return;
  }

  const results =
    await Promise.allSettled(

      Object.entries(
        PLAYLISTS
      ).map(
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

  if (nextMap.size) {
    episodeMap =
      nextMap;

    lastRefresh =
      Date.now();

    console.log(
      `Loaded ${episodeMap.size} episodes`
    );
  }
}

async function getDirectHlsUrl(
  videoId
) {
  const metadataUrl =
    `https://www.dailymotion.com/player/metadata/video/${videoId}`;

  const response =
    await fetch(
      metadataUrl,
      {
        headers:
          DM_HEADERS
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

  for (
    const sources
    of Object.values(
      qualities
    )
  ) {
    if (
      !Array.isArray(
        sources
      )
    ) {
      continue;
    }

    for (
      const source
      of sources
    ) {
      if (
        source?.url &&
        (
          source.url.includes(
            '.m3u8'
          ) ||
          source.type ===
            'application/x-mpegURL'
        )
      ) {
        return source.url;
      }
    }
  }

  throw new Error(
    'No HLS source found'
  );
}

function proxyUrl(url) {
  return (
    `${PUBLIC_BASE_URL}/dm-proxy?url=` +
    encodeURIComponent(url)
  );
}

function rewritePlaylist(
  text,
  originalUrl
) {
  const lines =
    text.split(/\r?\n/);

  return lines.map(
    line => {

      const trimmed =
        line.trim();

      if (!trimmed) {
        return line;
      }

      if (
        trimmed.startsWith(
          '#'
        )
      ) {

        return line.replace(
          /URI="([^"]+)"/g,
          (
            match,
            uri
          ) => {
            const absolute =
              new URL(
                uri,
                originalUrl
              ).href;

            return (
              `URI="${proxyUrl(
                absolute
              )}"`
            );
          }
        );
      }

      const absolute =
        new URL(
          trimmed,
          originalUrl
        ).href;

      return proxyUrl(
        absolute
      );
    }
  ).join('\n');
}

builder.defineStreamHandler(
  async ({ type, id }) => {

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

    const key =
      `${Number(match[1])}:${Number(match[2])}`;

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
      return {
        streams: []
      };
    }

    const streamUrl =
      `${PUBLIC_BASE_URL}/play/${item.videoId}/master.m3u8`;

    console.log(
      `Returning proxy stream: ${streamUrl}`
    );

    return {
      streams: [
        {
          name:
            'Dailymotion Proxy',

          title:
            item.title,

          url:
            streamUrl,

          behaviorHints: {
            notWebReady:
              true
          }
        }
      ]
    };
  }
);

const app =
  express();

app.get(
  '/play/:videoId/master.m3u8',
  async (req, res) => {

    try {
      const directUrl =
        await getDirectHlsUrl(
          req.params.videoId
        );

      const response =
        await fetch(
          directUrl,
          {
            headers:
              DM_HEADERS
          }
        );

      if (!response.ok) {
        throw new Error(
          `HLS HTTP ${response.status}`
        );
      }

      const text =
        await response.text();

      const rewritten =
        rewritePlaylist(
          text,
          directUrl
        );

      res.set(
        'Content-Type',
        'application/vnd.apple.mpegurl'
      );

      res.set(
        'Access-Control-Allow-Origin',
        '*'
      );

      res.send(
        rewritten
      );

    } catch (error) {

      console.error(
        'Play route error:',
        error.message
      );

      res.status(500).send(
        'Could not load video'
      );
    }
  }
);

app.get(
  '/dm-proxy',
  async (req, res) => {

    try {
      const url =
        req.query.url;

      if (!url) {
        return res
          .status(400)
          .send(
            'Missing URL'
          );
      }

      const headers = {
        ...DM_HEADERS
      };

      if (
        req.headers.range
      ) {
        headers.Range =
          req.headers.range;
      }

      const response =
        await fetch(
          url,
          {
            headers
          }
        );

      if (!response.ok) {
        return res
          .status(
            response.status
          )
          .send(
            'Upstream error'
          );
      }

      const contentType =
        response.headers.get(
          'content-type'
        ) || '';

      res.status(
        response.status
      );

      res.set(
        'Access-Control-Allow-Origin',
        '*'
      );

      if (
        contentType.includes(
          'mpegurl'
        ) ||
        url.includes(
          '.m3u8'
        )
      ) {
        const text =
          await response.text();

        const rewritten =
          rewritePlaylist(
            text,
            url
          );

        res.set(
          'Content-Type',
          'application/vnd.apple.mpegurl'
        );

        return res.send(
          rewritten
        );
      }

      const contentLength =
        response.headers.get(
          'content-length'
        );

      const contentRange =
        response.headers.get(
          'content-range'
        );

      const acceptRanges =
        response.headers.get(
          'accept-ranges'
        );

      if (contentType) {
        res.set(
          'Content-Type',
          contentType
        );
      }

      if (contentLength) {
        res.set(
          'Content-Length',
          contentLength
        );
      }

      if (contentRange) {
        res.set(
          'Content-Range',
          contentRange
        );
      }

      if (acceptRanges) {
        res.set(
          'Accept-Ranges',
          acceptRanges
        );
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      res.send(
        buffer
      );

    } catch (error) {

      console.error(
        'Proxy error:',
        error.message
      );

      res.status(500).send(
        'Proxy error'
      );
    }
  }
);

app.use(
  '/',
  getRouter(
    builder.getInterface()
  )
);

const PORT =
  Number(
    process.env.PORT ||
    7000
  );

app.listen(
  PORT,
  () => {
    console.log(
      `Pijamot proxy addon running on port ${PORT}`
    );
  }
);
