// Apple Music's own search results and artist pages, as music.apple.com hands them to a browser
// (AppleMusicWeb.swift). The page carries everything it shows as JSON, and iJWA reads that instead of the page:
// no key, no permission, one request of about 60 KB. Should Apple change the page, reading fails quietly.
const STOREFRONT = 'us'; // America's store has the most, music videos especially (checked on the Mac, 2026-09-24)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const searches = new Map(); // term → results
const artists = new Map();  // id → artist

/** A picture Apple can make at any size: ".../{w}x{h}{c}.{f}". */
function artworkURL(art, side) {
  if (!art?.template) return null;
  return art.template.replace('{w}', side).replace('{h}', side).replace('{c}', 'cc').replace('{f}', 'jpg');
}

async function sections(url) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
    if (response.status !== 200) return null;
    const text = await response.text();
    const marker = text.indexOf('id="serialized-server-data"');
    if (marker < 0) return null;
    const open = text.indexOf('>', marker);
    const close = text.indexOf('</script>', open);
    const object = JSON.parse(text.slice(open + 1, close));
    return object?.data?.[0]?.data?.sections || null;
  } catch { return null; }
}

const storeID = (item) => item?.contentDescriptor?.identifiers?.storeAdamID;
const artwork = (value) => {
  const d = value?.dictionary;
  return d?.url ? { template: d.url, background: d.bgColor || null } : null;
};
const firstTitle = (value) => (Array.isArray(value) ? value[0]?.title : undefined);
/** "Song · The Weeknd" → ["Song", "The Weeknd"]; Apple puts narrow spaces round the dot. */
const parts = (line) => (line || '').split('·').map((p) => p.replace(/[\s ]+/g, ' ').trim());

function topItem(item) {
  const kind = { songs: 'song', artists: 'artist', albums: 'album' }[item.itemKind];
  const id = storeID(item);
  const title = item.title || firstTitle(item.titleLinks);
  if (!kind || !id || !title) return null;
  const line = parts(item.subtitle);
  return { id, kind, title, artist: kind === 'artist' ? '' : line[1] || '', album: '', duration: 0, isExplicit: Boolean(item.showExplicitBadge), artwork: artwork(item.artwork) };
}
function trackItem(item) {
  const id = storeID(item) || item.id;
  if (!id || !item.title) return null;
  return { id, kind: 'song', title: item.title, artist: firstTitle(item.subtitleLinks) || '', album: firstTitle(item.tertiaryLinks) || '',
    duration: (item.duration || 0) / 1000, isExplicit: Boolean(item.showExplicitBadge), artwork: artwork(item.artwork) };
}
function bubbleItem(item, kind) {
  const id = storeID(item) || item.id;
  if (!id || !item.title) return null;
  return { id, kind, title: item.title, artist: '', album: '', duration: 0, isExplicit: false, artwork: artwork(item.artwork) };
}
function squareItem(item, kind) {
  const id = storeID(item) || item.id;
  const title = firstTitle(item.titleLinks);
  if (!id || !title) return null;
  return { id, kind, title, artist: firstTitle(item.subtitleLinks) || '', album: '', duration: 0, isExplicit: Boolean(item.showExplicitBadge), artwork: artwork(item.artwork) };
}
const compact = (list) => list.filter(Boolean);

async function search(term) {
  const key = term.trim().toLowerCase();
  if (searches.has(key)) return searches.get(key);
  const found = await sections(`https://music.apple.com/${STOREFRONT}/search?term=${encodeURIComponent(key)}`);
  if (!found) return null;
  const results = { top: [], songs: [], artists: [], albums: [] };
  for (const section of found) {
    const id = section.id || '';
    const items = section.items || [];
    if (id.startsWith('top-search-section')) results.top = compact(items.map(topItem));
    else if (id.startsWith('track-section')) results.songs = compact(items.map(trackItem));
    else if (id.startsWith('bubble-section - artist')) results.artists = compact(items.map((i) => bubbleItem(i, 'artist')));
    else if (id.startsWith('square-section - album')) results.albums = compact(items.map((i) => squareItem(i, 'album')));
  }
  searches.set(key, results);
  if (searches.size > 60) searches.delete(searches.keys().next().value);
  return results;
}

function motion(value, keys) {
  const d = value?.dictionary;
  if (!d) return null;
  for (const key of keys) {
    const entry = d[key];
    if (!entry?.video) continue;
    const frame = entry.previewFrame;
    return { video: entry.video, still: frame?.url ? { template: frame.url, background: frame.bgColor || null } : null };
  }
  return null;
}

async function artist(id) {
  if (artists.has(id)) return artists.get(id);
  const found = await sections(`https://music.apple.com/${STOREFRONT}/artist/${id}`);
  const header = found?.find((s) => s.itemKind === 'artistDetailHeader')?.items?.[0];
  if (!header) return null;
  const name = header.title || '';
  const items = (marker) => found.find((s) => (s.id || '').includes(marker))?.items || [];
  // Top songs come as a list of tracks: the section's own items now, inside its first item on older pages.
  const top = items('TopSongs');
  const tracks = top[0]?.tracks || top;
  const topSongs = compact(tracks.map((track) => {
    const item = trackItem(track);
    if (!item) return null;
    // On an artist's page the line under a song is "Album · 2024".
    return { ...item, artist: name, album: parts(firstTitle(track.subtitleLinks))[0] || '' };
  }));
  const shelf = (marker) => compact(items(marker).map((i) => squareItem(i, 'album')))
    .map((a) => ({ ...a, artist: name, album: a.artist })); // an album's `album` is its year here
  const fullAlbums = shelf('Albums-');
  const singles = shelf('ArtistSingles');
  const page = {
    id, name, artwork: artwork(header.circleArtwork) || artwork(header.artwork),
    motion: motion(header.wideVideoArtwork, ['motionArtistFullscreen16x9', 'motionArtistWide16x9']),
    bio: (header.bio || '').trim(), topSongs, albums: [...fullAlbums, ...singles], fullAlbums, singles,
    similar: compact(items('SimilarArtists').map((i) => bubbleItem(i, 'artist'))),
  };
  artists.set(id, page);
  return page;
}

/** An album's moving cover, when it has one; `read` is false when the page couldn't be read at all. */
async function albumMotion(id) {
  const found = await sections(`https://music.apple.com/${STOREFRONT}/album/${id}`);
  if (!found) return { motion: null, read: false };
  const header = found.find((s) => (s.id || '').startsWith('album-detail-header-section'))?.items?.[0];
  return { motion: motion(header?.videoArtwork, ['motionDetailSquare']), read: true };
}

/** An album's songs in their order, as its page on Apple Music lists them — the store the cards' albums come from;
 *  Apple's older lookup when the page can't be read. (It gave none for some albums, or only versions it called not
 *  streamable: We Love You Tecca, on the Mac, 2026-10-10.) */
async function albumSongs(id) {
  const found = await sections(`https://music.apple.com/${STOREFRONT}/album/${id}`);
  if (found) {
    const header = found.find((s) => (s.id || '').startsWith('album-detail-header-section'))?.items?.[0];
    const cover = artwork(header?.artwork);
    const songs = found.filter((s) => s.itemKind === 'trackLockup').flatMap((s) => s.items || [])
      .filter((t) => t.isDisabled !== true && storeID(t) && t.title)
      .map((t) => ({ id: storeID(t), title: t.title, artist: t.artistName || '', album: header?.title || '',
        duration: (t.duration || 0) / 1000, art: artworkURL(cover, 300) }));
    if (songs.length) return songs;
  }
  try {
    const response = await fetch(`https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200&country=${STOREFRONT}`, { signal: AbortSignal.timeout(8000) });
    const items = ((await response.json()).results || []).filter((r) => r.wrapperType === 'track' && r.kind === 'song');
    items.sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0));
    return items.map((r) => ({ id: String(r.trackId), title: r.trackName, artist: r.artistName || '', album: r.collectionName || '',
      duration: (r.trackTimeMillis || 0) / 1000, art: (r.artworkUrl100 || '').replace('100x100', '300x300') || null }));
  } catch { return []; }
}

module.exports = { search, artist, albumMotion, albumSongs, artworkURL, STOREFRONT };
