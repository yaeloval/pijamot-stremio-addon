import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse, Response

from . import hls
from .episodes import SERIES_IMDB_ID, STREAM_ID_RE, EpisodeCatalog

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
log = logging.getLogger('pijamot')

def public_base_url():
    """Public address of this server, used to build the /master URL handed to Stremio.

    PUBLIC_BASE_URL wins (local runs, other hosts); Render sets RENDER_EXTERNAL_URL itself.
    """
    url = os.environ.get('PUBLIC_BASE_URL') or os.environ.get('RENDER_EXTERNAL_URL')
    if not url:
        raise RuntimeError('Set PUBLIC_BASE_URL to this server\'s public URL (Render provides RENDER_EXTERNAL_URL).')
    return url.rstrip('/')


PUBLIC_BASE_URL = public_base_url()

MANIFEST = {
    'id': 'il.yael.pijamot.dailymotion.tv',
    'version': '3.0.0',
    'name': "הפיג'מות – Dailymotion TV",
    'description': "ניגון פרקי הפיג'מות דרך Render proxy.",
    'resources': ['stream'],
    'types': ['series'],
    'catalogs': [],
    'idPrefixes': [SERIES_IMDB_ID],
}

NO_STREAMS = {'streams': []}

catalog = EpisodeCatalog()


class AllowAllCors:
    """Stremio requires CORS headers that allow all origins on every route."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        async def send_with_cors(message):
            if message['type'] == 'http.response.start':
                headers = message.setdefault('headers', [])
                headers.append((b'access-control-allow-origin', b'*'))
                headers.append((b'access-control-allow-headers', b'*'))
                headers.append((b'access-control-allow-methods', b'GET, HEAD, OPTIONS'))
            await send(message)

        if scope['method'] == 'OPTIONS':
            await send_with_cors({'type': 'http.response.start', 'status': 204, 'headers': []})
            await send_with_cors({'type': 'http.response.body', 'body': b''})
            return

        await self.app(scope, receive, send_with_cors)


@asynccontextmanager
async def lifespan(app):
    await run_in_threadpool(catalog.refresh, True)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(AllowAllCors)


@app.get('/manifest.json')
def manifest():
    return MANIFEST


@app.get('/stream/{content_type}/{item_id}.json')
@app.get('/stream/{content_type}/{item_id}/{extra}.json')
def stream(content_type: str, item_id: str, extra: str | None = None):
    if content_type != 'series':
        return NO_STREAMS

    match = STREAM_ID_RE.match(item_id)
    if not match:
        return NO_STREAMS

    episode = catalog.get(int(match.group(1)), int(match.group(2)))
    if episode is None:
        log.info('[stream miss] %s', item_id)
        return NO_STREAMS

    log.info('[stream hit] %s -> %s', item_id, episode.video_id)
    return {
        'streams': [
            {
                'name': 'Dailymotion',
                # `title` and `description` are the same field to Stremio (title is an
                # alias in stremio-core); sending both makes it drop the whole stream.
                'title': episode.title,
                'url': f'{PUBLIC_BASE_URL}/master/{episode.video_id}.m3u8',
                'behaviorHints': {'notWebReady': True},
            }
        ]
    }


@app.api_route('/master/{video_id}.m3u8', methods=['GET', 'HEAD'])
def master(video_id: str):
    # Only ids from the episode map: this endpoint is public and resolving is not free.
    if not catalog.has_video(video_id):
        return PlainTextResponse('unknown video', status_code=404)

    try:
        result = hls.master_playlist(video_id)
    except Exception:
        log.exception('master %s failed', video_id)
        return PlainTextResponse('could not resolve video', status_code=502)

    return Response(result.text, media_type='application/vnd.apple.mpegurl')
