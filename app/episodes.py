"""Season/episode -> Dailymotion video id, from the ThePijamasArchive playlists."""
import json
import logging
import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

log = logging.getLogger('pijamot.episodes')

SERIES_IMDB_ID = 'tt0928368'

PLAYLISTS = {
    1: 'x8kmxm',
    2: 'x8kmxy',
    3: 'x8kmy6',
    4: 'x8kmy8',
    5: 'x8kmya',
    6: 'x8kmye',
    7: 'x8nroo',
    8: 'x8nroq',
    9: 'x8nrow',
}

CACHE_SECONDS = 6 * 60 * 60

TITLE_RE = re.compile(r"הפיג['׳’]?מות\s+עונה\s+(\d+)\s+פרק\s+(\d+)")
STREAM_ID_RE = re.compile(rf'^{SERIES_IMDB_ID}:(\d+):(\d+)$')


@dataclass(frozen=True)
class Episode:
    season: int
    episode: int
    title: str
    video_id: str


def normalize_text(text):
    return ' '.join(str(text or '').split())


def parse_episode_title(title):
    match = TITLE_RE.search(normalize_text(title))
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def parse_playlist(season, data):
    """Episodes of `season` found in a Dailymotion playlist API response."""
    if not isinstance(data, dict) or not isinstance(data.get('list'), list):
        raise ValueError('unexpected Dailymotion playlist response')

    found = []
    for video in data['list']:
        title = normalize_text(video.get('title'))
        parsed = parse_episode_title(title)
        if not parsed or parsed[0] != season:
            continue
        if not video.get('id'):
            continue
        found.append(Episode(parsed[0], parsed[1], title, video['id']))
    return found


def fetch_playlist(season, playlist_id):
    url = (
        f'https://api.dailymotion.com/playlist/{playlist_id}/videos'
        '?fields=id,title,url&limit=100'
    )
    request = urllib.request.Request(
        url, headers={'User-Agent': 'PijamotStremioAddon/1.0'}
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.load(response)
    found = parse_playlist(season, data)
    log.info('playlist season %s (%s): found %d episodes', season, playlist_id, len(found))
    return found


class EpisodeCatalog:
    def __init__(self, playlists=PLAYLISTS, fetch=fetch_playlist, clock=time.monotonic):
        self._playlists = playlists
        self._fetch = fetch
        self._clock = clock
        self._episodes = {}
        self._video_ids = frozenset()
        self._last_refresh = 0.0
        self._generation = 0
        self._lock = threading.Lock()

    def get(self, season, episode):
        """The episode, refreshing once if the cache is stale or has no such episode."""
        self.refresh(force=False)
        item = self._episodes.get((season, episode))
        if item is None:
            self.refresh(force=True)
            item = self._episodes.get((season, episode))
        return item

    def has_video(self, video_id):
        return video_id in self._video_ids

    def refresh(self, force=False):
        generation = self._generation
        with self._lock:
            # A refresh that finished while we waited for the lock serves us too.
            if self._generation != generation:
                return
            if (
                not force
                and self._episodes
                and self._clock() - self._last_refresh < CACHE_SECONDS
            ):
                return
            self._load()

    def _load(self):
        def fetch_one(item):
            season, playlist_id = item
            try:
                return self._fetch(season, playlist_id)
            except Exception as error:
                log.error('[playlist refresh] season %s (%s): %s', season, playlist_id, error)
                return []

        with ThreadPoolExecutor(max_workers=len(self._playlists)) as pool:
            results = list(pool.map(fetch_one, self._playlists.items()))

        episodes = {
            (item.season, item.episode): item
            for found in results
            for item in found
        }

        if episodes:
            self._episodes = episodes
            self._video_ids = frozenset(item.video_id for item in episodes.values())
            self._last_refresh = self._clock()
            self._generation += 1
            log.info('Loaded %d Pijamot episodes from Dailymotion.', len(episodes))
        else:
            log.error('Dailymotion refresh returned 0 matching Pijamot episodes.')
