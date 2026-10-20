// Words from Genius for songs no other source has — unreleased songs above all, which its community writes down
// (his ask, 2026-10-12: Juice WRLD's leaks, "paralı bir API olmamalı"). A port of GeniusLyrics in iJWA's
// GeniusLyrics.swift. Its search answers without a key, and the words are read from the song's own page. They come
// untimed: the players pace them over the song.
//
// A song may have several versions there ("Back In Chicago", "Back in Chicago (Session)"); the one found can be
// changed by hand from the lyrics (`picks`), and the choice is kept for that song.
'use strict';

const fs = require('fs');
const path = require('path');
const names = require('./names');

const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const log = (...words) => console.log('[genius]', ...words);

/** A song played in a browser page: its "artist" is whoever uploaded it. */
const fromPage = (track) => track.source === 'web' || Boolean(track.viaExtension);

// ---- finding ----

/** The words of the song playing, from the page chosen for it by hand, else the best of a search for it.
 *  { status: 'found' | 'none' | 'failed', lyrics? } */
async function find(track) {
  const picked = picks.url(track);
  if (picked) {
    const words = await lyrics(picked);
    return words ? { status: 'found', lyrics: words } : { status: 'failed' };
  }
  const hits = await candidates(track);
  if (!hits) return { status: 'failed' };
  const hit = best(hits, track);
  if (!hit) { log('not on Genius:', track.title); return { status: 'none' }; }
  log('words from Genius:', hit.title, 'by', hit.artist);
  const words = await lyrics(hit.url);
  return words ? { status: 'found', lyrics: words } : { status: 'failed' };
}

/** Genius's songs for the song playing, asked for by its artist and title, then by its title alone. A song from a
 *  browser is asked for by its title alone: there the "artist" is whoever uploaded it — unreleased songs' uploaders
 *  have names of their own ("Jacy"), nothing to do with the song (his call, 2026-10-12: "onları aratmaman lazım");
 *  the title holds the real artist. null when Genius couldn't be asked. */
async function candidates(track) {
  const asked = fromPage(track) ? [query(track, false)] : [query(track), query(track, false)];
  const hits = [];
  let reached = false;
  for (const question of asked) {
    if (!question) continue;
    const found = await search(question);
    if (!found) continue;
    reached = true;
    for (const hit of found) if (!hits.some((h) => h.url === hit.url)) hits.push(hit);
    if (best(hits, track)) break;
  }
  return reached ? hits : null;
}

const ADDED = new Set(['studio', 'session', 'sessions', 'unreleased', 'leak', 'leaked', 'official', 'audio', 'video',
  'lyrics', 'lyric', 'visualizer', 'hq', 'cdq', 'og', 'snippet', 'full', 'song', 'new']);

/** What Genius is asked for the song: its lead artist and its title bare — the artist taken out of it (a browser's
 *  song often holds it), and what a video's title adds ("Studio Session", "Official Audio") left out, which only lost
 *  Genius the song (2026-10-12, "Back in Chicago Studio Session": nothing). */
function query(track, withArtist = true) {
  const lead = names.lead(track.artist || '');
  let title = names.bare(track.title || '');
  for (const name of [track.artist || '', lead]) {
    if (!name) continue;
    title = title.split(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ');
  }
  const kept = words(title).filter((word) => !ADDED.has(word));
  return [...(withArtist ? [lead] : []), ...kept].join(' ');
}

/** Songs Genius finds for `text`, best first; null when it couldn't be asked. `songs`: its song search, ten of them,
 *  rather than everything's top few. */
async function search(text, songs = true) {
  const address = `https://genius.com/api/search/${songs ? 'song' : 'multi'}?${new URLSearchParams({ q: text, per_page: '10' })}`;
  const data = await get(address);
  if (!data) return null;
  let json;
  try { json = JSON.parse(data); } catch { return null; }
  const sections = json?.response?.sections;
  if (!Array.isArray(sections)) return null;
  const hits = [];
  for (const section of sections) {
    if (!['top_hit', 'song'].includes(section.type)) continue;
    for (const hit of section.hits || []) {
      const result = hit.result;
      if (hit.type !== 'song' || !result?.title || !result.url || hits.some((h) => h.url === result.url)) continue;
      const artist = result.artist_names || result.primary_artist?.name || '';
      // Genius's own translations of a song come up beside it, under accounts named for Genius.
      if (/genius/i.test(artist)) continue;
      hits.push({ title: result.title, artist, url: result.url });
    }
  }
  return hits;
}

/** The hit that is the song playing: every word of its title — before any brackets — in the song's title (and artist,
 *  which a browser's song often holds in its title), its lead artist named there too. Words in its brackets count for
 *  it when the song names them too, and against it when not: "Back in Chicago Studio Session" finds "Back in Chicago
 *  (Session)", "Hate Me" finds "Hate Me" rather than "Hate Me (Demo)". */
function best(hits, track) {
  // A browser's "artist" is its uploader: the song is matched by its title alone.
  const heard = new Set(words(fromPage(track) ? track.title : `${track.title} ${track.artist}`));
  let found = null;
  for (const hit of hits) {
    const core = words(names.bare(hit.title)).filter((word) => !['lyrics', 'the', 'a'].includes(word));
    if (!core.length || !core.every((word) => heard.has(word))) continue;
    const lead = words(names.lead(hit.artist));
    if (!lead.length || !lead.every((word) => heard.has(word))) continue;
    const coreSet = new Set(core);
    const extra = [...new Set(words(hit.title))].filter((word) => !coreSet.has(word));
    const score = core.length + extra.filter((word) => heard.has(word)).length - extra.filter((word) => !heard.has(word)).length;
    if (!found || score > found.score) found = { hit, score };
  }
  return found?.hit || null;
}

function words(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// ---- reading a page ----

/** The words on a song's page: its lyrics' blocks, line by line, the parts named in brackets left out. Untimed
 *  lyrics ({ lines, isSynced: false }), or null. */
async function lyrics(url) {
  const page = await get(url);
  if (!page) return null;
  const lines = text(page).split(/\r?\n|\r/).map((line) => line.trim())
    .filter((line) => line && !(line.startsWith('[') && line.endsWith(']')));
  if (!lines.length) return null;
  return { lines: lines.map((line) => ({ time: null, text: line })), isSynced: false };
}

/** The text of every `data-lyrics-container` block of a page, a line break for each `<br>`, what's marked to be left
 *  out of a selection (the "N Contributors … Lyrics" heading) left out. */
function text(page) {
  let out = '';
  let depth = 0;      // divs open inside the block being read; 0 outside any
  let skipping = 0;   // the depth a left-out element opened at, 0 when none
  let index = 0;
  for (;;) {
    const open = page.indexOf('<', index);
    if (open < 0) break;
    if (depth > 0 && skipping === 0) out += decode(page.slice(index, open));
    const close = page.indexOf('>', open);
    if (close < 0) break;
    const tag = page.slice(open + 1, close);
    index = close + 1;
    const closing = tag.startsWith('/');
    const name = (/^\/*([\p{L}\p{N}]*)/u.exec(tag)?.[1] || '').toLowerCase();
    if (depth === 0) {
      if (name === 'div' && !closing && tag.includes('data-lyrics-container="true"')) depth = 1;
      continue;
    }
    if (name === 'br') { if (skipping === 0) out += '\n'; continue; }
    if (name !== 'div' && !tag.includes('data-exclude-from-selection')) continue;
    if (closing) {
      if (name === 'div') {
        if (skipping === depth) skipping = 0;
        depth -= 1;
        if (depth === 0) out += '\n';
      }
    } else if (name === 'div') {
      depth += 1;
      if (skipping === 0 && tag.includes('data-exclude-from-selection="true"')) skipping = depth;
    }
  }
  return out;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(part) {
  if (!part.includes('&')) return part;
  return part.replace(/&([^&;]{0,8});/g, (whole, name) => {
    if (NAMED[name]) return NAMED[name];
    if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (/^#[0-9]+$/.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return whole;
  });
}

async function get(url) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(12000) });
    return response.status === 200 ? await response.text() : null;
  } catch { return null; }
}

// ---- picked by hand ----

/** The Genius page chosen by hand for a song, kept by its title and artist. */
const picks = {
  chosen: null,
  file() { return path.join(require('electron').app.getPath('userData'), 'lyrics-picks.json'); },
  load() {
    if (!this.chosen) { try { this.chosen = JSON.parse(fs.readFileSync(this.file(), 'utf8')); } catch { this.chosen = {}; } }
    return this.chosen;
  },
  key(track) { return `${names.simple(track.title || '')}|${names.simple(track.artist || '')}`; },
  url(track) { return this.load()[this.key(track)] || null; },
  choose(url, track) {
    this.load()[this.key(track)] = url;
    try { fs.writeFileSync(this.file(), JSON.stringify(this.chosen)); } catch (error) { log('pick not kept:', error.message); }
  },
};

module.exports = { find, candidates, query, search, best, lyrics, text, picks, fromPage };
