'use strict';
// Untimed words (Genius's) timed to the song itself, the matching half of iJWA's LyricsSync.swift, ported step by
// step (2026-10-12): the same constants, the same order, the same ties, so a song's words land on the same times on
// Mac and Windows. Whisper and the voice detector are run by the caller; what's here is pure: their output read, the
// gaps chosen to be heard again, and the lyrics' words matched in order to the words heard.
//
// Swift and JavaScript differ underneath in a few places, each handled where it matters: Swift counts and compares
// Characters (grapheme clusters, canonically equal), so words are cut into graphemes here and normalized (NFC);
// Swift's `rounded()` takes halves away from zero; `Int(x)` cuts toward zero; `.whitespaces` holds spaces and tabs,
// never newlines; Swift lowercases letter by letter (no Greek final-sigma rule).

const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A string's Characters, as Swift counts them. */
const graphemes = (text) => Array.from(graphemer.segment(text), (piece) => piece.segment);

/** Swift's `rounded()`: halves away from zero. */
const rounded = (value) => (value < 0 ? -Math.round(-value) : Math.round(value));

/** Swift's `trimmingCharacters(in: .whitespaces)`: spaces (Zs), tabs and the zero-width space, not newlines. */
const trimmed = (text) => text.replace(/^[\p{Zs}\t\u200B]+|[\p{Zs}\t\u200B]+$/gu, '');

/** Swift's `Double(String)`: a plain decimal number, nothing round it; nil (null) otherwise. */
function double(text) {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return NaN;
  return null;
}

// MARK: Hearing

/** What Swift's `hear()` makes of whisper-cli's `-ojf` JSON (a string, a Buffer, or the object already read): every
 *  word with when it starts, `offset` added (the start of the piece heard, in `rehear`). Null where Swift's
 *  JSONSerialization would fail — bytes that aren't UTF-8 among them (whisper.cpp writes tokens byte for byte, so a
 *  letter can be cut between two). */
function wordsFromWhisper(json, offset = 0) {
  let data = json;
  try {
    if (Buffer.isBuffer(data)) data = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (typeof data === 'string') data = JSON.parse(data);
  } catch { return null; }
  const segments = data && !Array.isArray(data) && typeof data === 'object' ? data.transcription : null;
  if (!Array.isArray(segments) || !segments.every((s) => s && typeof s === 'object' && !Array.isArray(s))) return null;
  const words = [];
  for (const segment of segments) {
    const tokens = Array.isArray(segment.tokens) && segment.tokens.every((t) => t && typeof t === 'object' && !Array.isArray(t))
      ? segment.tokens : [];
    for (const token of tokens) {
      const text = token.text;
      if (typeof text !== 'string' || text.startsWith('[_') || text.startsWith('<|')) continue;
      // whisper.cpp's word times come a steady 0.4 s late (measured on two songs against Python Whisper).
      const dtw = typeof token.t_dtw === 'number' ? token.t_dtw : -1;
      const offsets = token.offsets && typeof token.offsets === 'object' && !Array.isArray(token.offsets) ? token.offsets : null;
      const from = (offsets && typeof offsets.from === 'number' ? offsets.from : 0) / 1000;
      const start = Math.max((dtw >= 0 ? dtw / 100 : from) - 0.4, 0);
      if (graphemes(text)[0] === ' ' || words.length === 0) {
        words.push({ word: trimmed(text), start });
      } else {
        words[words.length - 1].word += text;
      }
    }
  }
  // What Whisper writes for what isn't words — "[MUSIC PLAYING]", "(laughs)", "♪" — isn't sung: taken as a
  // word, the lyrics began with the intro's music (Fire In My Lungs, 2026-10-12).
  const kept = [];
  let aside = false;
  for (const word of words) {
    if (word.word === '') continue;
    const letters = graphemes(word.word);
    const first = letters[0], last = letters[letters.length - 1];
    if (first === '[' || first === '(' || first === '♪' || first === '*') aside = true;
    if (!aside) kept.push({ word: word.word, start: word.start + offset });
    if (last === ']' || last === ')' || last === '♪' || last === '*') aside = false;
  }
  return kept;
}

/** Where someone sings, from the voice detector's (whisper-vad-speech-segments) output:
 *  "VAD segment 3: start = 31.52, end = 33.57 (duration: 2.05)". Lines end in "\r\n" on Windows; on the Mac they
 *  never do (Swift would take "\r\n" for one character and miss every line after the first). */
function voicesFromOutput(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const s = line.indexOf('start = '), e = line.indexOf(', end = ');
    if (!line.includes('VAD segment') || s < 0 || e < 0 || e < s + 'start = '.length) return null;
    const start = double(trimmed(line.slice(s + 'start = '.length, e)));
    const end = double(line.slice(e + ', end = '.length).match(/^[.\p{N}]*/u)[0]);
    if (start === null || end === null || !(end > start)) return null;
    return { start, end };
  }).filter(Boolean);
}

// MARK: Hearing again

/** Whisper skips stretches of a song: taking a rapped intro for music, it wrote "(upbeat music)" and went on 30 s
 *  later, every line of it then crowded into what it heard next (Plottin', Pop Star — Lil Mosey, 2026-10-12). A gap
 *  of over 8 s with no word heard where the voice detector heard someone is heard again on its own, from where the
 *  voice starts, at most 28 s at a time; its words replace the few heard there, if more. Heard from the gap's first
 *  voice and still missed — Whisper starting on a lone breath takes it all for music again — it's heard from the
 *  voice after that, eight times at most. Measured: Pop Star's intro 1 word → 30 (its second try, from 12.2 s),
 *  Plottin's 0 → 67; Back In Chicago and Fire In My Lungs as they were. */
const REHEAR_ROUNDS = 8;

/** Each gap: from a little before the voice first heard in it (after `after`), to the next word heard. */
function gaps(words, voiced, length) {
  const marks = [0, ...words.map((w) => w.start), length];
  const open = [];
  for (let k = 0; k + 1 < marks.length; k += 1) {
    const a = marks[k], b = marks[k + 1];
    if (!(b - a > 8)) continue;
    const inside = voiced.filter((v) => v.end > a && v.start < b);
    if (!(inside.reduce((sum, v) => sum + Math.min(v.end, b) - Math.max(v.start, a), 0) >= 0.5)) continue;
    const starts = inside.map((v) => Math.max(v.start, a));
    open.push({ start: Math.max(starts[0] - 0.3, a > 0 ? a + 0.3 : 0), end: b, voices: starts });
  }
  return open;
}

/** The next stretch to hear again, as one round of `rehear`'s loop picks it, or null to stop: `tried` (a Set kept
 *  by the caller across rounds) gets the stretch's key, as Swift's does. `from`/`to` are the seconds to hear; `first`
 *  and `last` the byte range of 16 kHz 16-bit samples (`bytes` of them in all) — with `last <= first` the round is
 *  spent and nothing heard. */
function nextGap(words, voiced, length, tried, bytes = Math.round(length * 32000)) {
  const open = gaps(words, voiced, length);
  let next = null;
  const gap = open.find((g) => !tried.has(rounded(g.start * 10)));
  if (gap) next = { start: gap.start, end: gap.end };
  if (next === null) {
    // Every gap heard from its first voice already: from the voice after that.
    for (const g of open) {
      const voice = g.voices.find((v) => v > g.start + 1 && v < g.end - 2 && !tried.has(rounded((v - 0.3) * 10)));
      if (voice !== undefined) { next = { start: voice - 0.3, end: g.end }; break; }
    }
  }
  if (next === null) return null;
  tried.add(rounded(next.start * 10));
  // Heard on to 28 s past its start, not cut where the gap ends: given 7.6 s alone, Whisper on Windows heard nothing
  // where the Mac, given 21 s, heard the whole verse (Plottin', 2026-10-12). Only the gap's words are taken.
  const from = Math.max(next.start, 0), to = Math.min(next.start + 28 + 0.3, length), until = Math.min(next.end, to);
  const first = Math.trunc(from * 16000) * 2, last = Math.min(Math.trunc(to * 16000) * 2, bytes);
  return { start: next.start, end: next.end, from, to, until, first, last };
}

/** The words heard again (`found`, their starts already counted from the song's start: `wordsFromWhisper(json,
 *  from)`) put in place of those heard before between `from` and `to`, if more; otherwise `words` as they were. */
function merge(words, found, from, to) {
  const again = found.filter((w) => w.start >= from && w.start <= to);
  const before = words.filter((w) => w.start >= from && w.start <= to).length;
  if (!(again.length > before)) return words;
  return words.filter((w) => w.start < from || w.start > to).concat(again).sort((x, y) => x.start - y.start);
}

/** `rehear` whole: `hear(from, to, first, last)` hears samples[first..<last] with half a second of quiet after it
 *  (16000 zero bytes, so its last word isn't cut) and answers `wordsFromWhisper(json, from)`, or null. */
async function rehear(heard, voiced, bytes, hear) {
  const length = bytes / 2 / 16000;
  let words = heard;
  const tried = new Set();
  for (let round = 0; round < REHEAR_ROUNDS; round += 1) {
    const next = nextGap(words, voiced, length, tried, bytes);
    if (!next) break;
    if (!(next.last > next.first)) continue;
    const again = await hear(next.from, next.to, next.first, next.last);
    if (!again) continue;
    words = merge(words, again, next.from, next.until);
  }
  return words;
}

// MARK: Matching

/** Swift's `Character.isLetter` / `isNumber` (its first scalar alphabetic, or with a numeric value), or "'". */
const matchable = (letter) => letter === "'" || /^[\p{Alphabetic}\p{N}]/u.test(letter);

/** Foundation's `.diacriticInsensitive` folding of one Character, as measured against it code point by code point
 *  (2026-10-12): a Character on a Latin, Greek or Cyrillic letter (one that, taken apart, starts below U+0510) loses
 *  every mark that extends it, skin tones too ("é" is "e", "≠" is "="); one on any other letter stays whole and loses
 *  only the accents of U+0300–036F and U+0483–0489 after it — Arabic's hamza, Devanagari's nukta and Japanese's
 *  dakuten stay. What follows the first letter is never taken apart: it goes whole or stays whole. */
function folded(letter) {
  const [first, ...after] = Array.from(letter);
  const [base, ...marks] = Array.from(first.normalize('NFD'));
  if (base.codePointAt(0) < 0x510) {
    return (base + marks.concat(after).filter((scalar) => !/^[\p{Grapheme_Extend}\u{1F3FB}-\u{1F3FF}]$/u.test(scalar)).join('')).normalize('NFC');
  }
  return (first + after.filter((scalar) => !/^[\u0300-\u036F\u0483-\u0489]$/u.test(scalar)).join('')).normalize('NFC');
}

/** A word as matched, cut into Characters: lowercase, "’" as "'", accents off, letters, digits and "'" only. */
function plainLetters(word) {
  const lower = Array.from(word, (scalar) => scalar.toLowerCase()).join('').replace(/’/g, "'");
  return graphemes(graphemes(lower).map(folded).join('')).filter(matchable);
}

/** A line's words as shown, each with the parts it's heard as: "Oh-oh" is heard as two words, "oh" and "oh"
 *  (Fire In My Lungs's opening went unmatched for that, 2026-10-12); adlibs in brackets are kept to show, never
 *  matched, as they are often not sung as written. Each part as its Characters. */
function tokens(line) {
  let inBrackets = false;
  return line.split(/\p{White_Space}+/u).filter((piece) => piece !== '').map((text) => {
    const letters = graphemes(text);
    if (letters[0] === '(') inBrackets = true;
    const parts = inBrackets ? [] : text.split(/[-–—]/).filter((p) => p !== '').map(plainLetters).filter((p) => p.length > 0);
    if (letters[letters.length - 1] === ')') inBrackets = false;
    return { text, parts, size: letters.length };
  });
}

/** How alike two words are, 0…1, as difflib's ratio has it: twice the letters in order they share over both lengths. */
function alike(x, y) {
  const table = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= y.length; j += 1) {
      const above = table[j];
      table[j] = x[i - 1] === y[j - 1] ? diagonal + 1 : Math.max(table[j], table[j - 1]);
      diagonal = above;
    }
  }
  return (2 * table[y.length]) / (x.length + y.length);
}

/** Every word of `lines` timed from the words heard: the lyrics' words matched in order to the words heard (like
 *  a diff, near spellings allowed, nearer ones counting more); each matched word takes its time; the others are
 *  spread between the matched ones round them, by their length; before the first heard, from where the singing
 *  was first heard; and nothing comes before what's above it. Answers { lines: [{ text, words: [{ text, start,
 *  end }], heard }] }. */
function align(lines, heard, voiced = [], length) {
  const shown = lines.map(tokens);
  // Every part to match, with its line and token.
  const parts = [];
  shown.forEach((line, l) => line.forEach((token, k) => { for (const part of token.parts) parts.push({ line: l, token: k, word: part, text: part.join('') }); }));
  const said = heard.map((h) => plainLetters(h.word));
  const n = parts.length, m = said.length;
  const joined = said.map((s) => s.join(''));
  function similarity(i, j) {
    const a = parts[i].word, b = said[j];
    if (a.length === 0 || b.length === 0) return -1;
    if (parts[i].text === joined[j]) return 2;
    if (!(Math.min(a.length, b.length) >= 2)) return -1;
    const ratio = alike(a, b);
    if (ratio >= 0.75 && Math.min(a.length, b.length) >= 3) return 1;
    if (ratio >= 0.6) return 0.4;
    return -1;
  }
  const moves = new Uint8Array((n + 1) * (m + 1));
  let previous = new Array(m + 1).fill(0);
  let row = new Array(m + 1).fill(0);
  if (n > 0 && m > 0) {
    for (let i = 1; i <= n; i += 1) {
      row[0] = 0;
      for (let j = 1; j <= m; j += 1) {
        let best = previous[j], move = 1;
        if (row[j - 1] > best) { best = row[j - 1]; move = 2; }
        const diagonal = previous[j - 1] + similarity(i - 1, j - 1);
        if (diagonal > best) { best = diagonal; move = 3; }
        row[j] = best;
        moves[i * (m + 1) + j] = move;
      }
      [previous, row] = [row, previous];
    }
  }
  // Each token's time: its first part matched.
  const known = shown.map((line) => new Array(line.length).fill(null));
  let i = n, j = m;
  while (i > 0 && j > 0) {
    switch (moves[i * (m + 1) + j]) {
      case 3:
        if (similarity(i - 1, j - 1) > 0) known[parts[i - 1].line][parts[i - 1].token] = heard[j - 1].start;
        i -= 1; j -= 1;
        break;
      case 1: i -= 1; break;
      default: j -= 1;
    }
  }
  // All tokens in a row, those not matched placed between those that are, by length.
  const flat = [];
  shown.forEach((line, l) => line.forEach((token, k) => flat.push({ line: l, token: k, size: Math.max(token.size, 2), time: known[l][k] })));
  const anchors = flat.map((_, index) => index).filter((index) => flat[index].time !== null);
  const pace = 0.33; // seconds a word, sung at an easy pace, where nothing says otherwise
  const times = flat.map((f) => f.time);
  // Ranges are [lower, upper), as Swift's lower..<upper.
  const count = (range) => range[1] - range[0];
  function spread(range, start, end) {
    if (count(range) <= 0) return;
    let total = 0;
    for (let index = range[0]; index < range[1]; index += 1) total += flat[index].size;
    let at = start;
    for (let index = range[0]; index < range[1]; index += 1) {
      times[index] = at;
      at += (end - start) * flat[index].size / Math.max(total, 1);
    }
  }
  const natural = (range) => pace * count(range);
  /** Lines no one heard, each a bar: the lines among `range` share the time sung — from the first voice heard to
   *  what's heard next — evenly, a line's words spread over its share. Fit to the voice detector's breaths instead,
   *  the lines of Fire In My Lungs' intro came seconds early, then seconds late: Juice holds a line a bar however
   *  he breathes in it (bars of ~4 s, measured against a hand-timed copy, 2026-10-12). False, and nothing
   *  placed, with no voice heard. */
  function phrased(range, stretches, to) {
    if (stretches.length === 0) return false;
    const windowStart = stretches[0][0];
    let groups = [];
    let start = range[0];
    for (let index = range[0]; index < range[1]; index += 1) {
      if (index + 1 === range[1] || flat[index + 1].line !== flat[index].line) {
        groups.push([start, index + 1]);
        start = index + 1;
      }
    }
    // The rest of a line already heard ("Mix it" before "with the pills") stays with the words heard of it.
    let head = null, tail = null;
    if (groups.length > 0) {
      const first = groups[0];
      if (first[0] > 0 && flat[first[0] - 1].line === flat[first[0]].line) head = groups.shift();
    }
    if (groups.length > 0) {
      const last = groups[groups.length - 1];
      if (last[1] < flat.length && flat[last[1]].line === flat[last[0]].line) tail = groups.pop();
    }
    // A word or two in brackets is an adlib over the line before, not a bar of its own; a whole line in
    // brackets is sung ("(ATL Jacob want some more…)", its own bar).
    const riders = groups.filter((group) => {
      if (count(group) > 2) return false;
      for (let index = group[0]; index < group[1]; index += 1) {
        if (shown[flat[index].line][flat[index].token].parts.length !== 0) return false;
      }
      return true;
    });
    groups = groups.filter((group) => !riders.includes(group));
    let from = windowStart, until = to;
    if (head) {
      const after = times[head[0] - 1] ?? windowStart;
      spread(head, after, Math.min(after + natural(head) + pace, to));
      const end = times[head[1] - 1];
      from = Math.max(from, end !== null && end !== undefined ? end + pace : from);
    }
    if (tail && times[tail[1]] !== null && times[tail[1]] !== undefined) {
      const next = times[tail[1]];
      spread(tail, Math.max(next - natural(tail), from), next);
      until = times[tail[0]] ?? until;
    }
    if (groups.length > 0) {
      const bar = (until - from) / groups.length;
      if (!(bar > 0.3)) return false;
      groups.forEach((group, g) => spread(group, from + bar * g, from + bar * (g + 1) - 0.1));
    }
    for (const rider of riders) {
      const before = rider[0] > 0 ? (times[rider[0] - 1] ?? windowStart) : windowStart;
      spread(rider, before + 0.05, before + 0.05 + 0.05 * count(rider));
    }
    return true;
  }
  /** Words no one heard, between `from` and `to`, sung where the voice detector heard someone there — or, with
   *  no one heard there, at an easy pace: those of the line before right after it, the rest right before what
   *  follows, never spread across a stretch of beat (they ran ahead of the song: "müziği beklemiyor, hep aynı
   *  tonda söylediğini sanıyor", 2026-10-12). */
  function fill(range, from, to, anchor) {
    if (!(count(range) > 0 && to > from)) return spread(range, from, Math.max(to, from + 0.05));
    const inside = [];
    for (const v of voiced) {
      const s = Math.max(v.start, from), e = Math.min(v.end, to);
      if (e - s >= 0.25) inside.push([s, e]);
    }
    const sung = inside.reduce((sum, stretch) => sum + stretch[1] - stretch[0], 0);
    // Where a voice was heard, the words go there, however short the gap: spread evenly over a sung intro, they
    // ran a line ahead of Juice's humming (Fire In My Lungs, 2026-10-12).
    if (sung < natural(range) * 0.35 && to - from <= natural(range) * 1.8) return spread(range, from, to);
    if (sung >= natural(range) * 0.35 && phrased(range, inside, to)) return undefined;
    if (sung >= natural(range) * 0.35) {
      // In the voice's stretches, in order, each taking its share of the words by its length.
      let index = range[0];
      let used = 0.0;
      for (const [s, e] of inside) {
        used += e - s;
        const until = range[0] + Math.trunc(rounded(count(range) * used / sung));
        const last = Math.min(Math.max(until, index), range[1]);
        spread([index, last], s, e);
        index = last;
      }
      if (index < range[1]) spread([index, range[1]], inside[inside.length - 1][0], inside[inside.length - 1][1]);
      return undefined;
    }
    // No voice heard there: the words keep close to what they're sung beside.
    let sameLine = 0;
    if (anchor !== null) {
      while (range[0] + sameLine < range[1] && flat[range[0] + sameLine].line === flat[anchor].line) sameLine += 1;
    }
    const early = [range[0], range[0] + sameLine];
    const late = [early[1], range[1]];
    spread(early, from, Math.min(from + natural(early), to));
    spread(late, Math.max(to - natural(late), count(early) <= 0 ? from : Math.min(from + natural(early), to)), to);
    return undefined;
  }
  if (anchors.length > 0) {
    const first = anchors[0], last = anchors[anchors.length - 1];
    fill([0, first], 0, times[first] - 0.1, null);
    for (let k = 0; k + 1 < anchors.length; k += 1) {
      const a = anchors[k], b = anchors[k + 1];
      if (!(b > a + 1)) continue;
      const start = times[a] + Math.min(pace, (times[b] - times[a]) * 0.5);
      fill([a + 1, b], start, times[b], a);
    }
    if (last + 1 < flat.length) {
      const tail = Math.min(times[last] + pace * (flat.length - last), Math.max(length - 1, times[last] + 1));
      spread([last + 1, flat.length], times[last] + pace, tail);
    }
  } else {
    fill([0, flat.length], 0, Math.max(length - 1, pace * flat.length), null);
  }
  const starts = times.map((t) => t ?? 0);
  for (let index = 1; index < starts.length; index += 1) starts[index] = Math.max(starts[index], starts[index - 1] + 0.05);
  // Each word lasts until the next starts, a little over a second at most.
  const timed = { lines: shown.map((line) => ({ text: line.map((t) => t.text).join(' '), words: [], heard: null })) };
  flat.forEach((place, index) => {
    const start = starts[index];
    const next = index + 1 < starts.length ? starts[index + 1] : length;
    const end = Math.min(next, start + (index + 1 < flat.length && flat[index + 1].line === place.line ? 1.2 : 0.9));
    timed.lines[place.line].words.push({ text: shown[place.line][place.token].text, start, end: Math.max(end, start + 0.05) });
  });
  // A line is heard with two of its words heard, or one of a short line's; one all in brackets (never matched)
  // goes with the line before it. One stray word heard ("I", "the") doesn't make a guessed line heard.
  shown.forEach((line, l) => {
    const words = line.map((_, k) => k).filter((k) => line[k].parts.length !== 0);
    const matched = words.filter((k) => known[l][k] !== null).length;
    timed.lines[l].heard = words.length === 0 ? (l > 0 ? timed.lines[l - 1].heard : true)
      : matched >= 2 || (words.length <= 3 && matched >= 1);
  });
  return timed;
}

module.exports = { align, wordsFromWhisper, voicesFromOutput, gaps, nextGap, merge, rehear, REHEAR_ROUNDS };
