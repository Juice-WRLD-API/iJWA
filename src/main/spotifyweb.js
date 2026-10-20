// Spotify's own public pages for putting a song or an artist on a website — its embed player's, and oEmbed, its
// official way to ask for a song's picture — read the way that player reads them, with no key and no account
// (SpotifyCatalog.swift): a song's artists, and an artist's ten best known songs, each by its Spotify ID, which is
// all Spotify needs to play it. Should Spotify change the pages, reading fails quietly.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const tracks = new Map(), artists = new Map(), covers = new Map();

const plain = (text) => (text || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/ - .*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const idOf = (uri) => String(uri || '').split(':').pop();

async function entity(link) {
  try {
    const response = await fetch(link, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (response.status !== 200) return null;
    const text = await response.text();
    const marker = text.indexOf('id="__NEXT_DATA__"');
    if (marker < 0) return null;
    const open = text.indexOf('>', marker), close = text.indexOf('</script>', open);
    return JSON.parse(text.slice(open + 1, close))?.props?.pageProps?.state?.data?.entity || null;
  } catch { return null; }
}

/** An album's songs, in order, as its embed page lists them: Spotify carries on with the album after one. */
async function albumSongs(albumURI) {
  const found = await entity(`https://open.spotify.com/embed/album/${idOf(albumURI)}`);
  return (found?.trackList || []).filter((t) => t.isPlayable !== false && String(t.uri).startsWith('spotify:track:') && t.title)
    .map((t) => ({ uri: t.uri, title: t.title, artist: t.subtitle || '' }));
}

/** A song's artists and its cover. */
async function track(uri) {
  if (tracks.has(uri)) return tracks.get(uri);
  const found = await entity(`https://open.spotify.com/embed/track/${idOf(uri)}`);
  if (!found) return null;
  const result = {
    artists: (found.artists || []).filter((a) => a.name && String(a.uri).startsWith('spotify:artist:')).map((a) => ({ name: a.name, uri: a.uri })),
    // The picture nearest 300 pixels, the rows' size.
    cover: (found.visualIdentity?.image || []).sort((a, b) => Math.abs((a.maxWidth || 0) - 300) - Math.abs((b.maxWidth || 0) - 300))[0]?.url || null,
    // The biggest, for the song's artwork.
    art: (found.visualIdentity?.image || []).sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0]?.url || null,
  };
  tracks.set(uri, result);
  if (result.cover) { coversLoad(); if (!covers.has(uri)) { covers.set(uri, result.cover); coversSave(); } require('./covers').warm(result.cover); }
  return result;
}

/** An artist's best known songs, as their page lists them: ten at most. */
async function topSongs(artistURI) {
  if (artists.has(artistURI)) return artists.get(artistURI);
  const found = await entity(`https://open.spotify.com/embed/artist/${idOf(artistURI)}`);
  if (!found) return [];
  const songs = (found.trackList || []).filter((s) => s.isPlayable !== false && String(s.uri).startsWith('spotify:track:') && s.title)
    .map((s) => ({ uri: s.uri, title: s.title, artist: s.subtitle || '', duration: (s.duration || 0) / 1000, context: artistURI }));
  artists.set(artistURI, songs);
  // Their covers start on their way now: most of them will be in the list.
  for (const song of songs) cover(song.uri);
  return songs;
}

/** A song's cover, 300 pixels square, from oEmbed: asked once, eight at a time, and kept on disk with its picture. */
let coverFile = null, coverSaving = null, coverSlots = 8;
const coverWaiting = [], coverAsking = new Map();
function coversLoad() {
  if (coverFile) return;
  const { app } = require('electron');
  coverFile = require('path').join(app.getPath('userData'), 'spotify-covers.json');
  try { for (const [uri, link] of Object.entries(JSON.parse(require('fs').readFileSync(coverFile, 'utf8')))) covers.set(uri, link); } catch { /* none yet */ }
}
function coversSave() {
  clearTimeout(coverSaving);
  coverSaving = setTimeout(() => { try { require('fs').writeFileSync(coverFile, JSON.stringify(Object.fromEntries(covers))); } catch { /* next time */ } }, 2000);
}
function cover(uri) {
  coversLoad();
  if (covers.has(uri)) return Promise.resolve(covers.get(uri));
  if (coverAsking.has(uri)) return coverAsking.get(uri);
  const run = new Promise((resolve) => coverWaiting.push(resolve)).then(async () => {
    try {
      const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(uri)}`, { signal: AbortSignal.timeout(8000) });
      if (response.status !== 200) { console.log('[covers] oEmbed', response.status, uri); return null; }
      const link = (await response.json()).thumbnail_url || null;
      if (link) { covers.set(uri, link); coversSave(); require('./covers').warm(link); }
      return link;
    } catch (error) { console.log('[covers] oEmbed', uri, error.message); return null; } finally {
      coverAsking.delete(uri);
      coverSlots++;
      coverNext();
    }
  });
  coverAsking.set(uri, run);
  coverNext();
  return run;
}
function coverNext() { while (coverSlots > 0 && coverWaiting.length) { coverSlots--; coverWaiting.shift()(); } }
/** A cover known already, without asking. */
function knownCover(uri) { coversLoad(); return covers.get(uri) || null; }

// ---- an artist's Spotify ID from their name, through MusicBrainz ----
// Windows tells iJWA a song's name, not its Spotify ID, and Spotify's own window hides its contents while it is
// minimized. MusicBrainz, the open music encyclopedia, keeps most artists' Spotify links: no key, one request a
// second (its rule), answers kept on disk so each artist is asked once.
const MB_UA = 'iJWA/0.1 ( support@yomilly.com )';
let mbCache = null, mbFile = null, mbLast = 0, mbQueue = Promise.resolve();
function mbLoad() {
  if (mbCache) return;
  const { app } = require('electron');
  mbFile = require('path').join(app.getPath('userData'), 'spotify-artists.json');
  try { mbCache = new Map(Object.entries(JSON.parse(require('fs').readFileSync(mbFile, 'utf8')))); } catch { mbCache = new Map(); }
}
function mbSave() { try { require('fs').writeFileSync(mbFile, JSON.stringify(Object.fromEntries(mbCache))); } catch { /* next time */ } }
async function mbFetch(url) {
  const wait = Math.max(0, mbLast + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  mbLast = Date.now();
  try {
    const response = await fetch(url, { headers: { 'User-Agent': MB_UA }, signal: AbortSignal.timeout(8000) });
    return response.status === 200 ? await response.json() : null;
  } catch { return null; }
}
/** 'spotify:artist:…' for an artist's name, or null. One look-up at a time, as MusicBrainz asks. */
function artistURI(name) {
  mbLoad();
  const key = plain(name);
  if (!key) return Promise.resolve(null);
  const known = mbCache.get(key);
  // A miss is believed for a day — only one that was really read (v2): earlier ones may have been a busy moment.
  if (known && (known.uri || (known.v === 2 && Date.now() - known.at < 86400000))) return Promise.resolve(known.uri || null);
  const run = mbQueue.then(async () => {
    const found = await mbFetch(`https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`);
    const match = (found?.artists || []).find((a) => plain(a.name) === key || (a.aliases || []).some((x) => plain(x.name) === key));
    let uri = null, read = Boolean(found);
    if (match) {
      const detail = await mbFetch(`https://musicbrainz.org/ws/2/artist/${match.id}?inc=url-rels&fmt=json`);
      read = Boolean(detail);
      const link = (detail?.relations || []).map((r) => r.url?.resource || '').find((u) => u.includes('open.spotify.com/artist/'));
      const id = link?.match(/artist\/([A-Za-z0-9]{22})/)?.[1];
      if (id) uri = `spotify:artist:${id}`;
    }
    // Kept only when MusicBrainz really answered: a busy moment isn't taken for an artist it doesn't know.
    if (read) { mbCache.set(key, { uri, at: Date.now(), v: 2 }); mbSave(); }
    return uri;
  });
  mbQueue = run.catch(() => {});
  return run;
}

/** Everyone a song credits, as Spotify artists: from Spotify itself when its ID is known, else by name. */
/** 'spotify:album:…' for an album by its title and first artist, through MusicBrainz's release groups and their
 *  releases' links (SpotifyLookup.album): kept as artists are. */
function albumURI(title, artist) {
  mbLoad();
  const name = String(title || '').replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+(single|ep)$/i, '').trim();
  const lead = String(artist || '').split(/,| & | feat\.| ft\.| x | with | ve /i)[0].trim();
  const key = `album|${plain(lead)}|${plain(name)}`;
  if (!plain(name)) return Promise.resolve(null);
  const known = mbCache.get(key);
  if (known && (known.uri || Date.now() - known.at < 86400000)) return Promise.resolve(known.uri || null);
  const run = mbQueue.then(async () => {
    const found = await mbFetch(`https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(`releasegroup:"${name}" AND artist:"${lead}"`)}&fmt=json&limit=5`);
    let read = Boolean(found), uri = null;
    for (const group of (found?.['release-groups'] || []).filter((g) => plain(g.title) === plain(name)).slice(0, 2)) {
      const releases = await mbFetch(`https://musicbrainz.org/ws/2/release?release-group=${group.id}&inc=url-rels&limit=25&fmt=json`);
      if (!releases) { read = false; continue; }
      for (const release of releases.releases || []) {
        const id = (release.relations || []).map((r) => r.url?.resource || '').find((u) => u.includes('open.spotify.com/album/'))?.match(/album\/([A-Za-z0-9]{22})/)?.[1];
        if (id) { uri = `spotify:album:${id}`; break; }
      }
      if (uri) break;
    }
    if (read || uri) { mbCache.set(key, { uri, at: Date.now(), v: 2 }); mbSave(); }
    return uri;
  });
  mbQueue = run.catch(() => {});
  return run;
}

/** A song's Spotify address by name (SpotifyLookup.song): among its artist's best known songs, else on its album. */
async function songURI(title, artist, album = '') {
  const wanted = plain(title);
  const artistID = await artistURI(String(artist || '').split(/,| & | feat\.| ft\.| x | with | ve /i)[0].trim());
  if (artistID) {
    const top = await topSongs(artistID);
    const found = top.find((s) => plain(s.title) === wanted);
    if (found) return found.uri;
  }
  if (!album) return null;
  const albumID = await albumURI(album, artist);
  if (!albumID) return null;
  return (await albumSongs(albumID)).find((s) => plain(s.title) === wanted)?.uri || null;
}

async function artistsOf(track) {
  if (track.playKey?.startsWith('spotify:track:')) {
    const info = await track_(track.playKey);
    if (info?.artists?.length) return info.artists;
  }
  if (track.spotifyArtists?.length) return track.spotifyArtists.map((a) => ({ name: a.name, uri: `spotify:artist:${a.id}` }));
  const names = [...new Set((track.artist || '').split(/,|&| feat\.? | ft\. | x | with /i).map((n) => n.trim()).filter(Boolean))].slice(0, 3);
  const found = [];
  for (const name of names) { const uri = await artistURI(name); if (uri) found.push({ name, uri }); }
  return found;
}

const shuffled = (list) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** Continue Playing for someone listening in Spotify, every song by its Spotify ID so Spotify can play it: songs like
 *  the one playing — the song, then its artist's best known songs, with those of the artists they sing with coming
 *  in between — and, while nothing plays yet, the songs played there lately, topped up with songs like the last. */
class SpotifyList {
  songs = [];       // { id: 'spotify:track:…', title, artist, album, duration, cover }
  seedTitle = '';
  isRecent = false;
  isLoading = false;
  madeFor = null;
  seed = null;
  shown = new Set();
  shownTitles = new Set();

  constructor(onChange, played = () => []) { this.onChange = onChange; this.played = played; }
  changed() { this.onChange(); }

  /** Songs like `track` (a Spotify song with a playKey), unless the list is for it already. */
  async suggest(track) {
    if (this.madeFor === track.id && this.songs.length) return;
    this.shown = new Set(); this.shownTitles = new Set();
    await this.build(track, false);
  }

  /** Other songs like `track`: the song still first, then songs not shown yet, in a new order. */
  async refresh(track) {
    if (this.seed?.id !== track.id) { this.shown = new Set(this.songs.map((s) => s.id)); this.shownTitles = new Set(this.songs.map((s) => plain(s.title))); }
    await this.build(track, true);
  }

  /** The songs played in Spotify, newest first; a few only, and songs like the last join them. */
  async recall(played) {
    const key = 'recent';
    this.madeFor = key; this.isLoading = true; this.changed();
    let list = played.map((p) => ({ id: p.playKey || `local:${p.id}`, title: p.title, artist: p.artist, album: p.album, duration: p.duration, artworkFile: p.artworkFile }));
    if (list.length < 8 && played[0]) {
      const last = played[0];
      const more = await this.alike({ ...last }, new Set(list.map((s) => s.id)), new Set(list.map((s) => plain(s.title))), false);
      list = list.concat(more.slice(0, 25 - list.length));
    }
    if (this.madeFor !== key) return;
    this.publish(list, '', true);
    this.seed = null;
  }

  async build(track, fresh) {
    const key = track.id;
    this.madeFor = key; this.isLoading = true; this.changed();
    let list = await this.alike(track, this.shown, this.shownTitles, fresh);
    // Everything within reach shown once: round again.
    if (fresh && list.length < 4) {
      this.shown = new Set(); this.shownTitles = new Set();
      list = await this.alike(track, new Set(this.songs.slice(1).map((s) => s.id)), new Set(), true);
    }
    if (this.madeFor !== key) return;
    console.log('[list] like', track.title, ':', list.length, 'songs');
    if (!list.length) {
      // No songs like it to be found: the list still shows it playing, at the top of the songs played lately.
      const recent = this.played().filter((p) => plain(p.title) !== plain(track.title)).slice(0, 24)
        .map((p) => ({ id: p.playKey || `local:${p.id}`, title: p.title, artist: p.artist, album: p.album, duration: p.duration, artworkFile: p.artworkFile }));
      const first = { id: track.playKey || `local:${track.id}`, title: track.title, artist: track.artist, album: track.album, duration: track.duration, artworkFile: track.artworkFile || null };
      this.publish([first, ...recent], '', true);
      this.seed = track;
      return;
    }
    // The song itself first: by its Spotify ID when known, or found among its artist's songs, or just as it plays.
    const among = list.find((s) => plain(s.title) === plain(track.title));
    const id = track.playKey?.startsWith('spotify:track:') ? track.playKey : among?.id || `local:${track.id}`;
    const info = id.startsWith('spotify:track:') ? await track_(id) : null;
    const first = { id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, cover: info?.cover || null, artworkFile: track.artworkFile || null };
    const rest = list.filter((s) => s.id !== id && plain(s.title) !== plain(track.title));
    if (this.madeFor !== key) return;
    this.publish([first, ...rest.slice(0, 24)], track.title, false);
    this.seed = track;
    for (const s of this.songs) { this.shown.add(s.id); this.shownTitles.add(plain(s.title)); }
  }

  /** Songs like `track`: its artist's best known songs, two at a time, and between them one of an artist they sing
   *  with, in turn — found on this song and on the artist's songs sung with others. */
  async alike(track, excluded, excludedTitles, fresh) {
    const credited = await artistsOf(track);
    const info = { artists: credited };
    const main = credited[0];
    if (!main) return [];
    let own = await topSongs(main.uri);
    const wanted = fresh ? 5 : 3;
    const others = info.artists.slice(1).map((a) => a.uri);
    let sources = own;
    for (let hop = 0; hop < (fresh ? 2 : 1) && others.length < wanted; hop++) {
      const sung = sources.filter((s) => s.artist.includes(',')).map((s) => s.uri);
      const credits = await Promise.all(sung.map((uri) => track_(uri).then((t) => t?.artists || [])));
      for (const artist of credits.flat()) {
        if (artist.uri !== main.uri && !others.includes(artist.uri) && others.length < wanted) others.push(artist.uri);
      }
      if (!fresh || hop !== 0 || !others[0]) break;
      sources = await topSongs(others[0]);
    }
    if (fresh) { own = shuffled(own); others.splice(0, others.length, ...shuffled(others)); }
    const theirs = (await Promise.all(others.map((uri) => topSongs(uri)))).map((list) => (fresh ? shuffled(list) : list));
    const isNew = (s) => !excluded.has(s.uri) && !excludedTitles.has(plain(s.title));
    const each = Math.max(3, Math.floor(14 / Math.max(theirs.length, 1)));
    const ownLeft = own.filter(isNew);
    const theirsLeft = theirs.map((list) => list.filter(isNew).slice(0, each));
    const mixed = [];
    let turn = 0;
    while (ownLeft.length || theirsLeft.some((l) => l.length)) {
      for (let i = 0; i < 2; i++) if (ownLeft.length) mixed.push(ownLeft.shift());
      for (let offset = 0; offset < theirsLeft.length; offset++) {
        const index = (turn + offset) % theirsLeft.length;
        if (theirsLeft[index].length) { mixed.push(theirsLeft[index].shift()); break; }
      }
      turn++;
    }
    const seen = new Set();
    return mixed.filter((s) => { const p = plain(s.title); if (seen.has(p)) return false; seen.add(p); return true; })
      .map((s) => ({ id: s.uri, title: s.title, artist: s.artist, album: '', duration: s.duration, cover: knownCover(s.uri) }));
  }

  /** Shows the list at once, then its covers as they come: the rows stay, their pictures arrive, a few at a time. */
  publish(list, seedTitle, isRecent) {
    this.songs = list.map((s) => (s.cover || s.artworkFile || !s.id.startsWith('spotify:') ? s : { ...s, cover: knownCover(s.id) }));
    this.seedTitle = seedTitle; this.isRecent = isRecent; this.isLoading = false;
    this.changed();
    const made = this.madeFor;
    let timer = null;
    for (const song of this.songs) {
      if (song.cover || song.artworkFile || !song.id.startsWith('spotify:')) continue;
      cover(song.id).then((link) => {
        if (!link || this.madeFor !== made) return;
        this.songs = this.songs.map((s) => (s.id === song.id && !s.cover ? { ...s, cover: link } : s));
        if (!timer) timer = setTimeout(() => { timer = null; if (this.madeFor === made) this.changed(); }, 120);
      });
    }
  }
}
const track_ = track;

module.exports = { track, topSongs, albumSongs, albumURI, songURI, cover, knownCover, artistURI, artistsOf, SpotifyList, plain };
