// Apple Music's own lyrics (AppleLyrics in Lyrics.swift), from Better Lyrics' free API, which keeps what its users have
// played and hands those out without a key — word by word for most popular songs. Its store is keyed by the exact
// album and length a player reported, so the player's own names are tried first, then the plainer spellings other
// players use; a song nobody has played yet is missing ("API key required", 401, for a spelling not kept), and LRCLIB
// answers for it.
const { lead } = require('./names');

/** A title or album without its "(feat. …)", "[Deluxe]" or " - Single" tail, case kept. */
function bare(text) {
  let plain = String(text || '');
  for (const mark of [' (', ' [', ' - ']) { const at = plain.indexOf(mark); if (at >= 0) plain = plain.slice(0, at); }
  return plain.trim();
}

/** { status: 'found' | 'none' | 'failed', lyrics? } */
async function findAppleLyrics(track) {
  const singer = lead(track.artist);
  const tries = [];
  for (const attempt of [[track.title, track.artist, track.album], [track.title, track.artist, bare(track.album)], [track.title, track.artist, track.title],
    [bare(track.title), singer, bare(track.album)], [bare(track.title), singer, bare(track.title)]]) {
    if (!tries.some((t) => t.join('\u0000') === attempt.join('\u0000'))) tries.push(attempt);
  }
  for (const [song, artist, album] of tries) {
    const params = new URLSearchParams({ s: song, a: artist, al: album || '' });
    if (track.duration > 0) params.set('d', String(Math.round(track.duration)));
    let response;
    try {
      response = await fetch(`https://lyrics-api.boidu.dev/getLyrics?${params.toString().replace(/\+/g, '%20')}`,
        { headers: { 'User-Agent': 'iBaila/1.0 (Windows)' }, signal: AbortSignal.timeout(8000) });
    } catch { return { status: 'failed' }; }
    if (response.status === 200) {
      try {
        const lyrics = readTTML((await response.json()).ttml);
        return lyrics ? { status: 'found', lyrics } : { status: 'none' };
      } catch { return { status: 'none' }; }
    }
    // Known, and known to have no lyrics.
    if (response.status === 404) return { status: 'none' };
    // Not kept under these names: the next spelling.
    if (response.status === 401) continue;
    return { status: 'failed' };
  }
  return { status: 'none' };
}

// ---- Apple's TTML -------------------------------------------------------------------------------

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, name) =>
  name[0] === '#' ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)) : entities[name] ?? all);

/** "16.344", "1:23.456" or "1:02:03.456", with or without a trailing "s". */
function seconds(value) {
  if (!value) return null;
  let total = 0;
  for (const part of value.replace(/s$/, '').split(':')) { const n = Number(part); if (Number.isNaN(n)) return null; total = total * 60 + n; }
  return total;
}

function syllableWeight(word) {
  const groups = String(word).toLowerCase().match(/[aeiouyäöüıéèêáàâíìîóòôúùû]+/g);
  return Math.max(groups ? groups.length : 1, 1);
}

/** A line's words spread over its time by syllables, never slower than an easy pace (Lyrics.spread). */
function spread(text, start, until) {
  const parts = String(text).split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const weights = parts.map(syllableWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  const easy = total * 0.26 + 0.25;
  const span = Math.max(Math.min(until != null ? until - start - 0.05 : easy, easy), 0.3);
  let time = start;
  return parts.map((part, i) => { const length = span * weights[i] / total; const word = { text: part, start: time, end: time + length }; time += length; return word; });
}

/** Words in brackets in the main voice are adlibs (Lyrics.separate). */
function separate(words) {
  const kept = [], adlibs = [];
  let open = null;
  for (const word of words) {
    const opens = word.text.startsWith('(') || word.text.startsWith('[');
    if (opens && !open) open = { ...word };
    else if (open) { open.text += ` ${word.text}`; open.end = word.end; }
    else kept.push(word);
    if (open && /[)\]]$/.test(open.text)) {
      const inside = open.text.replace(/[()[\]]/g, '').trim();
      if (inside) adlibs.push({ ...open, text: inside });
      open = null;
    }
  }
  if (open) kept.push(...words.filter((w) => w.start >= open.start));
  return { kept, adlibs };
}

/** Syllables with no space between them make one word. */
function joined(syllables) {
  const words = [];
  for (const part of syllables) {
    if (part.joined && words.length) { const last = words[words.length - 1]; last.text += part.text; last.end = part.end; }
    else words.push({ text: part.text, start: part.start, end: part.end });
  }
  return words;
}

/** Apple's TTML: a <p> per line with its begin and end, and, timed word by word, a <span> per syllable; syllables with
 *  no space between them make one word. Background vocals become the line's adlibs, a few words at a time. */
function readTTML(ttml) {
  if (!ttml) return null;
  let timing = 'Line';
  const lines = [];
  let line = null;          // { begin, end, text, syllables, adlibs }
  let syllable = null;      // { start, end, text }
  let background = 0, echoes = [], echo = null;
  let spaced = true;
  const finishEcho = () => {
    let words = joined(echoes);
    if (!words.length && echo) words = spread(echo.text.trim(), echo.start, echo.end);
    const clean = words.map((w) => ({ ...w, text: w.text.replace(/[()[\]]/g, '').trim() })).filter((w) => w.text);
    for (let i = 0; i < clean.length;) {
      const burst = { ...clean[i] };
      let taken = 1;
      while (taken < 3 && i + taken < clean.length && clean[i + taken].start - burst.end < 0.35) {
        burst.text += ` ${clean[i + taken].text}`; burst.end = clean[i + taken].end; taken++;
      }
      line.adlibs.push(burst);
      i += taken;
    }
    echoes = []; echo = null; spaced = true;
  };
  const tokens = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = tokens.exec(ttml))) {
    if (m[5] !== undefined) {
      if (!line) continue;
      const text = decode(m[5]);
      if (syllable) syllable.text += text;
      else { if (/\s/.test(text)) spaced = true; if (background > 0) { if (echo) echo.text += text; } else line.text += text; }
      continue;
    }
    const closing = m[1] === '/', name = m[2].replace(/^.*:/, ''), selfClosing = m[4] === '/';
    const attributes = {};
    for (const a of (m[3] || '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attributes[a[1]] = decode(a[2]);
    if (!closing) {
      if (name === 'tt') {
        const key = Object.keys(attributes).find((k) => k === 'timing' || k.endsWith(':timing'));
        if (key) timing = attributes[key];
      } else if (name === 'p') {
        line = { begin: seconds(attributes.begin), end: seconds(attributes.end), text: '', syllables: [], adlibs: [] };
        spaced = true;
      } else if (name === 'span' && line) {
        const start = seconds(attributes.begin), end = seconds(attributes.end);
        if (background === 0 && attributes['ttm:role'] === 'x-bg') {
          background = 1; echoes = []; echo = start != null && end != null ? { start, end, text: '' } : null; spaced = true;
        } else {
          if (background > 0) background++;
          if (start != null && end != null) syllable = { start, end, text: '' };
        }
        if (selfClosing) { syllable = null; if (background > 0) { background--; if (!background) finishEcho(); } }
      }
      continue;
    }
    if (name === 'span' && line) {
      if (syllable) {
        const text = syllable.text.trim();
        if (text) {
          const heard = { text, start: syllable.start, end: syllable.end, joined: !spaced && !/^\s/.test(syllable.text) };
          if (background > 0) echoes.push(heard); else line.syllables.push(heard);
        }
        spaced = /\s$/.test(syllable.text);
        syllable = null;
      }
      if (background > 0) { background--; if (!background) finishEcho(); }
    } else if (name === 'p' && line) {
      let words = joined(line.syllables);
      const start = line.begin ?? words[0]?.start ?? null;
      if (!words.length && start != null) words = spread(line.text.split(/\s+/).filter(Boolean).join(' '), start, line.end);
      const { kept, adlibs } = separate(words);
      lines.push({ time: start, text: kept.length ? kept.map((w) => w.text).join(' ') : line.text.trim(), words: kept,
        adlibs: [...line.adlibs, ...adlibs].sort((a, b) => a.start - b.start) });
      line = null;
    }
  }
  if (!lines.length) return null;
  // Timed only if some line really has a time; otherwise LRCLIB's timed words win.
  const synced = timing !== 'None' && lines.some((l) => l.time != null);
  return synced ? { lines, isSynced: true, isWordTimed: timing === 'Word' }
    : { lines: lines.map((l) => ({ time: null, text: l.text })), isSynced: false };
}

module.exports = { findAppleLyrics, readTTML };
