// An artist's page (ArtistWindow.swift): opened from search, over the player. The photo, the name, a line about the
// artist and Play and Shuffle on the left; their top songs on the right, then their albums and artists like them.
// Everything plays in Spotify. Nothing on it jumps: every part has its room before its content arrives, placeholders
// have the shape of what replaces them, and what arrives fades and rises into place.
import { paletteFromPixels, hsbToRgb } from '../light/engine.js';
import { glide } from '../shared/glide.js';
import { PlayingGlass } from '../shared/playing-glass.js';

const api = window.ibaila;
const $ = (selector) => document.querySelector(selector);
const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (body, fill = 'currentColor') => `<svg viewBox="0 0 24 24" fill="${fill}">${body}</svg>`;
const PLAY = svg('<path d="M8 5.2c0-.9 1-1.4 1.7-.9l9.4 6c.7.4.7 1.4 0 1.9l-9.4 6c-.7.4-1.7-.1-1.7-.9z"/>');
const SHUFFLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3.2c2 0 3.3 1 4.4 2.8l2.8 4.4c1.1 1.8 2.4 2.8 4.4 2.8H21"/><path d="M3 17h3.2c1.5 0 2.6-.6 3.5-1.6M14.3 8.6c.9-1 2-1.6 3.5-1.6H21"/><path d="M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/></svg>`;
const WAVE = svg('<rect x="3" y="9" width="2.6" height="6" rx="1.3"/><rect x="8" y="5" width="2.6" height="14" rx="1.3"/><rect x="13" y="3" width="2.6" height="18" rx="1.3"/><rect x="18" y="7" width="2.6" height="10" rx="1.3"/>');
const CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
const time = (seconds) => (seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '');
const plain = (t) => String(t || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

let item = null;     // the artist as search knew it: { id, title, art }
let artist = null;   // the page, once read
let now = null;      // the song playing: { title, artist }
let pending = null;  // what was asked to play, until it starts: { key, until }
let turn = 0;

$('.glyph.play').innerHTML = PLAY;
$('.glyph.shuffle').innerHTML = SHUFFLE;
$('#close').innerHTML = CLOSE;

// ---- the artist ----

async function show(next) {
  const mine = ++turn;
  const changing = item && item.id !== next.id;
  if (changing) { $('#content').classList.add('changing'); await new Promise((r) => setTimeout(r, 220)); if (mine !== turn) return; }
  item = next;
  artist = null;
  $('#name').textContent = item.title;
  $('#bio').textContent = 'Artist';
  $('#buttons').classList.add('waiting');
  photo(item.art);
  drawMusic();
  $('#list').scrollTop = 0;
  $('#content').classList.remove('changing');
  const page = await api.invoke('artist-page', item.id);
  if (mine !== turn) return;
  artist = page || { failed: true };
  if (page) {
    if (page.art && page.art !== item.art) photo(page.art);
    $('#bio').replaceChildren(styled(page.bio || '') || document.createTextNode('Artist'));
    $('#buttons').classList.toggle('waiting', !page.topSongs.length);
  }
  drawMusic();
}

/** The photo, fading in; its colors light the glass from either side. */
function photo(url) {
  const img = $('#photo img');
  img.classList.remove('shown');
  if (!url) { $('#wash').classList.remove('lit'); return; }
  img.onload = () => {
    img.classList.add('shown');
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    try { g.drawImage(img, 0, 0, 32, 32); } catch { return; }
    const colors = paletteFromPixels(g.getImageData(0, 0, 32, 32).data);
    const wash = $('#wash');
    if (!colors) { wash.classList.remove('lit'); $('#photo').style.setProperty('--glow', 'rgba(0, 0, 0, 0.4)'); return; }
    const [a, b] = [colors.primary, colors.secondary].map((x) => hsbToRgb(x).map((v) => Math.round(v * 255)).join(', '));
    wash.style.background = `radial-gradient(${520 * s()}px circle at 0% 0%, rgba(${a}, 0.4), rgba(${a}, 0) 100%), radial-gradient(${460 * s()}px circle at 100% 100%, rgba(${b}, 0.22), rgba(${b}, 0) 100%)`;
    wash.classList.add('lit');
    $('#photo').style.setProperty('--glow', `rgba(${a}, 0.5)`);
  };
  img.src = url;
}

/** Apple writes its artist notes in a little HTML: italic titles, bold names, breaks. They keep their italics and bold;
 *  any other tag just goes. */
function styled(html) {
  if (!html.trim()) return null;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (node, into) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { into.appendChild(document.createTextNode(child.textContent)); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'br' || tag === 'p') { into.appendChild(document.createTextNode(' ')); walk(child, into); continue; }
      const kept = { i: 'i', em: 'i', b: 'b', strong: 'b' }[tag];
      if (kept) { const el = document.createElement(kept); walk(child, el); into.appendChild(el); } else walk(child, into);
    }
  };
  walk(doc.body.firstChild, out);
  return out;
}

const s = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;

// ---- the music ----

function drawMusic() {
  const rows = $('#rows');
  if (!artist) {
    const widths = [170, 130, 190, 150, 120, 175, 140];
    rows.innerHTML = widths.map((w, i) => `<div class="ghost" style="animation-delay:${i * 0.08}s"><i class="c"></i><div style="display:flex;flex-direction:column;gap:calc(7px * var(--s))">
      <i style="width:calc(${w}px * var(--s));height:calc(10px * var(--s))"></i><i style="width:calc(${widths[(i + 3) % 7] * 0.6}px * var(--s));height:calc(8px * var(--s))"></i></div></div>`).join('');
    return;
  }
  if (artist.failed) { rows.innerHTML = '<div class="note">This artist’s page can’t be opened right now</div>'; return; }
  let order = 0;
  const arrive = () => `class="arrive" style="animation-delay:${Math.min(order++, 16) * 0.035}s"`;
  let html = artist.topSongs.map((song, i) => `<div ${arrive()}><button class="song" data-song="${i}">
      <span class="cover">${song.art ? `<img src="${escape(song.art)}" draggable="false">` : ''}<span class="over">${PLAY}</span></span>
      <span class="words"><b><span class="t">${escape(song.title)}</span>${song.isExplicit ? '<span class="explicit">E</span>' : ''}</b>${song.album ? `<span>${escape(song.album)}</span>` : ''}</span>
      <span class="time">${time(song.duration)}</span></button></div>`).join('');
  if (artist.albums.length) {
    html += `<div class="section arrive" style="animation-delay:${Math.min(order++, 16) * 0.035}s">Albums</div><div class="albums">${artist.albums.slice(0, 12).map((album, i) => `<button class="album arrive" style="animation-delay:${Math.min(order++, 20) * 0.035}s" data-album="${i}">
      <span class="art">${album.art ? `<img src="${escape(album.art)}" draggable="false">` : ''}<span class="disc">${PLAY}</span></span>
      <b>${escape(album.title)}</b><span>${escape(album.album)}</span></button>`).join('')}</div>`;
  }
  if (artist.similar.length) {
    html += `<div class="section">Similar Artists</div><div class="similar">${artist.similar.slice(0, 5).map((other, i) => `<button class="bubble" data-similar="${i}">
      <span class="art">${other.art ? `<img src="${escape(other.art)}" draggable="false">` : ''}</span><b>${escape(other.title)}</b></button>`).join('')}</div>`;
  }
  rows.innerHTML = html;
  markPlaying();
}

/** Each top song's glass, made the first time it plays (PlayingGlass); the colors of each song's cover, once read. */
const songGlass = new WeakMap();
const coverColors = new Map();

/** The song's own colors, for its glass's glow (ArtistWindow's glow): read off its cover, white until then. */
function colorsOf(url) {
  if (!url) return null;
  if (coverColors.has(url)) return coverColors.get(url);
  coverColors.set(url, null);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = 32; c.height = 32;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 32, 32);
      const found = paletteFromPixels(g.getImageData(0, 0, 32, 32).data);
      coverColors.set(url, found ? [found.primary, found.secondary].map((x) => hsbToRgb(x).map((v) => v * 255)) : null);
      markPlaying();
    } catch { /* a cover that can't be read: white */ }
  };
  img.src = url;
  return null;
}

/** The song playing stands out of the list as a lens of glass; the others step back a little. */
function markPlaying() {
  if (!artist?.topSongs) return;
  const rows = $('#rows');
  // The very song: its whole title (a "Slowed" or a remix of it is another song), else the first by its plain title.
  const whole = (t) => String(t || '').toLowerCase().trim();
  let index = now ? artist.topSongs.findIndex((song) => whole(song.title) === whole(now.title)) : -1;
  if (index < 0 && now) index = artist.topSongs.findIndex((song) => plain(song.title) === plain(now.title));
  let any = false;
  rows.querySelectorAll('[data-song]').forEach((row) => {
    const on = Number(row.dataset.song) === index;
    any ||= on;
    row.classList.toggle('playing', on);
    if (on || songGlass.has(row)) {
      const song = artist.topSongs[Number(row.dataset.song)];
      const glass = songGlass.get(row) || new PlayingGlass(row);
      songGlass.set(row, glass);
      glass.update({ playing: on, running: Boolean(now?.playing), colors: colorsOf(song.art), s: s(),
        face: { title: song.title, line: song.album || '', time: song.duration > 0 ? time(song.duration) : null, explicit: Boolean(song.isExplicit), cover: song.art || null } });
    }
    const over = row.querySelector('.over');
    const pendingHere = pending?.key === `song:${row.dataset.song}`;
    over.innerHTML = pendingHere && !on ? '<span class="spinner"></span>' : on ? WAVE : PLAY;
    row.classList.toggle('pending', pendingHere);
  });
  rows.classList.toggle('has-playing', any);
  rows.querySelectorAll('[data-album]').forEach((tile) => {
    const pendingHere = pending?.key === `album:${tile.dataset.album}`;
    tile.classList.toggle('pending', pendingHere);
    tile.querySelector('.disc').innerHTML = pendingHere ? '<span class="spinner"></span>' : PLAY;
  });
}

async function play(key, request) {
  pending = { key, until: Date.now() + 9000 };
  markPlaying();
  const started = await api.invoke('artist-play', request);
  if (!started && pending?.key === key) { pending = null; markPlaying(); }
  setTimeout(() => { if (pending?.key === key && Date.now() >= pending.until) { pending = null; markPlaying(); } }, 9100);
}

document.addEventListener('click', (event) => {
  const row = event.target.closest('[data-song]');
  if (row) { const song = artist.topSongs[Number(row.dataset.song)]; play(`song:${row.dataset.song}`, { kind: 'track', title: song.title, artist: artist.name, art: song.art, link: song.link }); return; }
  const tile = event.target.closest('[data-album]');
  if (tile) { const album = artist.albums[Number(tile.dataset.album)]; play(`album:${tile.dataset.album}`, { kind: 'album', title: album.title, artist: artist.name, art: album.art, link: album.link }); return; }
  const bubble = event.target.closest('[data-similar]');
  if (bubble) { const other = artist.similar[Number(bubble.dataset.similar)]; show({ id: other.id, title: other.title, art: other.art }); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'play' || action === 'shuffle') play('artist', { kind: 'artist', title: item.title, shuffle: action === 'shuffle', art: item.art, shuffleLink: artist?.shuffle, topLink: artist?.topSongs?.[0]?.link });
  if (event.target.closest('#close')) api.send('artist-close');
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') api.send('artist-close'); });

glide($('#list'));
api.listen('artist-show', (next) => show(next));
api.listen('artist-scale', (value) => { document.documentElement.style.setProperty('--s', String(value)); markPlaying(); });
api.listen('artist-now', (next) => {
  const changed = next?.title !== now?.title;
  now = next;
  if (changed && pending) pending = null;
  markPlaying();
});
api.listen('artist-leaving', () => $('#page').classList.add('leaving'));
api.invoke('artist-hello').then((hello) => {
  document.documentElement.style.setProperty('--s', String(hello.s));
  now = hello.now;
  show(hello.item);
});
