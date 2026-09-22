import pytest

from app import episodes
from app.episodes import (
    PLAYLISTS,
    SERIES_IMDB_ID,
    STREAM_ID_RE,
    Episode,
    EpisodeCatalog,
    parse_episode_title,
    parse_playlist,
)


def test_series_id_and_playlists_are_unchanged():
    assert SERIES_IMDB_ID == 'tt0928368'
    assert PLAYLISTS == {
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


@pytest.mark.parametrize(
    'title',
    [
        "הפיג'מות עונה 2 פרק 7",
        'הפיג׳מות עונה 2 פרק 7',
        'הפיג’מות עונה 2 פרק 7',
        'הפיגמות עונה 2 פרק 7',
        "  הפיג'מות   עונה  2 פרק 7  ",
        "הפיג'מות עונה 2 פרק 7 איך הכל התחיל",
    ],
)
def test_parse_episode_title_matches_apostrophe_and_whitespace_variants(title):
    assert parse_episode_title(title) == (2, 7)


@pytest.mark.parametrize(
    'title',
    ["הפיג'מות - הסרטון הרשמי", "הפיג'מות עונה 2", 'עונה 2 פרק 7', '', None],
)
def test_parse_episode_title_rejects_other_titles(title):
    assert parse_episode_title(title) is None


def test_parse_playlist_keeps_only_matching_season_with_ids():
    data = {
        'list': [
            {'id': 'x1', 'title': "הפיג'מות עונה 3 פרק 1"},
            {'id': 'x2', 'title': "הפיג'מות עונה 4 פרק 1"},
            {'id': None, 'title': "הפיג'מות עונה 3 פרק 2"},
            {'id': 'x3', 'title': 'קטע מיוחד'},
            {'id': 'x4', 'title': "הפיג'מות עונה 3 פרק 5  שם"},
        ]
    }
    assert parse_playlist(3, data) == [
        Episode(3, 1, "הפיג'מות עונה 3 פרק 1", 'x1'),
        Episode(3, 5, "הפיג'מות עונה 3 פרק 5 שם", 'x4'),
    ]


@pytest.mark.parametrize('data', [None, [], {}, {'list': 'nope'}])
def test_parse_playlist_rejects_unexpected_response(data):
    with pytest.raises(ValueError):
        parse_playlist(1, data)


@pytest.mark.parametrize(
    'item_id,expected',
    [
        ('tt0928368:1:1', ('1', '1')),
        ('tt0928368:12:345', ('12', '345')),
    ],
)
def test_stream_id_regex_matches_episode_ids(item_id, expected):
    assert STREAM_ID_RE.match(item_id).groups() == expected


@pytest.mark.parametrize(
    'item_id', ['tt0928368', 'tt0928368:1', 'tt0928368:a:1', 'tt1234567:1:1', 'tt0928368:1:1:1']
)
def test_stream_id_regex_rejects_other_ids(item_id):
    assert STREAM_ID_RE.match(item_id) is None


class FakeFetch:
    def __init__(self, by_season):
        self.by_season = by_season
        self.calls = 0

    def __call__(self, season, playlist_id):
        self.calls += 1
        result = self.by_season.get(season, [])
        if isinstance(result, Exception):
            raise result
        return result


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


EP_1_1 = Episode(1, 1, 't11', 'x11')
EP_1_2 = Episode(1, 2, 't12', 'x12')
EP_2_1 = Episode(2, 1, 't21', 'x21')


def test_catalog_loads_on_first_get_and_serves_from_cache():
    fetch = FakeFetch({1: [EP_1_1], 2: [EP_2_1]})
    catalog = EpisodeCatalog(fetch=fetch)

    assert catalog.get(1, 1) == EP_1_1
    calls_after_first = fetch.calls
    assert catalog.get(2, 1) == EP_2_1
    assert fetch.calls == calls_after_first


def test_catalog_forces_a_refresh_on_a_miss():
    by_season = {1: [EP_1_1]}
    fetch = FakeFetch(by_season)
    catalog = EpisodeCatalog(fetch=fetch)
    assert catalog.get(1, 1) == EP_1_1

    by_season[1] = [EP_1_1, EP_1_2]
    assert catalog.get(1, 2) == EP_1_2


def test_catalog_returns_none_when_episode_still_missing_after_refresh():
    catalog = EpisodeCatalog(fetch=FakeFetch({1: [EP_1_1]}))
    assert catalog.get(1, 99) is None


def test_catalog_refreshes_after_the_cache_expires():
    clock = Clock()
    by_season = {1: [EP_1_1]}
    fetch = FakeFetch(by_season)
    catalog = EpisodeCatalog(fetch=fetch, clock=clock)
    catalog.get(1, 1)
    calls = fetch.calls

    clock.now += episodes.CACHE_SECONDS - 1
    catalog.get(1, 1)
    assert fetch.calls == calls

    clock.now += 2
    by_season[1] = [EP_1_2]
    assert catalog.get(1, 2) == EP_1_2


def test_catalog_keeps_the_old_map_when_a_refresh_finds_nothing():
    by_season = {1: [EP_1_1]}
    catalog = EpisodeCatalog(fetch=FakeFetch(by_season))
    catalog.get(1, 1)

    by_season[1] = []
    catalog.refresh(force=True)
    assert catalog.get(1, 1) == EP_1_1


def test_catalog_survives_a_failing_season():
    fetch = FakeFetch({1: [EP_1_1], 2: RuntimeError('boom')})
    catalog = EpisodeCatalog(fetch=fetch)
    assert catalog.get(1, 1) == EP_1_1


def test_has_video_reflects_the_loaded_map():
    catalog = EpisodeCatalog(fetch=FakeFetch({1: [EP_1_1]}))
    assert not catalog.has_video('x11')
    catalog.refresh(force=True)
    assert catalog.has_video('x11')
    assert not catalog.has_video('nope')
