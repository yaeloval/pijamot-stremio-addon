import pytest

from app import hls

from .conftest import FAKE_FORMATS, LOW_FORMAT, NO_HD_FORMATS, resolved


def test_synthesize_master_lists_variants_lowest_bandwidth_first():
    assert hls.synthesize_master(FAKE_FORMATS) == (
        '#EXTM3U\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=836280,RESOLUTION=848x480,'
        'CODECS="avc1.64001f,mp4a.40.2"\n'
        'https://vod.example.test/hq.m3u8\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=2654280,RESOLUTION=1280x720,'
        'FRAME-RATE=60.000,CODECS="avc1.640028,mp4a.40.2"\n'
        'https://vod.example.test/hd.m3u8\n'
    )


def test_synthesize_master_orders_by_bandwidth_not_input_order():
    text = hls.synthesize_master(list(reversed(FAKE_FORMATS)))
    assert text.index('hq.m3u8') < text.index('hd.m3u8')


def test_synthesize_master_omits_missing_optional_attributes():
    text = hls.synthesize_master(
        [{'url': 'https://v.test/a.m3u8', 'tbr': 100, 'width': None, 'height': None,
          'fps': None, 'vcodec': 'none', 'acodec': None}]
    )
    assert text == (
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nhttps://v.test/a.m3u8\n'
    )


def test_synthesize_master_without_formats_raises():
    with pytest.raises(hls.NoHlsFormats):
        hls.synthesize_master([])


class FakeYoutubeDL:
    """Stands in for yt_dlp.YoutubeDL; replays the notes the extractor prints."""

    notes = ['[dailymotion] x1: Downloading m3u8 information with randomized headers']
    info = {}

    def __init__(self, options):
        self.logger = options['logger']

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download):
        assert download is False
        assert url == 'https://www.dailymotion.com/video/x1'
        for note in self.notes:
            self.logger.debug(note)
        return self.info


HLS_FORMAT = {
    'protocol': 'm3u8_native',
    'url': 'https://v.test/a.m3u8',
    'tbr': 500.5,
    'width': 640,
    'height': 360,
    'fps': 25,
    'vcodec': 'avc1.x',
    'acodec': 'mp4a.y',
}


def test_resolve_keeps_only_hls_formats_and_reports_the_primary_step(monkeypatch):
    monkeypatch.setattr(hls.yt_dlp, 'YoutubeDL', FakeYoutubeDL)
    monkeypatch.setattr(
        FakeYoutubeDL,
        'info',
        {'formats': [HLS_FORMAT, {'protocol': 'https', 'url': 'https://v.test/a.mp4', 'tbr': 1}]},
    )

    resolved = hls.resolve('x1')

    assert resolved.step == 'randomized-headers'
    assert [f['url'] for f in resolved.formats] == ['https://v.test/a.m3u8']


def test_resolve_reports_the_last_step_yt_dlp_tried(monkeypatch):
    monkeypatch.setattr(hls.yt_dlp, 'YoutubeDL', FakeYoutubeDL)
    monkeypatch.setattr(FakeYoutubeDL, 'info', {'formats': [HLS_FORMAT]})
    monkeypatch.setattr(
        FakeYoutubeDL,
        'notes',
        [
            '[dailymotion] x1: Downloading m3u8 information with randomized headers',
            '[dailymotion] x1: Retrying m3u8 download with Chrome impersonation',
        ],
    )

    assert hls.resolve('x1').step == 'chrome-impersonation'


def test_resolve_with_no_formats_yields_an_empty_list(monkeypatch):
    monkeypatch.setattr(hls.yt_dlp, 'YoutubeDL', FakeYoutubeDL)
    monkeypatch.setattr(FakeYoutubeDL, 'info', {})

    assert hls.resolve('x1').formats == []


def test_full_ladder_is_resolved_once_without_a_retry(resolver):
    result, retried = hls.resolve_with_retry('x1aaaaa')

    assert retried is False
    assert result.formats == FAKE_FORMATS
    assert resolver.calls == ['x1aaaaa']


def test_ladder_without_hd_is_retried_once_and_the_full_one_wins(resolver):
    resolver.queue = [resolved(NO_HD_FORMATS), resolved(FAKE_FORMATS)]

    result, retried = hls.resolve_with_retry('x1aaaaa')

    assert retried is True
    assert result.formats == FAKE_FORMATS
    assert resolver.calls == ['x1aaaaa', 'x1aaaaa']


def test_retry_is_never_repeated_and_the_better_ladder_is_kept(resolver):
    resolver.queue = [resolved(NO_HD_FORMATS), resolved([LOW_FORMAT]), resolved(FAKE_FORMATS)]

    result, retried = hls.resolve_with_retry('x1aaaaa')

    assert retried is True
    assert result.formats == NO_HD_FORMATS
    assert len(resolver.calls) == 2  # the third queued (full) result was never asked for


def test_retry_result_is_kept_when_it_is_better_even_without_hd(resolver):
    resolver.queue = [resolved([LOW_FORMAT]), resolved(NO_HD_FORMATS)]

    result, retried = hls.resolve_with_retry('x1aaaaa')

    assert result.formats == NO_HD_FORMATS


def test_empty_ladder_is_not_retried(resolver):
    resolver.result = resolved([])

    result, retried = hls.resolve_with_retry('x1aaaaa')

    assert retried is False
    assert resolver.calls == ['x1aaaaa']


def test_master_playlist_caches_the_retried_result(resolver):
    resolver.queue = [resolved(NO_HD_FORMATS), resolved(FAKE_FORMATS)]

    first = hls.master_playlist('x1aaaaa')
    second = hls.master_playlist('x1aaaaa')

    assert first.retried and second.retried
    assert 'hd.m3u8' in first.text and second.text == first.text
    assert len(resolver.calls) == 2  # one resolve plus its retry; the second request is a cache hit


def test_master_playlist_caches_per_video(resolver):
    first = hls.master_playlist('x1aaaaa')
    second = hls.master_playlist('x1aaaaa')
    hls.master_playlist('x1bbbbb')

    assert not first.cache_hit
    assert second.cache_hit
    assert second.text == first.text
    assert resolver.calls == ['x1aaaaa', 'x1bbbbb']


def test_master_playlist_resolves_again_after_the_cache_expires(resolver, monkeypatch):
    now = [100.0]
    monkeypatch.setattr(hls.time, 'monotonic', lambda: now[0])

    hls.master_playlist('x1aaaaa')
    now[0] += hls.CACHE_SECONDS + 1
    hls.master_playlist('x1aaaaa')

    assert resolver.calls == ['x1aaaaa', 'x1aaaaa']
