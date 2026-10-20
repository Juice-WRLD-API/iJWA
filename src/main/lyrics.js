// A song's words, from LRCLIB (a free open library, timed line by line). A port of LyricsFinder in iJWA's
// Lyrics.swift. Only the song's title, artist, album and length are sent.
// Two changes from the Mac version: a failed request is tried again twice, and a "no lyrics" answer is
// remembered for ten minutes only (the Mac version keeps it until the app quits, so lyrics added to LRCLIB
// later were never seen).

const UA = 'iJWA-Windows/0.1';
const NONE_MEMORY_MS = 10 * 60 * 1000;
const cache = new Map(); // key → { at, result }

const plain = (title) => {
  let text = title.toLowerCase();
  for (const mark of [' (', ' [', ' - ']) { const i = text.indexOf(mark); if (i >= 0) text = text.slice(0, i); }
  return text.trim();
};
const leadArtist = (artist) => {
  let name = artist;
  for (const mark of [',', ' & ', ' feat.', ' ft.', ' x ', ' with ']) {
    const i = name.toLowerCase().indexOf(mark); if (i >= 0) name = name.slice(0, i);
  }
  return name.trim();
};

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (response.status === 404) return { missing: true };
      if (response.status === 200) {
        // LRCLIB's JSON is sometimes sent with raw control characters in a string: be tolerant.
        const text = await response.text();
        try { return { value: JSON.parse(text) }; }
        catch { try { return { value: JSON.parse(text.replace(/[\u0000-\u001f]/g, (c) => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : ''))) }; } catch { return { missing: true }; } }
      }
    } catch { /* offline, timed out: try again */ }
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  return { failed: true };
}

const query = (params) => new URLSearchParams(params).toString();

// ---- words ------------------------------------------------------------------------------

function syllables(word) {
  const text = word.toLowerCase().replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');
  let count = 0, inVowel = false;
  for (const ch of text) { const vowel = 'aeiouy'.includes(ch); if (vowel && !inVowel) count++; inVowel = vowel; }
  return Math.max(count, 1);
}

/** A line's words spread over the time it is sung, by syllables, never slower than an easy pace. */
function spread(text, start, until) {
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const weights = parts.map(syllables);
  const total = weights.reduce((a, b) => a + b, 0);
  const easy = total * 0.26 + 0.25;
  const span = Math.max(Math.min(until != null ? until - start - 0.05 : easy, easy), 0.3);
  let time = start;
  return parts.map((word, i) => { const length = (span * weights[i]) / total; const w = { text: word, start: time, end: time + length }; time += length; return w; });
}

/** "(yeah)" and "[uh]" are adlibs: kept apart from the line's own words. */
function separate(words) {
  const kept = [], adlibs = [];
  let open = null;
  for (const word of words) {
    const opens = word.text.startsWith('(') || word.text.startsWith('[');
    if (!open && !opens) { kept.push(word); continue; }
    if (open) { open = { ...open, text: open.text + ' ' + word.text, end: word.end }; } else { open = word; }
    if (open.text.endsWith(')') || open.text.endsWith(']')) {
      const inside = open.text.replace(/^[()[\] ]+|[()[\] ]+$/g, '');
      if (inside) adlibs.push({ text: inside, start: open.start, end: open.end });
      open = null;
    }
  }
  if (open) kept.push(...words.filter((w) => w.start >= open.start));
  return { words: kept, adlibs };
}

function timedLines(raw) {
  let rest = raw;
  const times = [];
  while (rest.startsWith('[')) {
    const close = rest.indexOf(']'); if (close < 0) break;
    const stamp = rest.slice(1, close).split(':');
    if (stamp.length !== 2 || isNaN(Number(stamp[0])) || isNaN(Number(stamp[1]))) break;
    times.push(Number(stamp[0]) * 60 + Number(stamp[1]));
    rest = rest.slice(close + 1);
  }
  const text = rest.trim();
  return times.map((time) => ({ time, text }));
}

function lyricsFrom(record) {
  if (record.syncedLyrics) {
    const lines = record.syncedLyrics.split(/\r?\n|\r/).flatMap(timedLines).sort((a, b) => a.time - b.time);
    lines.forEach((line, i) => {
      const next = lines[i + 1] ? lines[i + 1].time : null;
      Object.assign(line, separate(spread(line.text, line.time, next)));
    });
    if (lines.length) return { lines, isSynced: true };
  }
  if (record.plainLyrics) {
    return { lines: record.plainLyrics.split(/\r?\n|\r/).map((text) => ({ time: null, text })), isSynced: false };
  }
  return null;
}

/** Of a search's finds, the timed version nearest the song's length; found by title alone (`sure` false),
 *  only one as long as this song, to three seconds: no words rather than someone else's. */
function best(records, duration, sure) {
  const timed = records.filter((r) => r.syncedLyrics);
  if (!sure) {
    if (!(duration > 0)) return null;
    const hit = timed.find((r) => Math.abs((r.duration || 0) - duration) <= 3);
    return hit ? lyricsFrom(hit) : null;
  }
  const nearest = duration > 0
    ? timed.slice().sort((a, b) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration))[0]
    : timed[0];
  if (nearest) { const l = lyricsFrom(nearest); if (l) return l; }
  for (const r of records) { const l = lyricsFrom(r); if (l) return l; }
  return null;
}

// ---- the lookup -------------------------------------------------------------------------

async function lookup(track) {
  const base = 'https://lrclib.net/api';
  const exactParams = { track_name: track.title, artist_name: track.artist, album_name: track.album || '' };
  if (track.duration > 0) exactParams.duration = String(Math.round(track.duration));
  const first = await fetchJson(`${base}/get?${query(exactParams)}`);
  if (first.value) { const l = lyricsFrom(first.value); if (l) return { status: 'found', lyrics: l }; }

  const bare = plain(track.title);
  const searches = [];
  if (!track.artist) {
    searches.push({ q: bare || track.title });
  } else {
    searches.push({ track_name: track.title, artist_name: track.artist });
    if (bare && bare !== track.title.toLowerCase()) searches.push({ track_name: bare, artist_name: track.artist });
  }
  // Then as other players name it: YouTube Music joins artists in the browser's language ("Fat Papi ve prodshushy",
  // which LRCLIB knows as "Fat Papi, prodshushy"), so by the first of them; and a SoundCloud upload is often "Artist -
  // Title" by whoever uploaded it, so by its own two halves, and by the title alone — those two only for a version as
  // long as this one, since the name alone could be anybody's.
  const unsure = [];
  if (track.artist) {
    const lead = require('./names').lead(track.artist);
    if (lead && lead.toLowerCase() !== track.artist.toLowerCase()) searches.push({ track_name: bare || track.title, artist_name: lead });
    for (const dash of [' - ', ' \u2013 ']) {
      const at = track.title.indexOf(dash);
      if (at < 0) continue;
      const singer = track.title.slice(0, at).trim(), song = plain(track.title.slice(at + dash.length));
      if (singer && song) unsure.push({ track_name: song, artist_name: singer });
      break;
    }
    if (track.duration > 0) unsure.push({ q: bare || track.title });
  }
  let answered = !first.failed;
  for (const [params, sure] of [...searches.map((p) => [p, Boolean(track.artist)]), ...unsure.map((p) => [p, false])]) {
    const found = await fetchJson(`${base}/search?${query(params)}`);
    if (found.value) {
      answered = true;
      const l = best(found.value, track.duration, sure);
      if (l) return { status: 'found', lyrics: l };
    } else if (found.missing) answered = true;
  }
  // Free text, for songs LRCLIB spells differently ("Run Away (OMALICHA)"): only a version of the same length.
  if (track.artist) {
    const found = await fetchJson(`${base}/search?${query({ q: `${bare || track.title} ${leadArtist(track.artist)}` })}`);
    if (found.value) {
      answered = true;
      const l = best(found.value.filter((r) => leadArtist(r.artistName || '').toLowerCase() === leadArtist(track.artist).toLowerCase()), track.duration, false);
      if (l) return { status: 'found', lyrics: l };
    } else if (found.missing) answered = true;
  }
  return { status: answered ? 'none' : 'failed' };
}

/** { status: 'found' | 'none' | 'failed', lyrics? }. Words timed on this computer from the song itself
 *  (syncedlyrics.js) come before all; then words chosen by hand for this song; a song no source has words for gets
 *  Genius's, which has many unreleased songs' (LyricsFinder.find). */
async function findLyrics(track) {
  const timed = require('./syncedlyrics').lyrics(track);
  if (timed) return { status: 'found', lyrics: timed };
  const genius = require('./genius');
  if (genius.picks.url(track)) return genius.find(track);
  const found = await findTimed(track);
  return found.status === 'none' ? genius.find(track) : found;
}

async function findTimed(track) {
  const key = `${track.title}\n${track.artist}\n${track.album || ''}\n${Math.round(track.duration || 0)}`;
  const hit = cache.get(key);
  if (hit && (hit.result.status === 'found' || Date.now() - hit.at < NONE_MEMORY_MS)) return hit.result;
  // Apple Music's own words, timed word by word, and LRCLIB's, asked together (LyricsFinder.find): a timed find wins,
  // Apple's first; then any words at all.
  const [apple, open] = await Promise.all([require('./applelyrics').findAppleLyrics(track).catch(() => ({ status: 'failed' })), lookup(track)]);
  const result = apple.status === 'found' && apple.lyrics.isSynced ? apple
    : open.status === 'found' && open.lyrics.isSynced ? open
    : apple.status === 'found' ? apple
    : open.status === 'found' ? open
    // Not reached at all only when neither answered.
    : { status: open.status === 'failed' && apple.status === 'failed' ? 'failed' : open.status === 'failed' ? 'failed' : 'none' };
  if (result.status !== 'failed') cache.set(key, { at: Date.now(), result });
  return result;
}

/** Lyrics with no timing, given an even pace over a song this long, so they can be shown word by word all the same. */
function paced(lyrics, duration) {
  if (!lyrics || lyrics.isSynced) return lyrics;
  const sung = lyrics.lines.filter((line) => line.text.trim());
  const length = duration > 0 ? duration : sung.length * 3;
  const step = length / Math.max(sung.length, 1);
  return {
    isSynced: true,
    lines: sung.map((line, index) => {
      const start = index * step;
      const { words, adlibs } = separate(spread(line.text, start, start + step));
      return { time: start, text: words.map((w) => w.text).join(' '), words, adlibs };
    }),
  };
}

module.exports = { findLyrics, paced, plain, leadArtist, separate };
