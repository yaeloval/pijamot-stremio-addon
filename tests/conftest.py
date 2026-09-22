import os

os.environ.setdefault('PUBLIC_BASE_URL', 'https://pijamot.example.test')

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import hls, main  # noqa: E402
from app.episodes import Episode, EpisodeCatalog  # noqa: E402

BASE_URL = os.environ['PUBLIC_BASE_URL'].rstrip('/')

FAKE_EPISODES = {
    1: [
        Episode(1, 1, "הפיג'מות עונה 1 פרק 1 איך הכל התחיל", 'x1aaaaa'),
        Episode(1, 2, "הפיג'מות עונה 1 פרק 2", 'x1bbbbb'),
    ],
    9: [Episode(9, 1, "הפיג'מות עונה 9 פרק 1 פרק אמריקאי", 'x9ccccc')],
}

FAKE_FORMATS = [
    {
        'url': 'https://vod.example.test/hq.m3u8',
        'tbr': 836.28,
        'width': 848,
        'height': 480,
        'fps': None,
        'vcodec': 'avc1.64001f',
        'acodec': 'mp4a.40.2',
    },
    {
        'url': 'https://vod.example.test/hd.m3u8',
        'tbr': 2654.28,
        'width': 1280,
        'height': 720,
        'fps': 60,
        'vcodec': 'avc1.640028',
        'acodec': 'mp4a.40.2',
    },
]


LOW_FORMAT = {**FAKE_FORMATS[0], 'url': 'https://vod.example.test/lq.m3u8', 'tbr': 460.56,
              'width': 512, 'height': 288}
NO_HD_FORMATS = [FAKE_FORMATS[0]]  # 480p only, like the truncated ladders seen from the Linode


def resolved(formats):
    return hls.Resolved(formats, 'randomized-headers')


def fake_fetch(season, playlist_id):
    return FAKE_EPISODES.get(season, [])


class ResolverStub:
    def __init__(self):
        self.calls = []
        self.result = resolved(FAKE_FORMATS)
        self.queue = []  # results to return first, one per call
        self.error = None

    def __call__(self, video_id):
        self.calls.append(video_id)
        if self.error:
            raise self.error
        if self.queue:
            return self.queue.pop(0)
        return self.result


@pytest.fixture
def resolver(monkeypatch):
    stub = ResolverStub()
    monkeypatch.setattr(hls, 'resolve', stub)
    hls.clear_cache()
    yield stub
    hls.clear_cache()


@pytest.fixture
def client(monkeypatch, resolver):
    monkeypatch.setattr(main, 'catalog', EpisodeCatalog(fetch=fake_fetch))
    with TestClient(main.app) as test_client:
        yield test_client
