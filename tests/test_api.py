import pytest

from app import main

from .conftest import BASE_URL

NO_STREAMS = {'streams': []}


def test_public_base_url_prefers_the_explicit_setting(monkeypatch):
    monkeypatch.setenv('PUBLIC_BASE_URL', 'https://mine.example.test/')
    monkeypatch.setenv('RENDER_EXTERNAL_URL', 'https://render.example.test')
    assert main.public_base_url() == 'https://mine.example.test'


def test_public_base_url_falls_back_to_render(monkeypatch):
    monkeypatch.delenv('PUBLIC_BASE_URL', raising=False)
    monkeypatch.setenv('RENDER_EXTERNAL_URL', 'https://render.example.test')
    assert main.public_base_url() == 'https://render.example.test'


def test_public_base_url_is_required(monkeypatch):
    monkeypatch.delenv('PUBLIC_BASE_URL', raising=False)
    monkeypatch.delenv('RENDER_EXTERNAL_URL', raising=False)
    with pytest.raises(RuntimeError, match='PUBLIC_BASE_URL'):
        main.public_base_url()


def assert_cors(response):
    assert response.headers['access-control-allow-origin'] == '*'


def test_manifest_has_every_required_field_and_the_kept_id(client):
    response = client.get('/manifest.json')
    manifest = response.json()

    assert response.status_code == 200
    assert response.headers['content-type'].startswith('application/json')
    for field in ('id', 'name', 'description', 'version', 'resources', 'types', 'catalogs'):
        assert field in manifest
    assert manifest['id'] == 'il.yael.pijamot.dailymotion.tv'
    assert manifest['version'] == '3.0.0'
    assert manifest['resources'] == ['stream']
    assert manifest['types'] == ['series']
    assert manifest['catalogs'] == []
    assert manifest['idPrefixes'] == ['tt0928368']


def test_stream_hit_returns_one_stream_pointing_at_our_master(client):
    response = client.get('/stream/series/tt0928368:1:1.json')

    assert response.status_code == 200
    assert response.json() == {
        'streams': [
            {
                'name': 'Dailymotion',
                'title': "הפיג'מות עונה 1 פרק 1 איך הכל התחיל",
                'url': f'{BASE_URL}/master/x1aaaaa.m3u8',
                'behaviorHints': {'notWebReady': True},
            }
        ]
    }


def test_stream_never_sends_both_title_and_description(client):
    # stremio-core deserializes `title` as an alias of `description`; a stream with
    # both keys fails to parse and Stremio shows "no links".
    stream = client.get('/stream/series/tt0928368:1:1.json').json()['streams'][0]
    assert not {'title', 'description'} <= stream.keys()


def test_stream_accepts_percent_encoded_ids(client):
    response = client.get('/stream/series/tt0928368%3A9%3A1.json')
    assert response.json()['streams'][0]['url'] == f'{BASE_URL}/master/x9ccccc.m3u8'


def test_stream_accepts_the_extra_args_route(client):
    response = client.get('/stream/series/tt0928368:1:2/videoHash=abc.json')
    assert response.json()['streams'][0]['url'] == f'{BASE_URL}/master/x1bbbbb.m3u8'


def test_stream_never_calls_yt_dlp(client, resolver):
    client.get('/stream/series/tt0928368:1:1.json')
    assert resolver.calls == []


def test_stream_misses_return_an_empty_list_not_an_error(client):
    for path in (
        '/stream/series/tt0928368:1:999.json',
        '/stream/series/tt0928368:99:1.json',
        '/stream/movie/tt0928368:1:1.json',
        '/stream/series/tt1234567:1:1.json',
        '/stream/series/tt0928368:x:1.json',
        '/stream/series/tt0928368.json',
    ):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.json() == NO_STREAMS, path


def test_master_returns_an_hls_playlist(client):
    response = client.get('/master/x1aaaaa.m3u8')

    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/vnd.apple.mpegurl'
    assert response.text.startswith('#EXTM3U\n')
    assert 'https://vod.example.test/hq.m3u8' in response.text
    assert 'https://vod.example.test/hd.m3u8' in response.text


def test_master_answers_head_probes(client):
    response = client.head('/master/x1aaaaa.m3u8')

    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/vnd.apple.mpegurl'
    assert response.content == b''


def test_master_resolves_once_for_repeated_requests(client, resolver):
    client.get('/master/x1aaaaa.m3u8')
    client.head('/master/x1aaaaa.m3u8')
    client.get('/master/x1aaaaa.m3u8')
    assert resolver.calls == ['x1aaaaa']


def test_master_rejects_ids_outside_the_episode_map(client, resolver):
    response = client.get('/master/x0000000.m3u8')

    assert response.status_code == 404
    assert resolver.calls == []


def test_master_returns_502_when_yt_dlp_fails(client, resolver):
    resolver.error = RuntimeError('boom')
    response = client.get('/master/x1aaaaa.m3u8')
    assert response.status_code == 502


def test_master_returns_502_when_there_are_no_hls_formats(client, resolver):
    resolver.result = type(resolver.result)([], 'randomized-headers')
    response = client.get('/master/x1aaaaa.m3u8')
    assert response.status_code == 502


def test_cors_on_every_kind_of_response(client, resolver):
    hit = client.get('/stream/series/tt0928368:1:1.json')
    miss = client.get('/stream/series/tt0928368:1:999.json')
    ok = client.get('/master/x1aaaaa.m3u8')
    unknown = client.get('/master/x0000000.m3u8')
    not_found = client.get('/nope')
    resolver.error = RuntimeError('boom')
    hls_error = client.get('/master/x1bbbbb.m3u8')
    preflight = client.options(
        '/stream/series/tt0928368:1:1.json',
        headers={'Origin': 'https://web.stremio.com', 'Access-Control-Request-Method': 'GET'},
    )

    assert client.get('/manifest.json').status_code == 200
    for response in (client.get('/manifest.json'), hit, miss, ok, unknown, not_found, hls_error, preflight):
        assert_cors(response)
    assert preflight.status_code == 204
    assert not_found.status_code == 404
    assert hls_error.status_code == 502
