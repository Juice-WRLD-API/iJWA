// Continue Playing for someone listening in Apple Music (CatalogPlayer.suggest in CatalogPlayer.swift): the playing
// song first, then its artist's best known songs two at a time, each pair followed by one of an artist like them, the
// artists taking turns — read from Apple Music's own artist pages (applemusic.js), no account. The refresh asks for a
// wider circle in a new order, songs not shown yet first. With nothing playing, the songs played in Apple Music lately.
const applemusic = require('./applemusic');
const { simple } = require('./names');

const artistIDs = new Map();   // name → Apple's artist ID
const pages = new Map();       // artist ID → its page

async function artistID(name) {
  const key = String(name || '').toLowerCase();
  if (!key) return null;
  if (artistIDs.has(key)) return artistIDs.get(key);
  const found = await applemusic.search(name).catch(() => null);
  if (!found) return null;
  const artist = found.artists.find((a) => a.title.toLowerCase() === key)
    || found.top.find((i) => i.kind === 'artist' && i.title.toLowerCase() === key) || found.artists[0];
  if (artist) artistIDs.set(key, artist.id);
  return artist?.id || null;
}

async function page(id) {
  if (pages.has(id)) return pages.get(id);
  const found = await applemusic.artist(id).catch(() => null);
  if (found) { pages.set(id, found); if (pages.size > 60) pages.delete(pages.keys().next().value); }
  return found;
}

const shuffled = (list) => {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

class CatalogList {
  songs = [];         // { id, title, artist, album, cover }
  isLoading = false;
  isRecent = false;   // the user's own recent songs, not songs like one
  madeFor = null;
  seed = null;
  seedTitle = '';
  shown = new Set();  // songs listed for the seed already, so a refresh brings others first

  constructor(onChange, recent) { this.onChange = onChange; this.recent = recent; }

  /** The songs played in Apple Music lately, newest first: what it lists before anything plays. */
  recall() {
    this.madeFor = 'recent';
    this.isLoading = false;
    this.isRecent = true;
    this.seed = null;
    this.seedTitle = '';
    this.songs = this.recent();
    this.onChange();
  }

  /** Songs to carry on with after `track`, unless the list is for it already. */
  suggest(track) {
    if (this.madeFor === track.id && this.songs.length) return;
    this.build(track, false);
  }

  /** Fresh songs like `track`: a wider circle of artists, mixed anew, songs not shown yet first. */
  refresh(track) { this.build(track, true); }

  async build(track, wide) {
    const key = track.id;
    if (this.madeFor !== key) this.shown = new Set();
    this.madeFor = key;
    this.isLoading = true;
    this.onChange();
    const found = await this.similar(track, wide).catch(() => []);
    if (this.madeFor !== key) return;
    this.isLoading = false;
    if (found.length) {
      this.songs = found;
      this.isRecent = false;
      this.seed = track;
      this.seedTitle = track.title;
      for (const s of found) this.shown.add(s.id);
    }
    this.onChange();
  }

  async similar(track, wide) {
    const lead = require('./names').lead(track.artist);
    const id = await artistID(lead);
    if (!id) return [];
    const own = await page(id);
    if (!own) return [];
    const fresh = (s) => !wide || !this.shown.has(s.id);
    let mine = own.topSongs.filter(fresh);
    if (wide) mine = shuffled(mine);
    let alike = own.similar.slice(0, wide ? 14 : 6);
    if (wide) alike = shuffled(alike);
    const others = (await Promise.all(alike.map((a) => page(a.id))))
      .map((p) => { let top = (p?.topSongs || []).filter(fresh); if (wide) top = shuffled(top); return top.slice(0, 3); });

    // Two of the artist's, then one of an artist like them, the artists taking turns.
    const mixed = [];
    let turn = 0;
    while (mine.length || others.some((o) => o.length)) {
      for (let i = 0; i < 2 && mine.length; i++) mixed.push(mine.shift());
      for (let k = 0; k < others.length; k++) {
        const list = others[(turn + k) % others.length];
        if (list.length) { mixed.push(list.shift()); break; }
      }
      turn += 1;
    }

    // The song playing first, as the list shows it on top; each title once.
    const shape = (s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album || '', cover: applemusic.artworkURL(s.artwork, 120) });
    const playing = own.topSongs.find((s) => simple(s.title) === simple(track.title));
    const result = [playing ? shape(playing) : { id: `seed:${track.id}`, title: track.title, artist: track.artist, album: track.album || '', cover: null }];
    const titles = new Set([simple(track.title)]);
    for (const s of mixed) {
      if (titles.has(simple(s.title))) continue;
      titles.add(simple(s.title));
      result.push(shape(s));
      if (result.length === 25) break;
    }
    return result;
  }
}

module.exports = { CatalogList };
