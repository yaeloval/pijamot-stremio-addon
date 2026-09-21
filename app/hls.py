"""Resolve Dailymotion videos with yt-dlp and build the HLS master playlist we serve.

Dailymotion's own master manifest is gated and its token is bound to the IP that
fetched it, so we never hand it to the player. yt-dlp fetches it (with its own
retry ladder) and returns one variant URL per quality; the variant playlists and
segments are open to any client, so the master we serve just lists those.
"""
import logging
import threading
import time
from dataclasses import dataclass

import yt_dlp

log = logging.getLogger('pijamot.hls')

CACHE_SECONDS = 60
HD_MIN_HEIGHT = 720

# Notes yt-dlp's Dailymotion extractor prints for each m3u8 download attempt, in
# the order it tries them. The last one seen is the attempt that succeeded.
_STEP_MARKERS = (
    ('randomized headers', 'randomized-headers'),
    ('Chrome impersonation', 'chrome-impersonation'),
    ('Firefox impersonation', 'firefox-impersonation'),
)


class NoHlsFormats(Exception):
    pass


@dataclass(frozen=True)
class Resolved:
    formats: list
    step: str


@dataclass(frozen=True)
class Master:
    text: str
    cache_hit: bool
    step: str
    resolve_ms: int
    retried: bool


class _StepLogger:
    """yt-dlp logger that records which m3u8 download step was used."""

    def __init__(self):
        self.step = None

    def debug(self, message):
        for marker, step in _STEP_MARKERS:
            if marker in message:
                self.step = step

    def info(self, message):
        pass

    def warning(self, message):
        log.warning('yt-dlp: %s', message)

    def error(self, message):
        log.error('yt-dlp: %s', message)


def resolve(video_id):
    step_logger = _StepLogger()
    options = {'quiet': True, 'skip_download': True, 'logger': step_logger}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(
            f'https://www.dailymotion.com/video/{video_id}', download=False
        )

    formats = [
        {
            'url': f['url'],
            'tbr': f['tbr'],
            'width': f.get('width'),
            'height': f.get('height'),
            'fps': f.get('fps'),
            'vcodec': f.get('vcodec'),
            'acodec': f.get('acodec'),
        }
        for f in info.get('formats') or []
        if str(f.get('protocol', '')).startswith('m3u8')
    ]
    return Resolved(formats, step_logger.step or 'unknown')


def _lacks_hd(formats):
    return bool(formats) and max(f['height'] or 0 for f in formats) < HD_MIN_HEIGHT


def _quality(resolved):
    return (max((f['height'] or 0 for f in resolved.formats), default=0), len(resolved.formats))


def resolve_with_retry(video_id):
    """Resolve, and once more if the ladder came back without an HD variant.

    From the Linode, yt-dlp's request to Dailymotion sometimes returns a master with
    only the 288p and 480p variants, while the same video has 720p and 1080p on the
    next attempt. The better of the two attempts is kept; there is no second retry.
    Returns (resolved, retried).
    """
    resolved = resolve(video_id)
    if not _lacks_hd(resolved.formats):
        return resolved, False

    log.info('master %s: no HD variant in %d formats, retrying once', video_id, len(resolved.formats))
    retried = resolve(video_id)
    return max((resolved, retried), key=_quality), True


def synthesize_master(formats):
    if not formats:
        raise NoHlsFormats('yt-dlp returned no HLS formats')

    lines = ['#EXTM3U']
    for f in sorted(formats, key=lambda f: f['tbr']):
        attributes = [f'BANDWIDTH={round(f["tbr"] * 1000)}']
        if f.get('width') and f.get('height'):
            attributes.append(f'RESOLUTION={f["width"]}x{f["height"]}')
        if f.get('fps'):
            attributes.append(f'FRAME-RATE={float(f["fps"]):.3f}')
        codecs = [c for c in (f.get('vcodec'), f.get('acodec')) if c and c != 'none']
        if codecs:
            attributes.append(f'CODECS="{",".join(codecs)}"')
        lines.append('#EXT-X-STREAM-INF:' + ','.join(attributes))
        lines.append(f['url'])
    return '\n'.join(lines) + '\n'


_cache = {}
_lock = threading.Lock()


def clear_cache():
    with _lock:
        _cache.clear()


def master_playlist(video_id):
    with _lock:
        cached = _cache.get(video_id)

    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        resolved, retried, cache_hit, resolve_ms = cached[1], cached[2], True, 0
    else:
        started = time.monotonic()
        resolved, retried = resolve_with_retry(video_id)
        resolve_ms = round((time.monotonic() - started) * 1000)
        cache_hit = False
        with _lock:
            _cache[video_id] = (time.monotonic(), resolved, retried)

    text = synthesize_master(resolved.formats)
    log.info(
        'master %s cache=%s resolve_ms=%d step=%s formats=%d hd=%s retried=%s',
        video_id,
        'hit' if cache_hit else 'miss',
        resolve_ms,
        resolved.step,
        len(resolved.formats),
        'no' if _lacks_hd(resolved.formats) else 'yes',
        'yes' if retried else 'no',
    )
    return Master(text, cache_hit, resolved.step, resolve_ms, retried)
