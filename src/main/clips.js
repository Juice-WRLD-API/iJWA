// A moving picture for the desktop while a song plays, from Apple Music (Clip.swift, ClipStore.swift): the song's
// music video (the thirty-second preview Apple's store plays), else its album's moving cover, else its artist's
// video. Found with Apple's public iTunes search and Apple Music's pages — no key, no account — fetched once and kept
// on disk up to a limit, the least recently played going first; which clip each song got is remembered, so a song
// played again starts its clip at once.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const applemusic = require('./applemusic');

const COUNTRY = applemusic.STOREFRONT;
const LIMIT = 500 * 1024 * 1024;            // about 25 to 50 clips
const RECHECK_NONE = 3 * 24 * 3600 * 1000;  // Apple adds moving covers over time
const MOST = 3000;

const folder = () => { const f = path.join(app.getPath('userData'), 'Clips'); fs.mkdirSync(f, { recursive: true }); return f; };

// ---- names ----

/** A title without its "(feat. …)", "[Remix]" or " - Single" tail. */
const bare = (text) => String(text || '').replace(/\s*[([].*?[)\]]/g, '').replace(/ - (single|ep)$/i, '').trim();
/** A title or name made plain for comparing: "KAYIP KALP", "Kayıp Kalp" and "kayip kalp" are one. */
function simple(text) {
  return bare(text).toLowerCase().replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/** The first of the artists a song credits. */
function leadArtist(artist) {
  let name = String(artist || '');
  for (const mark of [',', ' & ', ' feat.', ' ft.', ' x ', ' with ']) {
    const at = name.toLowerCase().indexOf(mark);
    if (at >= 0) name = name.slice(0, at);
  }
  return name.trim();
}
/** A name made plain but whole: its brackets kept. */
const whole = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const keyOf = (title, artist) => `${simple(leadArtist(artist))}|${simple(title)}`;

// ---- finding ----

async function items(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) return null;
    return ((await response.json()).results || []).map((item) => ({
      kind: item.kind || '', title: item.trackName || '', artist: item.artistName || '', album: item.collectionName || '',
      albumID: item.collectionId ? String(item.collectionId) : null, artistID: item.artistId ? String(item.artistId) : null,
      preview: item.previewUrl || null,
    }));
  } catch { return null; }
}
const search = (term, entity, limit) =>
  items(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=${limit}&country=${COUNTRY}`);

const memory = new Map(); // term → found, this run

/** What Apple's catalog has for a song: its music video's preview, and the album and artist it belongs to. Null when
 *  neither search could be made. */
async function lookup(term, name, lead, album, wholeAlbum) {
  if (memory.has(term)) return memory.get(term);
  const [videoItems, songItems] = await Promise.all([search(term, 'musicVideo', 10), search(term, 'song', 25)]);
  if (!videoItems && !songItems) return null;
  // The very song by its artist: a cover or a remix by someone else isn't it.
  const isIt = (item) => simple(item.title) === name && simple(item.artist).includes(lead);
  const found = { video: null, song: null };
  found.video = (videoItems || []).find((i) => i.kind === 'music-video' && isIt(i))?.preview || null;
  const matches = (songItems || []).filter((i) => i.kind === 'song' && isIt(i));
  // The album Music says it plays from, as named in full ("HEROES & VILLAINS", not its "(Heroes Version)"), and the
  // song itself rather than its instrumental or a remix.
  const plainTitle = (i) => bare(i.title) === i.title.trim();
  const best = matches.find((i) => whole(i.album) === wholeAlbum) || matches.find((i) => simple(i.album) === album && plainTitle(i))
    || matches.find(plainTitle) || matches[0];
  if (best?.albumID && best.artistID) found.song = { album: best.albumID, artist: best.artistID };
  else {
    // Apple's song search misses plenty: the artist's own list of songs has it, and the artist alone is enough for
    // their video.
    const artists = await search(lead, 'musicArtist', 5);
    const id = (artists?.find((a) => simple(a.artist) === lead) || artists?.[0])?.artistID;
    if (id) {
      const songs = (await items(`https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200&country=${COUNTRY}`)) || [];
      const named = songs.filter((s) => s.kind === 'song' && simple(s.title) === name);
      found.song = { album: (named.find((s) => simple(s.album) === album) || named[0])?.albumID || null, artist: id };
    }
  }
  if (videoItems && songItems) { memory.set(term, found); if (memory.size > 40) memory.delete(memory.keys().next().value); }
  return found;
}

/** The song's best clip whose kind isn't in `skipping`: { found: clip } | { none: true } | { unreachable: true }. */
async function findClip(title, artist, album, skipping = new Set()) {
  const lead = leadArtist(artist), name = simple(title);
  if (!name || !lead) return { none: true };
  const found = await lookup(`${bare(title)} ${lead}`, name, simple(lead), simple(album), whole(album));
  if (!found) return { unreachable: true };
  if (!skipping.has('musicVideo') && found.video) return { found: { kind: 'musicVideo', source: found.video } };
  if (!found.song) return { none: true };
  let missed = false;
  if (!skipping.has('albumMotion') && found.song.album) {
    const page = await applemusic.albumMotion(found.song.album);
    if (page.motion) return { found: { kind: 'albumMotion', source: page.motion.video } };
    missed = !page.read;
  }
  if (!skipping.has('artistMotion')) {
    const page = await applemusic.artist(found.song.artist).catch(() => null);
    if (page) { if (page.motion) return { found: { kind: 'artistMotion', source: page.motion.video } }; }
    else missed = true;
  }
  return missed ? { unreachable: true } : { none: true };
}

// ---- what each song got ----

class ClipIndex {
  constructor() {
    this.file = path.join(folder(), `index-${COUNTRY}.json`);
    try { this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.entries = {}; }
  }
  /** A clip, or that the song has none; undefined when it has to be found. */
  entry(key) {
    const entry = this.entries[key];
    if (!entry) return undefined;
    if (!entry.clip && Date.now() - entry.date > RECHECK_NONE) return undefined;
    return entry;
  }
  set(key, clip) {
    this.entries[key] = { clip: clip || null, date: Date.now() };
    const keys = Object.keys(this.entries);
    if (keys.length > MOST) keys.sort((a, b) => this.entries[a].date - this.entries[b].date).slice(0, keys.length - MOST).forEach((k) => delete this.entries[k]);
    this.saveSoon();
  }
  forget(key) { if (this.entries[key]) { delete this.entries[key]; this.saveSoon(); } }
  saveSoon() {
    clearTimeout(this.saving);
    this.saving = setTimeout(() => fs.writeFile(this.file, JSON.stringify(this.entries), () => {}), 2000);
  }
}

// ---- fetching and keeping ----

/** One name per clip and size: a 4K display and an HD one fetch different sizes. */
function nameFor(clip, pixels) {
  const size = clip.kind === 'musicVideo' ? '' : Math.max(pixels.width, pixels.height) > 2200 ? '@4k' : '@hd';
  return crypto.createHash('sha256').update(clip.source + size).digest('hex').slice(0, 24) + (clip.kind === 'musicVideo' ? '.m4v' : '.mp4');
}

/** Fetches `url` (or the bytes in `range`, [start, end)), telling `arrived(got, all)` as it comes. */
async function download(url, range, arrived) {
  try {
    const headers = range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : {};
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
    if (!(response.status === 206 || response.status === 200)) return null;
    const all = Number(response.headers.get('content-length')) || 0;
    const parts = [];
    let got = 0;
    for await (const chunk of response.body) { parts.push(chunk); got += chunk.length; arrived?.(got, all); }
    const data = Buffer.concat(parts);
    // A server that ignores the range sends the whole file.
    if (range && response.status === 200) return data.length >= range[1] ? data.subarray(range[0], range[1]) : null;
    return data;
  } catch { return null; }
}

/** `KEY=value,KEY="quoted, value"` as an object. */
function attributes(text) {
  const values = {};
  let key = '', value = '', inKey = true, quoted = false;
  const finish = () => { if (key.trim()) values[key.trim()] = value; key = ''; value = ''; inKey = true; };
  for (const c of text) {
    if (inKey) { if (c === '=') inKey = false; else key += c; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) finish();
    else value += c;
  }
  finish();
  return values;
}

/** The playlist's video sizes, SDR only: HDR would look washed out beside the rest. */
function variants(text, base) {
  const lines = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF:') || i + 1 >= lines.length) return;
    const link = lines[i + 1].trim();
    const values = attributes(line.slice('#EXT-X-STREAM-INF:'.length));
    const size = (values.RESOLUTION || '').split('x').map(Number);
    if (!link || link.startsWith('#') || size.length !== 2 || (values['VIDEO-RANGE'] || 'SDR') !== 'SDR') return;
    found.push({ url: new URL(link, base).href, width: size[0], height: size[1],
      bandwidth: Number(values['AVERAGE-BANDWIDTH'] || values.BANDWIDTH) || Infinity, isHEVC: (values.CODECS || '').startsWith('hvc1') });
  });
  return found;
}

/** The fewest bytes among the pictures that cover the display when scaled to fill it, else the biggest there is. H.264
 *  only when offered: Windows plays HEVC only on some graphics cards. */
function choose(list, pixels) {
  const pool = list.some((v) => !v.isHEVC) ? list.filter((v) => !v.isHEVC) : list;
  const area = (v) => v.width * v.height;
  const covering = pool.filter((v) => Math.max(pixels.width / v.width, pixels.height / v.height) <= 1.15);
  if (covering.length) return covering.sort((a, b) => a.bandwidth - b.bandwidth || area(a) - area(b))[0];
  const biggest = Math.max(...pool.map(area));
  return pool.filter((v) => area(v) === biggest).sort((a, b) => a.bandwidth - b.bandwidth)[0] || null;
}

/** The loop's pieces in order — its header, then each few seconds of video — as byte ranges; null for an encrypted
 *  playlist or one of MPEG-TS pieces, which no plain file played here could hold. */
function pieces(text, base) {
  const list = [];
  const ends = new Map();
  let next = null;
  const spec = (s) => { const [length, offset] = s.split('@').map(Number); return { length, offset: Number.isFinite(offset) ? offset : null }; };
  const add = (url, r) => {
    const range = r ? [r.offset ?? ends.get(url) ?? 0, (r.offset ?? ends.get(url) ?? 0) + r.length] : null;
    list.push({ url, range });
    ends.set(url, range ? range[1] : undefined);
  };
  let mapped = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-KEY:')) { if (attributes(line.slice(11)).METHOD !== 'NONE') return null; }
    else if (line.startsWith('#EXT-X-MAP:')) {
      const values = attributes(line.slice(11));
      if (!values.URI) return null;
      mapped = true;
      add(new URL(values.URI, base).href, values.BYTERANGE ? spec(values.BYTERANGE) : null);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) next = spec(line.slice(17));
    else if (line && !line.startsWith('#')) { add(new URL(line, base).href, next); next = null; }
  }
  if (!mapped || !list.length) return null;
  // Pieces that follow on in the same file become one request: Apple's loops come in a single request.
  const joined = [];
  for (const piece of list) {
    const last = joined[joined.length - 1];
    if (last && last.url === piece.url && last.range && piece.range && last.range[1] === piece.range[0]) last.range = [last.range[0], piece.range[1]];
    else joined.push({ ...piece, range: piece.range ? [...piece.range] : null });
  }
  return joined;
}

/** Apple's loop in the one size the display needs, as a single file. */
async function fetchLoop(master, pixels, progress) {
  const text = (await download(master))?.toString('utf8');
  const variant = text && choose(variants(text, master), pixels);
  const playlist = variant && (await download(variant.url))?.toString('utf8');
  const parts = playlist && pieces(playlist, variant.url);
  if (!parts) return null;
  const total = parts.every((p) => p.range) ? parts.reduce((sum, p) => sum + p.range[1] - p.range[0], 0) : 0;
  const file = [];
  let done = 0;
  for (const part of parts) {
    const before = done;
    const data = await download(part.url, part.range, (got) => { if (total) progress?.((before + got) / total); });
    if (!data) return null;
    file.push(data);
    done += data.length;
  }
  return Buffer.concat(file);
}

const saved = () => {
  try {
    return fs.readdirSync(folder()).filter((n) => /\.(mp4|m4v)$/.test(n)).map((n) => {
      const stat = fs.statSync(path.join(folder(), n));
      return { name: n, size: stat.size, date: stat.mtimeMs };
    });
  } catch { return []; }
};

/** The clip's file name in the folder, fetched first if it isn't saved yet; null when it can't be had. */
async function fileFor(clip, pixels, keeping, progress) {
  const name = nameFor(clip, pixels);
  const file = path.join(folder(), name);
  if (fs.existsSync(file)) { const now = new Date(); try { fs.utimesSync(file, now, now); } catch { /* still there */ } return name; }
  const data = clip.kind === 'musicVideo'
    ? await download(clip.source, null, (got, all) => { if (all) progress?.(got / all); })
    : await fetchLoop(clip.source, pixels, progress);
  if (!data?.length) return null;
  fs.writeFileSync(file, data);
  trim(new Set([...keeping, name]));
  return name;
}

/** The oldest-played clips go until the rest fit the limit. */
function trim(kept) {
  const list = saved().sort((a, b) => a.date - b.date);
  let total = list.reduce((sum, c) => sum + c.size, 0);
  for (const clip of list) {
    if (total <= LIMIT) break;
    if (kept.has(clip.name)) continue;
    try { fs.unlinkSync(path.join(folder(), clip.name)); total -= clip.size; } catch { /* in use */ }
  }
}

/** How much room the saved clips take, and freeing it (all but those playing). */
const size = () => saved().reduce((sum, c) => sum + c.size, 0);
function clear(keeping) { for (const clip of saved()) if (!keeping.has(clip.name)) { try { fs.unlinkSync(path.join(folder(), clip.name)); } catch { /* in use */ } } }

module.exports = { findClip, ClipIndex, fileFor, keyOf, folder, size, clear };
