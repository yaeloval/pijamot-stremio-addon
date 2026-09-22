"""Checks against the real Dailymotion. Run manually: `pytest -m live`.

These verify the assumptions the design rests on: yt-dlp resolves an episode with
its primary (randomized headers) step, and the variant playlists it returns are
open to a client that sends no special headers.
"""
import urllib.request

import pytest

from app import hls

pytestmark = pytest.mark.live

VIDEO_ID = 'x9350zg'  # season 1, episode 1


@pytest.fixture(scope='module')
def resolved():
    return hls.resolve(VIDEO_ID)


def test_resolves_hls_formats(resolved):
    assert resolved.formats
    assert hls.synthesize_master(resolved.formats).startswith('#EXTM3U')


def test_uses_the_primary_step(resolved):
    assert resolved.step == 'randomized-headers'


def test_variant_playlist_is_open_to_a_bare_client(resolved):
    request = urllib.request.Request(resolved.formats[0]['url'])
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200
        assert response.read(7) == b'#EXTM3U'
