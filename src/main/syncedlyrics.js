// Words timed on this computer from the song itself (lyricsync.js), kept by song: once timed, a song's words are sung
// on time from then on — word by word, each at its own moment. What was heard is kept beside them, so another version
// of the words is timed again at once, without listening again. A port of SyncedLyrics in iJWA's GeniusLyrics.swift.
'use strict';

const fs = require('fs');
const path = require('path');
const names = require('./names');

/** How it was heard: 4 since gaps Whisper skipped are heard again, 28 s at a time, from a later voice if need be; an earlier hearing
 *  may miss a whole intro, and is heard again. */
const HEARING = 4;

const folder = () => path.join(require('electron').app.getPath('userData'), 'Timed Lyrics');
const name = (track) => `${names.simple(track.title || '')}-${names.simple(track.artist || '')}`.slice(0, 120).replace(/[\\/:*?"<>|]/g, ' ');
const file = (track) => path.join(folder(), `${name(track)}.json`);
const heardFile = (track) => path.join(folder(), `${name(track)}.heard.json`);

/** The song's timed words as the players take them ({ lines, isSynced, isWordTimed }), or null. A line Whisper didn't
 *  hear (`heard` false: only placed where it would fit) isn't shown — the note stands there instead, as through music
 *  (his call, 2026-10-12: "söz bulamadığı yerlerde müzik çıksa, yanlış olan lyricsler göze batmaz"). */
function lyrics(track) {
  let timed;
  try { timed = JSON.parse(fs.readFileSync(file(track), 'utf8')); } catch { return null; }
  const lines = (timed.lines || []).filter((line) => line.words?.length && line.heard !== false).map((line) => {
    const { words, adlibs } = require('./lyrics').separate(line.words.map((w) => ({ text: w.text, start: w.start, end: w.end })));
    return { time: line.words[0].start, text: line.text, words, adlibs };
  });
  return lines.length ? { lines, isSynced: true, isWordTimed: true } : null;
}

function save(timed, heard, voiced, length, track) {
  try {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(file(track), JSON.stringify(timed));
    fs.writeFileSync(heardFile(track), JSON.stringify({ length, words: heard, voiced, hearing: HEARING }));
  } catch (error) { console.log('[synced lyrics] not kept:', error.message); }
}

/** The words timed for an earlier choice: gone, as they belong to that choice. What was heard stays. */
function forget(track) {
  try { fs.rmSync(file(track), { force: true }); } catch { /* not there */ }
}

/** What was heard of the song when it was last timed, where a voice was, and its length; null for none, or for a
 *  hearing made the old way. */
function heard(track) {
  let kept;
  try { kept = JSON.parse(fs.readFileSync(heardFile(track), 'utf8')); } catch { return null; }
  if (!Array.isArray(kept.voiced) || kept.hearing !== HEARING) return null;
  return { words: kept.words || [], voiced: kept.voiced, length: kept.length || 0 };
}

module.exports = { lyrics, save, forget, heard, HEARING };
