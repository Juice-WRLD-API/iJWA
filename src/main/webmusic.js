// Music on the web — YouTube Music and SoundCloud — searched and read the way their own pages ask, with no key and no
// account (WebSearch.swift, WebMusic.swift): the site's own results, an artist's page as the site keeps it, an album's
// songs, a song's cover, and what plays after a song there. What is found plays by its own address on the site.
//
// An item from here has the shape of Apple's catalog items (applemusic.js), so the same views show it, and names its
// site in its ID ("yt:v:…" a song, "yt:a:…" an album, "yt:c:…" an artist; "sc:t:…", "sc:p:…", "sc:u:…"); `link` is
// the page that plays it. Should a site change its pages, reading fails quietly.
const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/138.0.0.0 Safari/537.36';
const APPLE_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) '
  + 'Version/18.0 Safari/605.1.15';
const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'en', gl: 'US' };
const SONGS_ONLY = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';
const ALBUMS_ONLY = 'EgWKAQIYAWoKEAkQAxAEEAUQCg==';
const ARTISTS_ONLY = 'EgWKAQIgAWoMEA4QChADEAQQCRAF';

// Searches and artist pages read lately, so typing back or opening a page again asks nothing.
const searches = new Map(); // site|term → results
const artists = new Map();  // id → artist page
const told = new Map();     // a SoundCloud title → its song and singer, once told apart

const compact = (list) => list.filter(Boolean);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);
const num = (v) => (typeof v === 'number' ? v : undefined);
const keepLatest = (map, key, value, most) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > most) map.delete(map.keys().next().value);
};

// ---- names (SpotifyLookup.swift) ----

/** A title without its "(feat. …)", "[Remix]" or " - Single" tail. */
function bare(text) {
  return String(text || '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/ - (Single|EP)$/i, '').trim();
}

/** For comparing with the tail kept: no case, accents or punctuation; "FREAKED OUT (Slowed)" isn't "FREAKED OUT". */
function whole(text) {
  return String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** For comparing: no tail, case, accents or punctuation; "Kayıp Kalp" and "KAYIP KALP" are one. */
const simple = (text) => whole(bare(text));

// YouTube Music joins artists in the browser's language: "Fat Papi ve prodshushy", "… und …".
const MARKS = [',', ' & ', ' feat.', ' ft.', ' x ', ' with ', ' ve ', ' und ', ' et ', ' y ', ' e ']
  .map((mark) => new RegExp(mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

/** The first of the artists a song credits. */
function lead(artist) {
  let name = String(artist || '');
  for (const mark of MARKS) {
    const i = name.search(mark);
    if (i >= 0) name = name.slice(0, i);
  }
  return name.trim();
}

/** A title without what versions add to it: "(feat. …)", "- Remastered", case. */
function plainTitle(title) {
  let text = String(title || '').toLowerCase();
  for (const mark of [' (', ' [', ' - ']) {
    const i = text.indexOf(mark);
    if (i >= 0) text = text.slice(0, i);
  }
  return text.trim();
}

// ---- which site ----

/** The site an item was found on, by its ID. */
function siteOf(item) {
  const id = String(item?.id || '');
  return id.startsWith('yt:') ? 'youTubeMusic' : id.startsWith('sc:') ? 'soundCloud' : null;
}

/** YouTube Music's, SoundCloud's or YouTube's own, by a page's address. */
function siteAtAddress(address) {
  let host;
  try { host = new URL(String(address)).hostname.toLowerCase(); } catch { return null; }
  if (host === 'music.youtube.com') return 'youTubeMusic';
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'soundCloud';
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') return 'youTube';
  if (host === 'open.spotify.com') return 'spotifyWeb';
  return null;
}

/** A YouTube Music page as YouTube's own: the same songs and lists play there by the same IDs. An album's or artist's
 *  page of YouTube Music has no twin there: null. */
function onYouTube(link) {
  let url;
  try { url = new URL(String(link)); } catch { return null; }
  if (url.hostname !== 'music.youtube.com') return null;
  if (!(url.pathname === '/watch' || url.pathname.startsWith('/channel/') || url.pathname === '/playlist')) return null;
  url.hostname = 'www.youtube.com';
  return url.toString();
}

// ---- a song's words ----

/** A YouTube video's words as a song's: "The Weeknd - Starboy ft. Daft Punk (Official Video)" by "TheWeekndVEVO" is
 *  "Starboy ft. Daft Punk" by The Weeknd; "Ezhel - Topic" is Ezhel. */
function tidyYouTube(title, artist) {
  let words = String(title || '')
    .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|mv|hd|4k|clip|klip)\b[^)\]]*[)\]]/gi, '');
  let by = String(artist || '');
  if (by.endsWith(' - Topic')) by = by.slice(0, -8);
  const squeeze = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const length = (text) => [...text].length;
  const channel = squeeze(by.replace(/(vevo|official|music|tv)$/i, ''));
  for (const dash of [' - ', ' – ', ' — ']) {
    const i = words.indexOf(dash);
    if (i < 0) continue;
    const left = words.slice(0, i).trim(), right = words.slice(i + dash.length).trim();
    const key = squeeze(left);
    // Only when the channel is the singer's: "Ezhel - Alo" uploaded by someone else stays as it is.
    if (right && length(key) >= 3
      && (by.toUpperCase().endsWith('VEVO') || (length(channel) >= 3 && (key.includes(channel) || channel.includes(key))))) {
      by = left;
      words = right;
    }
    break;
  }
  return { title: words.trim(), artist: by.trim() };
}

/** A SoundCloud title's two sides of its dash: "Lil Mosey - Walking On a Dream". */
function halves(title) {
  for (const dash of [' - ', ' – ', ' — ']) {
    const i = title.indexOf(dash);
    if (i < 0) continue;
    const left = title.slice(0, i).trim(), right = title.slice(i + dash.length).trim();
    if (!left || !right || [...left].length > 40) return null;
    return [left, right];
  }
  return null;
}

/** A SoundCloud upload's words as a song's: an upload is often "Lil Mosey - Walking On a Dream" by whoever uploaded
 *  it, the singer the part before the dash, not the uploader — or "Back In Chicago - Juice WRLD", after it. Without
 *  asking, the singer is taken to be first. */
function tidySoundCloud(title, artist) {
  const sides = halves(String(title || ''));
  return sides ? { title: sides[1], artist: sides[0] } : { title, artist };
}

/** The same, the singer's side found by asking Apple's catalog which half is an artist's name. */
async function soundCloudWords(title, artist) {
  const sides = halves(String(title || ''));
  if (!sides) return { title, artist };
  if (told.has(title)) return told.get(title);
  const [left, right] = sides;
  const kept = (song, singer) => {
    if (told.size > 200) told.clear();
    const words = { title: song, artist: singer };
    told.set(title, words);
    return words;
  };
  // Both halves searched together, as one would type them: the top results' singer is one of the halves.
  const top = await appleTop(`${left} ${right}`);
  if (top) {
    const singer = (half) => simple(lead(half));
    for (const item of top.slice(0, 3)) {
      const name = simple(lead(item.kind === 'artist' ? item.title : item.artist));
      if (!name) continue;
      if (name === singer(right)) return kept(left, right);
      if (name === singer(left)) return kept(right, left);
    }
  }
  const [leftIs, rightIs] = await Promise.all([isArtist(left), isArtist(right)]);
  return rightIs && !leftIs ? kept(left, right) : kept(right, left);
}

/** Whether a name is an artist's: Apple Music's own search, asked for it, puts that artist at the top — "Juice WRLD"
 *  is him, "Classy" a song (an artist of that name exists too, but nobody searching it means them). Without Apple
 *  Music's page, an artist of exactly the name in the iTunes catalog. */
async function isArtist(name) {
  const wanted = simple(lead(name));
  if (!wanted) return false;
  const top = await appleTop(lead(name));
  if (top) return Boolean(top[0]) && top[0].kind === 'artist' && simple(top[0].title) === wanted;
  try {
    const query = `term=${encodeURIComponent(lead(name))}&entity=musicArtist&limit=5`;
    const response = await fetch(`https://itunes.apple.com/search?${query}`, { signal: AbortSignal.timeout(6000) });
    if (response.status !== 200) return false;
    return ((await response.json()).results || []).some((a) => simple(a.artistName || '') === wanted);
  } catch { return false; }
}

// ---- Apple Music's top results (AppleMusicWeb.swift), only to tell a singer from a song ----

const appleSearches = new Map();

/** Apple Music's Top Results for a term, in its order, each its kind, title and artist; null when the page is unread. */
async function appleTop(term) {
  const key = term.trim().toLowerCase();
  if (appleSearches.has(key)) return appleSearches.get(key);
  let sections;
  try {
    const response = await fetch(`https://music.apple.com/us/search?term=${encodeURIComponent(key)}`, {
      headers: { 'User-Agent': APPLE_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status !== 200) return null;
    const text = await response.text();
    const marker = text.indexOf('id="serialized-server-data"');
    if (marker < 0) return null;
    const open = text.indexOf('>', marker), close = text.indexOf('</script>', open);
    sections = JSON.parse(text.slice(open + 1, close))?.data?.[0]?.data?.sections;
  } catch { return null; }
  if (!Array.isArray(sections)) return null;
  const items = sections.find((s) => String(s?.id || '').startsWith('top-search-section'))?.items || [];
  const top = compact(items.map((item) => {
    const kind = { songs: 'song', artists: 'artist', albums: 'album' }[item?.itemKind];
    const title = item?.title || (Array.isArray(item?.titleLinks) ? item.titleLinks[0]?.title : undefined);
    if (!kind || !item.contentDescriptor?.identifiers?.storeAdamID || !title) return null;
    // "Song · The Weeknd"; Apple puts narrow spaces round the dot.
    const line = String(item.subtitle || '').split('·').map((p) => p.replace(/[\s ]+/g, ' ').trim());
    return { kind, title, artist: kind === 'artist' ? '' : line[1] || '' };
  }));
  keepLatest(appleSearches, key, top, 60);
  return top;
}

// ---- YouTube Music's JSON ----

/** Every value under `key`, anywhere in a JSON object. */
function all(key, object) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) { for (const v of value) walk(v); return; }
    if (!isObject(value)) return;
    for (const [k, v] of Object.entries(value)) {
      if (k === key) found.push(v);
      walk(v);
    }
  };
  walk(object);
  return found;
}
const dictionaries = (key, object) => all(key, object).filter(isObject);
const strings = (key, object) => all(key, object).filter((v) => typeof v === 'string');

/** The words of a YouTube text, which comes in runs. */
const words = (value) => (Array.isArray(value?.runs) ? value.runs.map((r) => str(r?.text) || '').join('') : '');
const flexColumns = (row) => (Array.isArray(row?.flexColumns) ? row.flexColumns : [])
  .map((c) => words(c?.musicResponsiveListItemFlexColumnRenderer?.text));
const fixedColumn = (row) => (Array.isArray(row?.fixedColumns)
  ? words(row.fixedColumns[0]?.musicResponsiveListItemFixedColumnRenderer?.text) : '');
const explicit = (badges) => strings('iconType', badges ?? []).includes('MUSIC_EXPLICIT_BADGE');
const isYear = (text) => /^\d{4}$/.test(text);

/** "3:50" or "1:02:10", in seconds. */
function clock(text) {
  const parts = String(text || '').split(':').filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/** A YouTube picture at any size: its address ends "=w60-h60-l90-rj" ("-p" crops it to the size asked). An "-s" there
 *  goes: beside "-p" the address is refused (400, a song's picture, 2026-10-10). */
function youTubeArtwork(thumbnail) {
  const list = all('thumbnails', thumbnail ?? {})[0];
  if (!Array.isArray(list)) return null;
  const urls = list.map((t) => str(t?.url)).filter(Boolean);
  if (!urls.length) return null;
  let template = urls[urls.length - 1].replace(/=w\d+-h\d+(-[ps])*/g, '=w{w}-h{h}-p');
  if (template.startsWith('//')) template = `https:${template}`;
  return { template, background: null };
}

/** A picture's address at a size, as applemusic.js makes Apple's. */
function sized(art, side) {
  if (!art?.template) return null;
  return art.template.replace('{w}', side).replace('{h}', side).replace('{c}', 'cc').replace('{f}', 'jpg');
}

/** YouTube Music's own API, asked the way its page asks it — "search", "browse", "next" — answered in JSON. */
async function youTube(endpoint, fields) {
  try {
    const response = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': AGENT, Origin: 'https://music.youtube.com' },
      body: JSON.stringify({ context: { client: CLIENT }, ...fields }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 200) return await response.json();
    console.log('[web] YouTube Music didn\'t answer:', endpoint, response.status);
  } catch (error) { console.log('[web] YouTube Music didn\'t answer:', endpoint, error.message); }
  return null;
}

// ---- YouTube Music ----

const KINDS = new Map([['Song', 'song'], ['Video', 'song'], ['Album', 'album'], ['Single', 'album'], ['EP', 'album'],
  ['Artist', 'artist']]);
/** What YouTube Music finds that isn't a song, an album or an artist. */
const PASSED_OVER = new Set(['Playlist', 'Episode', 'Podcast', 'Profile', 'Station', 'Community playlist', 'Featured playlist']);

/** An album plays as its playlist ("OLAK5uy_…"); without one, its page opens. */
function youTubeAlbumLink(browseID, playlists) {
  const list = playlists.find((p) => p.startsWith('OLAK'));
  return list ? `https://music.youtube.com/watch?list=${list}` : `https://music.youtube.com/browse/${browseID}`;
}

function youTubeArtistItem(channel, name, artwork) {
  return { id: `yt:c:${channel}`, kind: 'artist', title: name, artist: '', album: '', duration: 0, isExplicit: false, artwork,
    link: `https://music.youtube.com/channel/${channel}` };
}

function youTubeItem({ title, line, endpoint, video, thumbnail, playlists, isExplicit, kind: fixed }) {
  if (!title) return null;
  const parts = line.split(' • ').map((p) => p.trim()).filter(Boolean);
  let kind = fixed || null;
  if (parts.length) {
    if (PASSED_OVER.has(parts[0])) return null;
    const labelled = KINDS.get(parts[0]);
    if (labelled) {
      parts.shift();
      if (!kind) kind = labelled;
    }
  }
  const browse = endpoint?.browseEndpoint;
  const browseID = str(browse?.browseId);
  const page = str(browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType) || '';
  // Playlists, profiles, podcasts: no.
  if (browseID && !page.endsWith('_ARTIST') && !page.endsWith('_ALBUM')) return null;
  const videoID = video || str(endpoint?.watchEndpoint?.videoId);
  if (!kind) kind = page.endsWith('_ARTIST') ? 'artist' : page.endsWith('_ALBUM') ? 'album' : videoID ? 'song' : null;
  let duration = 0;
  if (parts.length && clock(parts[parts.length - 1]) !== null) duration = clock(parts.pop());
  const kept = parts.filter((p) => !(p.endsWith(' views') || p.endsWith(' plays') || p.includes('audience')
    || p.endsWith(' subscribers')));
  const artwork = youTubeArtwork(thumbnail);
  if (kind === 'song') {
    if (!videoID) return null;
    return { id: `yt:v:${videoID}`, kind: 'song', title, artist: kept[0] || '', album: kept[1] || '', duration, isExplicit,
      artwork, link: `https://music.youtube.com/watch?v=${videoID}` };
  }
  if (kind === 'album') {
    if (!browseID) return null;
    const year = kept.length && isYear(kept[kept.length - 1]) ? kept.pop() : '';
    return { id: `yt:a:${browseID}`, kind: 'album', title, artist: kept[0] || '', album: year, duration: 0, isExplicit, artwork,
      link: youTubeAlbumLink(browseID, playlists) };
  }
  if (kind === 'artist') return browseID ? youTubeArtistItem(browseID, title, artwork) : null;
  return null;
}

/** One line of a list: its title, and under it "Song • The Weeknd • Starboy • 3:50" or the like. */
function youTubeRow(row, kind) {
  const columns = flexColumns(row);
  if (!columns.length) return null;
  return youTubeItem({ title: columns[0], line: columns[1] || '', endpoint: row.navigationEndpoint,
    video: str(row.playlistItemData?.videoId), thumbnail: row.thumbnail, playlists: strings('playlistId', row),
    isExplicit: explicit(row.badges), kind });
}

const listRows = (object) => dictionaries('musicResponsiveListItemRenderer', object);
const youTubeRows = (object, kind) => (object ? compact(listRows(object).map((r) => youTubeRow(r, kind))) : []);

/** Four searches at once, as the site's own tabs make them: everything (its top result and the best of the rest), and
 *  songs, albums and artists alone. */
async function youTubeResults(term) {
  const [mixed, songList, albumList, artistList] = await Promise.all([
    youTube('search', { query: term }), youTube('search', { query: term, params: SONGS_ONLY }),
    youTube('search', { query: term, params: ALBUMS_ONLY }), youTube('search', { query: term, params: ARTISTS_ONLY }),
  ]);
  if (!mixed && !songList) return null;
  const results = { top: [], songs: [], artists: [], albums: [] };
  if (mixed) {
    const sections = dictionaries('sectionListRenderer', mixed)[0]?.contents;
    const top = [];
    for (const section of Array.isArray(sections) ? sections : []) {
      const card = section?.musicCardShelfRenderer;
      if (isObject(card)) {
        top.push(youTubeItem({ title: words(card.title), line: words(card.subtitle), endpoint: card.onTap, video: null,
          thumbnail: card.thumbnail, playlists: strings('playlistId', [card.buttons ?? [], card.thumbnailOverlay ?? {}]),
          isExplicit: explicit(card.subtitleBadges) }));
      } else {
        top.push(...youTubeRows(section, null));
      }
    }
    const seen = new Set();
    results.top = compact(top).filter((item) => !seen.has(item.id) && seen.add(item.id)).slice(0, 6);
  }
  results.songs = youTubeRows(songList, 'song');
  results.albums = youTubeRows(albumList, 'album');
  results.artists = youTubeRows(artistList, 'artist');
  return results;
}

/** A song of an artist's list — title, artists, plays, album — played within the list of all their songs, so their
 *  songs follow it. */
function youTubeListed(row, list) {
  const columns = flexColumns(row);
  const video = str(row.playlistItemData?.videoId);
  if (!columns.length || !video) return null;
  return { id: `yt:v:${video}`, kind: 'song', title: columns[0], artist: columns[1] || '', album: columns[3] || '',
    duration: clock(fixedColumn(row)) || 0, isExplicit: explicit(row.badges), artwork: youTubeArtwork(row.thumbnail),
    link: `https://music.youtube.com/watch?v=${video}${list ? `&list=${list}` : ''}` };
}

/** An album or single on an artist's page, under it its year ("Single • 2026"); with no artist given, an artist. */
function youTubeTile(tile, artist) {
  const title = words(tile.title);
  const browseID = str(tile.navigationEndpoint?.browseEndpoint?.browseId);
  if (!title || !browseID) return null;
  const artwork = youTubeArtwork(tile.thumbnailRenderer);
  if (artist === null) return browseID.startsWith('UC') ? youTubeArtistItem(browseID, title, artwork) : null;
  const year = words(tile.subtitle).split(' • ').filter(isYear).pop() || '';
  return { id: `yt:a:${browseID}`, kind: 'album', title, artist, album: year, duration: 0,
    isExplicit: explicit(tile.subtitleBadges), artwork, link: youTubeAlbumLink(browseID, strings('playlistId', tile)) };
}

/** An artist's page: the note about them, their best known songs (as many as twenty, from the list of all their songs
 *  the page offers), albums, singles and EPs, and the artists their fans also like. */
async function youTubeArtistPage(item) {
  const channel = item.id.slice(5);
  const page = await youTube('browse', { browseId: channel });
  if (!isObject(page)) return null;
  const header = Object.values(isObject(page.header) ? page.header : {})[0] || {};
  const name = words(header.title) || item.title;
  const sections = dictionaries('sectionListRenderer', page.contents ?? {})[0]?.contents;
  let top = [], albums = [], singles = [], similar = [];
  let everySong = null;
  for (const section of Array.isArray(sections) ? sections : []) {
    const shelf = section?.musicShelfRenderer, carousel = section?.musicCarouselShelfRenderer;
    if (isObject(shelf) && !top.length) {
      everySong = strings('browseId', shelf.bottomEndpoint ?? shelf.title ?? {}).find((id) => id.startsWith('VL')) || null;
      top = compact(listRows(shelf).map((row) => youTubeListed(row, everySong?.slice(2))));
    } else if (isObject(carousel)) {
      const title = words(dictionaries('musicCarouselShelfBasicHeaderRenderer', carousel.header ?? {})[0]?.title);
      const tiles = dictionaries('musicTwoRowItemRenderer', carousel.contents ?? []);
      const shelfOf = (by) => compact(tiles.map((t) => youTubeTile(t, by)));
      if (title === 'Albums') albums = shelfOf(name);
      else if (['Singles', 'Singles & EPs', 'Singles and EPs'].includes(title)) singles = shelfOf(name);
      else if (title === 'Fans might also like') similar = shelfOf(null);
    }
  }
  // All their songs, best known first: the page itself shows five.
  if (everySong) {
    const list = await youTube('browse', { browseId: everySong });
    if (list) {
      const more = compact(listRows(list).slice(0, 40).map((row) => youTubeListed(row, everySong.slice(2))));
      if (more.length > top.length) top = more.slice(0, 20);
    }
  }
  if (!top.length && !albums.length) return null;
  const watch = dictionaries('watchEndpoint', header.playButton ?? {})[0];
  const shuffle = str(watch?.videoId) && str(watch?.playlistId)
    ? `https://music.youtube.com/watch?v=${watch.videoId}&list=${watch.playlistId}` : null;
  return { id: item.id, name, artwork: item.artwork || youTubeArtwork(header.thumbnail), motion: null,
    bio: words(header.description), topSongs: top, albums: [...albums, ...singles], fullAlbums: albums, singles, similar, shuffle };
}

async function youTubeAlbumSongs(album) {
  const page = await youTube('browse', { browseId: album.id.slice(5) });
  if (!page) return [];
  const list = /[?&]list=([^&]+)/.exec(album.link || '')?.[1];
  return compact(listRows(page).map((row) => {
    const columns = flexColumns(row);
    const video = str(row.playlistItemData?.videoId);
    if (!columns.length || !video) return null;
    return { id: `yt:v:${video}`, kind: 'song', title: columns[0], artist: album.artist, album: album.title,
      duration: clock(fixedColumn(row)) || 0, isExplicit: explicit(row.badges), artwork: album.artwork || null,
      link: `https://music.youtube.com/watch?v=${video}${list ? `&list=${list}` : ''}` };
  }));
}

/** A YouTube Music queue as its player lists it, each song played within it. */
async function youTubeQueue(video, list) {
  const answer = await youTube('next', { videoId: video, playlistId: list });
  if (!answer) return [];
  const seen = new Set();
  return compact(dictionaries('playlistPanelVideoRenderer', answer).map((row) => {
    const title = words(row.title), id = str(row.videoId);
    if (!title || !id) return null;
    const parts = words(row.longBylineText).split(' • ').map((p) => p.trim())
      .filter((p) => p && !p.endsWith(' views') && !p.endsWith(' likes') && !p.endsWith(' plays') && !isYear(p));
    const artist = parts[0] || '';
    // A song's video beside it, a version sung again: once.
    const key = `${plainTitle(title)}|${artist.toLowerCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { id: `yt:v:${id}`, kind: 'song', title, artist, album: parts[1] || '', duration: clock(words(row.lengthText)) || 0,
      isExplicit: explicit(row.badges), artwork: youTubeArtwork(row.thumbnail),
      link: `https://music.youtube.com/watch?v=${id}&list=${list}` };
  }));
}

/** The song playing, found by name: its own upload first. */
async function youTubeSongID(title, artist) {
  const found = await youTube('search', { query: `${bare(title)} ${lead(artist)}`, params: SONGS_ONLY });
  if (!found) return null;
  const songs = youTubeRows(found, 'song');
  const wanted = simple(title), singer = simple(lead(artist));
  const best = songs.find((s) => simple(s.title) === wanted && whole(s.artist).includes(singer))
    || songs.find((s) => simple(s.title) === wanted) || songs[0];
  return best ? best.id.slice(5) : null;
}

/** YouTube Music's own search, as its page asks it: each row's title, the words under it, its video and its list. */
async function youTubeSearch(query, params) {
  const object = await youTube('search', { query, params });
  if (!object) return [];
  return compact(listRows(object).map((row) => {
    const texts = (Array.isArray(row.flexColumns) ? row.flexColumns : []).map((column) => strings('text', column).join(''));
    if (!texts[0]) return null;
    const playlists = strings('playlistId', row);
    return { title: texts[0], subtitle: texts.slice(1).join(' '), video: strings('videoId', row)[0] || null,
      playlist: playlists.find((p) => p.startsWith('OLAK')) || playlists[0] || null };
  }));
}

/** A song's page, which plays it: found by its title and artist. */
async function youTubeSong(title, artist) {
  const found = await youTubeSearch(`${bare(title)} ${lead(artist)}`, SONGS_ONLY);
  const wanted = simple(title), singer = simple(lead(artist));
  const best = found.find((f) => simple(f.title) === wanted && whole(f.subtitle).includes(singer))
    || found.find((f) => simple(f.title) === wanted) || found[0];
  return best?.video ? `https://music.youtube.com/watch?v=${best.video}` : null;
}

/** An album, played from its first song. */
async function youTubeAlbum(title, artist) {
  const found = await youTubeSearch(`${bare(title)} ${lead(artist)}`, ALBUMS_ONLY);
  const wanted = simple(title), singer = simple(lead(artist));
  const best = found.find((f) => simple(f.title) === wanted && whole(f.subtitle).includes(singer))
    || found.find((f) => simple(f.title) === wanted);
  return best?.playlist ? `https://music.youtube.com/watch?list=${best.playlist}` : null;
}

/** An artist, from their best known song; YouTube Music carries on with songs like it. */
async function youTubeArtist(name) {
  const found = await youTubeSearch(name, SONGS_ONLY);
  const singer = simple(name);
  const best = found.find((f) => whole(f.subtitle).includes(singer)) || found[0];
  return best?.video ? `https://music.youtube.com/watch?v=${best.video}&list=RDAMVM${best.video}` : null;
}

// ---- SoundCloud ----

// SoundCloud's API wants the client ID its own pages carry: read from them once a day, and again when it is refused.
let soundCloudKey = null, soundCloudKeyAsking = null;

async function text(link) {
  try {
    const response = await fetch(link, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(10000) });
    return response.status === 200 ? await response.text() : null;
  } catch { return null; }
}

async function readSoundCloudKey() {
  const home = await text('https://soundcloud.com/');
  if (!home) return null;
  const pattern = /<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
  const scripts = [...home.matchAll(pattern)].map((m) => m[1]);
  for (const script of scripts.reverse()) {
    const id = /client_id:"([A-Za-z0-9]{32})"/.exec((await text(script)) || '')?.[1];
    if (!id) continue;
    soundCloudKey = { id, at: Date.now() };
    return id;
  }
  console.log('[web] SoundCloud\'s client ID wasn\'t found');
  return null;
}

/** The client ID, one reading at a time however many ask. */
function soundCloudID() {
  if (soundCloudKey && Date.now() - soundCloudKey.at < 86400000) return Promise.resolve(soundCloudKey.id);
  if (!soundCloudKeyAsking) soundCloudKeyAsking = readSoundCloudKey().finally(() => { soundCloudKeyAsking = null; });
  return soundCloudKeyAsking;
}

/** SoundCloud's API, as its own pages ask it, answered in JSON. */
async function soundCloud(path, fields, again = true) {
  const id = await soundCloudID();
  if (!id) return null;
  const query = new URLSearchParams({ ...fields, client_id: id });
  let status = 0;
  try {
    const response = await fetch(`https://api-v2.soundcloud.com/${path}?${query}`,
      { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(10000) });
    status = response.status;
    if (status === 200) return await response.json();
  } catch { /* told below */ }
  // The pages' client ID changed: read it again, once.
  if ((status === 401 || status === 403) && again) {
    soundCloudKey = null;
    return soundCloud(path, fields, false);
  }
  console.log(`[web] SoundCloud didn't answer (${status}):`, path);
  return null;
}

const collection = (object) => (Array.isArray(object?.collection) ? object.collection.filter(isObject) : null);

/** A search's results, twenty at most. */
async function soundCloudSearch(path, query) {
  return collection(await soundCloud(path, { q: query, limit: '20' })) || [];
}

/** SoundCloud's pictures come at a few fixed sizes: "-large" is 100 pixels, "-t500x500" the largest square. */
const soundCloudArtwork = (link) => (link ? { template: link.split('-large.').join('-t500x500.'), background: null } : null);

/** The sets SoundCloud calls albums. */
const ALBUM_SETS = new Set(['album', 'ep', 'single', 'compilation']);

/** A track, an album (EP, single) or a person, as search and pages list them; a playlist someone made, no. */
function soundCloudItem(object) {
  const number = object?.id, link = str(object?.permalink_url);
  if (!Number.isInteger(number) || !link) return null;
  const user = isObject(object.user) ? object.user : null;
  const uploader = str(user?.username) || '';
  switch (object.kind) {
    case 'track': {
      const title = str(object.title);
      if (title === undefined) return null;
      const length = (num(object.full_duration) ?? num(object.duration) ?? 0) / 1000;
      return { id: `sc:t:${number}`, kind: 'song', title, artist: uploader, album: '', duration: length, isExplicit: false,
        artwork: soundCloudArtwork(str(object.artwork_url) ?? str(user?.avatar_url)), link };
    }
    case 'playlist': {
      const title = str(object.title);
      if (title === undefined || !ALBUM_SETS.has(str(object.set_type) || '')) return null;
      const date = str(object.release_date) ?? str(object.display_date) ?? str(object.created_at) ?? '';
      const firstArtwork = Array.isArray(object.tracks) ? str(object.tracks[0]?.artwork_url) : undefined;
      return { id: `sc:p:${number}`, kind: 'album', title, artist: uploader, album: date.slice(0, 4), duration: 0,
        isExplicit: false, artwork: soundCloudArtwork(str(object.artwork_url) ?? firstArtwork ?? str(user?.avatar_url)), link };
    }
    case 'user': {
      const name = str(object.username);
      if (name === undefined) return null;
      return { id: `sc:u:${number}`, kind: 'artist', title: name, artist: '', album: '', duration: 0, isExplicit: false,
        artwork: soundCloudArtwork(str(object.avatar_url)), link };
    }
    default:
      return null;
  }
}

/** Four searches at once, as soundcloud.com's own tabs make them: everything, tracks, people and albums. */
async function soundCloudResults(term) {
  const [mixed, tracks, people, albums] = (await Promise.all([
    soundCloud('search', { q: term, limit: '12' }), soundCloud('search/tracks', { q: term, limit: '20' }),
    soundCloud('search/users', { q: term, limit: '10' }), soundCloud('search/albums', { q: term, limit: '10' }),
  ])).map(collection);
  if (!mixed && !tracks) return null;
  return {
    top: compact((mixed || []).map(soundCloudItem)).slice(0, 6),
    songs: compact((tracks || []).map(soundCloudItem)),
    artists: compact((people || []).map(soundCloudItem)),
    albums: compact((albums || []).map(soundCloudItem)),
  };
}

/** A person's page: what they wrote about themselves, their most played tracks, their albums, EPs and singles, and the
 *  artists SoundCloud finds like them. */
async function soundCloudArtistPage(item) {
  const id = item.id.slice(5);
  const [user, top, sets, others] = await Promise.all([
    soundCloud(`users/${id}`, {}), soundCloud(`users/${id}/toptracks`, { limit: '20' }),
    soundCloud(`users/${id}/albums`, { limit: '24' }), soundCloud(`users/${id}/relatedartists`, { limit: '10' }),
  ]);
  const person = isObject(user) ? user : null, topList = collection(top);
  if (!person && !topList) return null;
  const albumSets = collection(sets) || [];
  const full = compact(albumSets.filter((s) => s.set_type === 'album').map(soundCloudItem));
  const singles = compact(albumSets.filter((s) => s.set_type !== 'album').map(soundCloudItem));
  return {
    id: item.id, name: str(person?.username) || item.title,
    artwork: soundCloudArtwork(str(person?.avatar_url)) || item.artwork || null, motion: null,
    bio: (str(person?.description) || '').replace(/\n/g, ' '), topSongs: compact((topList || []).map(soundCloudItem)).slice(0, 20),
    albums: [...full, ...singles], fullAlbums: full, singles,
    similar: compact((collection(others) || []).map(soundCloudItem)), shuffle: null,
  };
}

/** An album's tracks: SoundCloud sends the first few whole, the rest as numbers only. */
async function soundCloudAlbumSongs(album) {
  const set = await soundCloud(`playlists/${album.id.slice(5)}`, {});
  if (!isObject(set)) return [];
  return compact((Array.isArray(set.tracks) ? set.tracks : []).map((track) => {
    const title = str(track?.title), number = track?.id;
    if (title === undefined || !Number.isInteger(number)) return null;
    return { id: `sc:t:${number}`, kind: 'song', title, artist: str(track.user?.username) ?? album.artist, album: album.title,
      duration: (num(track.full_duration) ?? num(track.duration) ?? 0) / 1000, isExplicit: false,
      artwork: soundCloudArtwork(str(track.artwork_url)) || album.artwork || null,
      link: str(track.permalink_url) || album.link || null };
  }));
}

/** The SoundCloud track playing, found by name, then its station and its uploader's best known tracks. */
async function soundCloudStation(title, artist) {
  const found = await soundCloudSearch('search/tracks', `${lead(artist)} ${bare(title)}`);
  const wanted = simple(title), singer = simple(lead(artist));
  const uploader = (track) => simple(str(track.user?.username) || '');
  const named = (track) => str(track.title) || '';
  const track = found.find((t) => simple(named(t)) === wanted && uploader(t) === singer)
    || found.find((t) => simple(named(t)) === wanted) || found.find((t) => whole(named(t)).includes(wanted));
  const first = track && soundCloudItem(track);
  if (!first) return null;
  const user = track.user?.id;
  const [alike, theirs] = await Promise.all([
    soundCloud(`stations/soundcloud:track-stations:${track.id}/tracks`, { limit: '30' }),
    Number.isInteger(user) ? soundCloud(`users/${user}/toptracks`, { limit: '20' }) : null,
  ]);
  const seen = new Set([first.id]);
  const list = [first];
  const add = (items) => {
    for (const item of compact(items.map(soundCloudItem))) {
      if (list.length >= 30) break;
      if (!seen.has(item.id)) { seen.add(item.id); list.push(item); }
    }
  };
  add([...(collection(alike) || []), ...(collection(theirs) || [])]);
  // Still short (an upload by a fan, with no station to speak of): more by the same singer.
  if (list.length < 15) add(await soundCloudSearch('search/tracks', lead(artist)));
  return list;
}

/** A track's page: the artist's own upload of it first, else the closest. */
async function soundCloudTrack(title, artist) {
  const found = await soundCloudSearch('search/tracks', `${lead(artist)} ${bare(title)}`);
  const wanted = simple(title), singer = simple(lead(artist));
  const uploader = (item) => simple(str(item.user?.username) || '');
  const named = (item) => str(item.title) || '';
  const best = found.find((f) => simple(named(f)) === wanted && uploader(f) === singer)
    || found.find((f) => whole(named(f)).includes(wanted) && uploader(f) === singer)
    || found.find((f) => whole(named(f)).includes(wanted));
  return str(best?.permalink_url) || null;
}

/** An album's page, else its artist's track by the same name. */
async function soundCloudAlbum(title, artist) {
  const found = await soundCloudSearch('search/albums', `${lead(artist)} ${bare(title)}`);
  const wanted = simple(title);
  const album = found.find((f) => simple(str(f.title) || '') === wanted);
  return str(album?.permalink_url) || soundCloudTrack(title, artist);
}

/** An artist's best known track there. */
async function soundCloudArtist(name) {
  const found = await soundCloudSearch('search/tracks', name);
  const singer = simple(name);
  const own = found.filter((f) => simple(str(f.user?.username) || '') === singer);
  const plays = (f) => num(f.playback_count) ?? 0;
  const best = own.reduce((most, f) => (most && plays(most) >= plays(f) ? most : f), null) || found[0];
  return str(best?.permalink_url) || null;
}

// ---- what the app asks ----

/** The site's own search: its top results, songs, artists and albums, in its order. YouTube's songs are YouTube
 *  Music's: its catalog, played on YouTube by the same IDs. */
async function search(term, site) {
  const key = `${site}|${String(term || '').trim().toLowerCase()}`;
  if (searches.has(key)) return searches.get(key);
  // Spotify's Web Player is searched as Spotify's app is: Apple Music's catalog, each pick found on Spotify by name.
  const found = site === 'spotifyWeb' ? await require('./applemusic').search(term)
    : site === 'soundCloud' ? await soundCloudResults(term) : await youTubeResults(term);
  if (found) keepLatest(searches, key, found, 40);
  return found;
}

/** An artist's page: the site's own for an artist found on the web, Apple Music's for one found there. */
async function artistPage(item) {
  const site = siteOf(item);
  if (!site) return require('./applemusic').artist(item.id);
  if (artists.has(item.id)) return artists.get(item.id);
  const page = site === 'youTubeMusic' ? await youTubeArtistPage(item) : await soundCloudArtistPage(item);
  if (page) keepLatest(artists, item.id, page, 20);
  return page;
}

/** The songs a song or album picked here starts with: the song itself, or the album's, in order. */
async function songs(item) {
  const site = siteOf(item);
  if (item?.kind !== 'album' || !site) return [item];
  const list = site === 'youTubeMusic' ? await youTubeAlbumSongs(item) : await soundCloudAlbumSongs(item);
  return list.length ? list : [item];
}

/** A song's own cover on its site, large: YouTube Music's square picture of the song (a video's frame is no cover),
 *  SoundCloud's track artwork. Only a song whose title is the one asked, by the artist asked. */
async function cover({ title, artist, site } = {}) {
  const wanted = simple(title), singer = simple(lead(artist));
  if (!wanted) return null;
  if (site === 'youTubeMusic' || site === 'youTube') {
    const found = await youTube('search', { query: `${bare(title)} ${lead(artist)}`, params: SONGS_ONLY });
    if (!found) return null;
    // Its title and its artist: a song of the same name by someone else has another cover.
    const best = youTubeRows(found, 'song').find((s) => simple(s.title) === wanted && whole(s.artist).includes(singer));
    return sized(best?.artwork, 600);
  }
  if (site === 'soundCloud') {
    const found = await soundCloudSearch('search/tracks', `${lead(artist)} ${bare(title)}`);
    // Its title, and its uploader or the artist it credits: someone else's upload of it may wear another picture.
    const by = (track) => [str(track.user?.username) || '', str(track.publisher_metadata?.artist) || '']
      .map(simple).includes(singer);
    const track = found.find((t) => simple(str(t.title) || '') === wanted && by(t));
    // A track with no artwork of its own shows its uploader's face: that is no cover.
    const art = str(track?.artwork_url);
    return art ? art.split('-large.').join('-t500x500.') : null;
  }
  return null;
}

/** What plays after the song playing, for Continue Playing: on YouTube Music, its own queue — the album or list it
 *  plays in, when its address is known (`video`, `list`), else the song's radio, the songs YouTube Music carries on
 *  with; on SoundCloud, the track's station, topped up with the uploader's best known tracks. `fresh` asks for songs
 *  like it rather than the list it plays in. Each song carries its page, which plays it there, the rest after it. */
async function upNext({ title, artist, site, video, list, fresh } = {}) {
  const at = site || 'youTubeMusic';
  if (at === 'soundCloud') {
    const found = await soundCloudStation(title, artist);
    return found ? { site: 'soundCloud', songs: found } : null;
  }
  if (!fresh && video) {
    const radio = `RDAMVM${video}`;
    const queue = await youTubeQueue(video, list || radio);
    // The address is the song playing's only while its player shows it; YouTube's always is.
    if (at === 'youTube' || queue.some((s) => simple(s.title) === simple(title))) {
      // A short list (a single, a list of two): the song's radio carries on after it.
      if (queue.length < 15 && (list || radio) !== radio) {
        const known = new Set(queue.map((s) => s.id));
        return { site: at, songs: [...queue, ...(await youTubeQueue(video, radio)).filter((s) => !known.has(s.id))] };
      }
      return { site: at, songs: queue };
    }
  }
  const found = await youTubeSongID(title, artist);
  if (!found) return null;
  const queue = await youTubeQueue(found, `RDAMVM${found}`);
  return queue.length ? { site: at === 'youTube' ? 'youTube' : 'youTubeMusic', songs: queue } : null;
}

// ---- a song on its album ----

/** A song of an album, as YouTube Music plays it on that album: its address in the album's list, so the album goes on
 *  after it (WebMusic.youTubeSongInAlbum). */
async function youTubeSongInAlbum(title, album, artist) {
  const albumLink = await youTubeAlbum(album, artist);
  const list = albumLink ? new URL(albumLink).searchParams.get('list') : null;
  if (!list) return null;
  const page = await youTube('browse', { browseId: `VL${list}` });
  if (!page) return null;
  const rows = all('musicResponsiveListItemRenderer', page).map((row) => {
    const runs = row?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    return { video: row?.playlistItemData?.videoId, title: runs.map((r) => r.text).join('') };
  }).filter((r) => r.video && r.title);
  const found = rows.find((r) => whole(r.title) === whole(title)) || rows.find((r) => simple(r.title) === simple(title));
  return found ? `https://music.youtube.com/watch?v=${found.video}&list=${list}` : null;
}

/** The same on SoundCloud: the track's page "in" the album's set, so the set goes on after it. */
async function soundCloudSongInAlbum(title, album, artist) {
  const link = await soundCloudAlbum(album, artist);
  if (!link || !/\/sets\//.test(link)) return null;
  const set = await soundCloud('resolve', { url: link });
  const tracks = isObject(set) && Array.isArray(set.tracks) ? set.tracks : [];
  // A set names its first few tracks in full, the rest by number only.
  const named = tracks.filter((t) => typeof t?.title === 'string');
  const numbers = tracks.filter((t) => typeof t?.title !== 'string').map((t) => t?.id).filter(Number.isInteger);
  for (let i = 0; i < numbers.length; i += 50) {
    const batch = await soundCloud('tracks', { ids: numbers.slice(i, i + 50).join(',') });
    if (Array.isArray(batch)) named.push(...batch);
  }
  const wanted = simple(title);
  const track = named.find((t) => simple(t.title) === wanted) || named.find((t) => whole(t.title).includes(wanted));
  if (!track?.permalink_url) return null;
  return `${track.permalink_url}?in=${new URL(link).pathname.replace(/^\/+|\/+$/g, '')}`;
}

module.exports = {
  siteOf, siteAtAddress, onYouTube, search, artistPage, songs, upNext, cover,
  youTubeSongInAlbum, soundCloudSongInAlbum,
  soundCloudWords, tidySoundCloud, tidyYouTube,
  youTubeSong, youTubeAlbum, youTubeArtist, soundCloudTrack, soundCloudAlbum, soundCloudArtist,
  bare, simple, whole, lead,
};
