// The desktop player (DesktopPlayer.swift): the playing artist's albums as a ring of glass cards curving away to
// both sides of the album playing — Cover Flow, older to the left, newer to the right — with a glass control bar
// beneath. Clicking an album turns the ring to it and plays it; scrolling turns the ring and, after a quiet
// moment, it turns back to the album playing; hovering lifts a card.
import { Deck, Ring, CardStack, placements, albumLayout, lyricsLayout } from './ring.js';
import { Aura, MARGIN } from './aura.js';
import { Bar, MiniBar } from './bar.js';
import { WordBlock } from './wordblock.js';
import { SCENES } from './lyricstyles.js';
import { lyricFontFor } from './lyriclooks.js';
import { icons } from './icons.js';
import { logos } from './logos.js';
import { Search } from './search.js';
import { Lists } from './lists.js';
import { DEFAULT_STYLE, paletteFromPixels, hsbToRgb } from '../light/engine.js';
import { PlayingGlass } from '../shared/playing-glass.js';

const api = window.ibaila;
const $ = (selector) => document.querySelector(selector);

// ---- measurements ----

function metricsFor(desktop, fit = 1) {
  const s = (0.8 + 0.45 * desktop.size) * fit;
  const m = { s, glass: desktop.glassBrightness, cardWidth: 232 * s, cardInset: 9 * s, captionHeight: 66 * s, cardRadius: 24 * s, coverRadius: 16 * s };
  m.coverSide = m.cardWidth - 2 * m.cardInset;
  m.cardHeight = m.cardInset + m.coverSide + m.captionHeight;
  m.carouselHeight = m.cardHeight + 44 * s;
  m.barWidth = 690 * s;
  m.width = 900 * s;
  m.edge = 40 * s;
  m.toolsTop = m.edge + m.carouselHeight + 10 * s;
  m.barTop = m.toolsTop + 42 * s + 8 * s;
  return m;
}

function applyMetrics(m) {
  const root = document.documentElement.style;
  const px = (v) => `${v}px`;
  root.setProperty('--s', String(m.s));
  root.setProperty('--glass', String(m.glass));
  for (const [name, value] of Object.entries({ 'card-width': m.cardWidth, 'card-height': m.cardHeight, 'card-inset': m.cardInset, 'cover-side': m.coverSide,
    'caption-height': m.captionHeight, 'card-radius': m.cardRadius, 'cover-radius': m.coverRadius, 'carousel-height': m.carouselHeight,
    'bar-width': m.barWidth, 'tools-top': m.toolsTop, 'bar-top': m.barTop })) root.setProperty(`--${name}`, px(value));
  const album = albumLayout(m);
  root.setProperty('--album-width', px(album.panel.width));
  root.setProperty('--album-height', px(album.panel.height));
  root.setProperty('--album-x', px(album.panelX));
  const lyricsPlace = lyricsLayout(m);
  root.setProperty('--lyrics-x', px(lyricsPlace.wordsX));
  root.setProperty('--lyrics-width', px(lyricsPlace.width));
  root.setProperty('--card-x', px(lyricsPlace.cardX));
}

// ---- state ----

let now = { track: null, playing: false, clock: null, shuffle: false, repeat: 'off', artwork: null };
let shelf = { artist: '', albums: [], playingIndex: null };
let style = { ...DEFAULT_STYLE };
let m = metricsFor({ size: 0.45, glassBrightness: 0.6 });
let meter = { decibels: -120, punch: 0 };
let albumColors = null;     // the artwork's two colors, once read
let colorsFor = null;       // which artwork they belong to

let hoveredKey = null;
let browseKey = null;       // the album turned to by scrolling or clicking; null follows the song playing
let scrollDebt = 0;
let returnHome = 0;
let refusedKey = null;
let refusals = 0;
let pendingPlay = null;
// An album opened from its card: its card stands at the left, its songs listed at its right (AlbumSongs.swift).
let openAlbum = null;       // the card
let openSongs = [];
let isOpening = false;
let pendingSong = null;     // the row picked, on its way
let wall = { isOn: false, state: 'off', fraction: 0 };   // the live wallpaper, for its switch

// ---- search ----

const search = new Search({ api, host: $('#search-grid'), bar: $('#searchbar'), nowTrack: () => now.track, onChange: () => {
  $('#search-grid').classList.toggle('hidden', !search.showsGrid);
  $('#tools').classList.toggle('searching', search.isOpen);
  render();
} });
$('#searchbar').addEventListener('click', () => {
  // Search opened: the lists make way for it.
  if (lists.isOpen) api.send('lists-close');
  if (!search.isOpen) search.open();
});
// The user's lists, opened from the playlist beside the player, take the cards' place as search's results do; search
// makes way for them.
const lists = new Lists({ api, host: $('#lists'), onChange: () => {
  if (lists.isOpen && (search.isOpen || search.hasQuery)) search.close();
  // The lyrics make way for the lists too.
  if (lists.isOpen) bar.closePanels();
  render();
} });

let showsLyrics = false;
let history = [];          // the songs seen, as the ring keeps them
const ring = new Ring();
const cards = new CardStack($('#stage'));
const aura = new Aura($('#aura'), { meter: () => meter, style: () => style });

// ---- the bar ----

const bar = new Bar($('#bar'), {
  control: (action, value) => {
    if (action === 'open' || action === 'more' || action === 'read-modes' || action === 'volume') { api.send('desk-control', action, value); return; }
    api.send('desk-control', action, value);
  },
  readVolume: () => api.invoke('desk-volume'),
  choose: (choice) => api.send('desk-choose', choice),
  panels: (lyricsOn) => {
    const changed = lyricsOn !== showsLyrics;
    showsLyrics = lyricsOn;
    // Search's results, and the lists' shelf, make way for the lyrics.
    if (lyricsOn && (search.isOpen || search.hasQuery)) search.close();
    if (lyricsOn && lists.isOpen) api.send('lists-close');
    render(); if (changed) lyricsChanged();
  },
});

const mini = new MiniBar($('#mini'), {
  control: (action) => api.send('desk-control', action),
  expand: () => api.send('desk-control', 'mini', false),
});

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- a song on its way (StartingPanel.swift) ----
// Picked anywhere — search, a card, the list, the playlist beside, an artist's page — it waits in a panel of its own
// in the middle, the cards gone from round it: its cover large with a light running round its edge, its name, and
// where it is starting, three small bars dancing beside. Couldn't start, it says so, shakes its head, and goes.

let starting = null;
function showStarting(next) {
  const box = $('#starting');
  const was = starting;
  starting = next;
  document.body.classList.toggle('waiting', Boolean(next));
  if (!next) {
    if (was) { box.classList.add('leaving'); setTimeout(() => { if (!starting) { box.classList.add('hidden'); box.classList.remove('leaving'); } }, 450); }
    render();
    return;
  }
  box.classList.remove('leaving');
  const side = Math.min(m.cardHeight * 0.6, m.cardWidth * 0.95);
  box.style.setProperty('--start-side', `${side}px`);
  if (!was || was.id !== next.id) {
    const cover = box.querySelector('.start-cover');
    cover.querySelectorAll('img, .none').forEach((el) => el.remove());
    cover.insertAdjacentHTML('afterbegin', next.picture ? `<img src="${escape(next.picture)}" draggable="false">` : '<span class="none"></span>');
    box.querySelector('.start-title').textContent = next.title || '';
    box.querySelector('.start-artist').textContent = next.artist || '';
  }
  box.classList.toggle('failed', Boolean(next.failed));
  const pill = box.querySelector('.start-pill');
  pill.querySelector('.pill-logo').innerHTML = next.failed ? '' : next.mark?.kind && logos[next.mark.kind] ? logos[next.mark.kind] : '';
  pill.querySelector('.pill-text').textContent = next.failed ? (next.album ? 'Couldn\u2019t start this album' : 'Couldn\u2019t start this song')
    : next.mark ? `Starting on ${next.mark.name}` : 'Starting';
  pill.querySelector('.start-bars').style.display = next.failed ? 'none' : '';
  if (next.failed && !was?.failed) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
  requestAnimationFrame(() => box.classList.remove('hidden'));
  render();
}
api.listen('desk-starting', showStarting);
api.invoke('desk-starting').then((s) => { if (s) showStarting(s); });

// ---- the extension asked for (ExtensionCard.swift) ----
// Music in a browser and iBaila's extension not there yet: the middle asks for it, the cards gone from round it. No
// "not now": without it a browser's music can only be watched (his call, 2026-10-10). Pressed, it waits for the
// browser; when the extension comes, it says so a moment and goes.

let extension = null;   // { asks, adding, arrived, site, browser, page } (extensionsetup.js)
function showExtension(next) {
  extension = next;
  render();
}
function drawExtension(shown) {
  const box = $('#ext-card');
  document.body.classList.toggle('asking', shown);
  box.classList.toggle('hidden', !shown);
  if (!shown) return;
  const { adding, arrived, site, browser, page } = extension;
  const where = browser || 'your browser';
  box.classList.toggle('adding', Boolean(adding) && !arrived);
  box.classList.toggle('arrived', Boolean(arrived));
  box.querySelector('.ext-icon').innerHTML = arrived ? icons.tick : icons.puzzle;
  box.querySelector('.ext-title').textContent = arrived ? 'You\u2019re all set' : 'Add iBaila to your browser';
  box.querySelector('.ext-words').textContent = arrived ? `iBaila is in ${where} now. Pick a song and it plays right there.`
    : adding ? `Paste ${page} in ${where}\u2019s address bar (it\u2019s copied), turn on Developer mode, then drag the \u201cBrowser Extension\u201d folder onto that page.`
      : `${site || 'Your music'} plays in your browser, so iBaila needs to be there too: to play what you pick, open your playlists, like and repeat. It takes a minute.`;
  box.querySelector('.ext-add').textContent = browser ? `Add to ${browser}` : 'Add to your browser';
  box.querySelector('.ext-wait-text').textContent = `Waiting for ${where}`;
}
for (const button of document.querySelectorAll('#ext-card button')) button.addEventListener('click', () => api.send('desk-extension-add'));
api.listen('desk-extension', showExtension);
api.invoke('desk-extension').then((s) => { if (s) showExtension(s); });

// ---- the lyrics, beside the playing album's card ----

// The style picked draws them: the fisheye, or one of the styles on LyricScene; made anew when the style changes.
let words = new WordBlock($('#lyrics .stage'));
let wordsLook = 'fisheye';
function lyricsLook() { return SCENES[style.desktop?.lyricsLook] ? style.desktop.lyricsLook : 'fisheye'; }
function wordsFor(look) {
  if (look === wordsLook) return words;
  words.stop();
  words.destroy?.();
  wordsLook = look;
  words = look === 'fisheye' ? new WordBlock($('#lyrics .stage')) : new SCENES[look]($('#lyrics .stage'));
  return words;
}
let lyrics = null;          // { songID, status, lyrics, title, artist, duration } for the song playing
let findingFor = null;
let lyricsTries = { id: null, count: 0 };   // a lookup that couldn't reach the lyrics, asked again a few times

const searchButton = $('#search-lyrics'), otherButton = $('#other-lyrics');
let besideNow = null;   // the card the lyrics stand beside, as last drawn
/** Other words for the song, always at hand under its card beside them; folded away with the card (his call,
 *  2026-10-12: "other lyrics hep görünsün, albüm kapağının altında"). */
function drawOther() {
  const hasWords = showsLyrics && lyrics?.songID === now.track?.id && lyrics?.lyrics?.lines?.some((l) => l.text?.trim());
  otherButton.classList.toggle('gone', !(besideNow && hasWords));
}
searchButton.innerHTML = `${icons.search}<span>Search lyrics</span>`;
otherButton.innerHTML = `${icons.search}<span>Other lyrics</span>`;
searchButton.addEventListener('click', () => api.send('desk-search-lyrics'));
otherButton.addEventListener('click', () => api.send('desk-search-lyrics'));
// Words chosen by hand, or timed to the song: looked up again.
api.listen('desk-lyrics-again', () => { findingFor = null; lyrics = null; findLyrics(); });

/** Looks the playing song's words up once while the lyrics are open. */
async function findLyrics() {
  const id = now.track?.id;
  if (!showsLyrics || !id || findingFor === id) return;
  findingFor = id;
  lyrics = null;
  drawLyrics();
  const found = await api.invoke('desk-lyrics');
  if (findingFor !== id) return;
  if (!found || found.status === 'failed') {
    // The lyrics couldn't be reached (a library busy, the network down): not "no lyrics" — asked again a little later,
    // a few times, still "Finding lyrics" meanwhile; then it says so. Opening the lyrics again asks again.
    findingFor = null;
    if (lyricsTries.id !== id) lyricsTries = { id, count: 0 };
    if (lyricsTries.count < 3) {
      const wait = [3000, 8000, 20000][lyricsTries.count++];
      setTimeout(() => { if (now.track?.id === id && showsLyrics) findLyrics(); }, wait);
      return;
    }
  }
  lyrics = found || { songID: id, status: 'failed' };
  drawLyrics();
}

function drawLyrics() {
  drawOther();
  const box = $('#lyrics');
  const out = showsLyrics;
  box.classList.toggle('hidden', !out);
  const quiet = box.querySelector('.quiet');
  const has = out && lyrics?.songID === now.track?.id && lyrics?.lyrics?.lines?.some((l) => l.text?.trim());
  if (!has) {
    words.stop();
    const loading = out && (!lyrics || lyrics.songID !== now.track?.id);
    quiet.classList.toggle('gone', !out);
    quiet.classList.toggle('loading', loading);
    quiet.querySelector('.quiet-icon').innerHTML = loading ? icons.ellipsis : icons.lyrics;
    quiet.querySelector('.quiet-text').textContent = loading ? 'Finding lyrics'
      : lyrics?.status === 'failed' ? 'Lyrics can\u2019t be reached right now' : 'No lyrics for this song';
    // Looked for by hand, with none found (his ask, 2026-10-12: "lyrics bulunamıyorsa altında manuel arama butonu olsun").
    searchButton.classList.toggle('gone', loading || !now.track);
    return;
  }
  quiet.classList.add('gone');
  searchButton.classList.add('gone');
  wordsFor(lyricsLook()).show({ id: lyrics.songID, lyrics: lyrics.lyrics, title: lyrics.title, artist: lyrics.artist, duration: lyrics.duration },
    { clock: now.clock, isSeen: !document.hidden, colors: albumColors, face: lyricFontFor(style.desktop, lyricsLook()), scale: m.s });
}

/** The lyrics open in the cards' own room: the window never grows for them and the bar never moves (his call,
 *  2026-10-10). The playing album's card turns at the left, as an album opened does, and the words are sung at its
 *  right (render). */
function lyricsChanged() {
  if (showsLyrics) {
    browseKey = null;
    hoveredKey = null;
    cards.lean(null, null);
    findLyrics();
  }
  drawLyrics();
}

// ---- the tools over the bar ----

$('[data-tool="settings"]').innerHTML = icons.gear;
drawWallToggle();
$('[data-tool="mini"]').innerHTML = icons.mini;
$('[data-tool="lyricsCard"]').innerHTML = icons.eye;
$('#refusal').innerHTML = `${icons.list}<span>Can't play this album</span>`;
document.querySelector('#tools').addEventListener('click', (event) => {
  const tool = event.target.closest('[data-tool]')?.dataset.tool;
  if (tool === 'mini') api.send('desk-control', 'mini', true);
  if (tool === 'lyricsCard') api.send('desk-control', 'lyricsCard', !style.desktop?.hidesLyricsCard);
  if (tool === 'settings') api.send('desk-control', 'settings');
  if (tool === 'wallpaper' && !$('[data-tool="wallpaper"]').classList.contains('none')) {
    wall = { ...wall, isOn: !wall.isOn };
    drawWallToggle();
    api.setStyle({ wallpaper: { isOn: wall.isOn } });
  }
});

// ---- the live wallpaper's switch (WallpaperToggle.swift) ----
// Lit while the desktop plays the songs' videos, struck through while it keeps the Windows wallpaper, and dark, out of
// use, while the song playing has no video. While a video is on its way a ring runs round it — spinning while one is
// looked for, filling as it downloads — so switching on never seems to do nothing.
function drawWallToggle() {
  const button = $('[data-tool="wallpaper"]');
  const noVideo = wall.isOn && (wall.state === 'missing' || wall.state === 'idle');
  const loading = wall.isOn ? (wall.state === 'finding' ? -1 : wall.state === 'fetching' ? wall.fraction : null) : null;
  const key = `${wall.isOn}|${noVideo}|${loading == null ? '' : loading < 0 ? 'spin' : Math.round(loading * 50)}`;
  if (button.dataset.key === key) return;
  button.dataset.key = key;
  button.classList.toggle('off', !wall.isOn);
  button.classList.toggle('none', noVideo);
  button.title = noVideo ? 'No video for this song' : wall.isOn ? 'Live Wallpaper is on' : 'Live Wallpaper is off';
  const C = 2 * Math.PI * 18;
  const ring = loading == null ? '' : loading < 0
    ? '<svg class="ring spin" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" class="track"/><circle cx="20" cy="20" r="18" class="arc" stroke-dasharray="' + (C * 0.22).toFixed(1) + ' ' + C.toFixed(1) + '"/></svg>'
    : '<svg class="ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" class="track"/><circle cx="20" cy="20" r="18" class="arc" stroke-dasharray="' + (C * Math.max(loading, 0.04)).toFixed(1) + ' ' + C.toFixed(1) + '"/></svg>';
  button.innerHTML = (wall.isOn ? icons.livePhoto : icons.livePhotoOff) + ring;
}
api.listen('wall-status', (status) => { wall = status; drawWallToggle(); });
api.invoke('wall-status').then((status) => { if (status) { wall = status; drawWallToggle(); } });

let noticeTimer = 0;
/** A word over the bar for a while (Notice.swift): with a ring filling as something downloads (`progress` 0…1), or
 *  turning while something runs (`busy`). An `update` of the one showing changes it in place, not coming in again. */
function notice(title, detail, { progress = null, busy = false, symbol = 'note', seconds = 3.4, update = false } = {}) {
  const slot = $('#notice-slot');
  const C = 2 * Math.PI * 12;
  const ring = progress != null
    ? `<svg class="ring" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" class="track"/><circle cx="14" cy="14" r="12" class="arc" stroke-dasharray="${(C * Math.max(progress, 0.02)).toFixed(1)} ${C.toFixed(1)}"/></svg>`
    : busy ? '<span class="spinner"></span>' : '';
  const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const shown = slot.querySelector('.notice:not(.leaving)');
  if (update && shown) {
    shown.querySelector('.text b').textContent = title;
    shown.querySelector('.text span').textContent = detail;
    const arc = shown.querySelector('.ring .arc');
    if (arc && progress != null) arc.setAttribute('stroke-dasharray', `${(C * Math.max(progress, 0.02)).toFixed(1)} ${C.toFixed(1)}`);
  } else {
    slot.innerHTML = `<div class="notice"><div class="note">${icons[symbol] || icons.note}${ring}</div><div class="text"><b>${escape(title)}</b><span>${escape(detail)}</span></div></div>`;
  }
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { slot.firstChild?.classList.add('leaving'); setTimeout(() => { if (slot.querySelector('.leaving')) slot.innerHTML = ''; }, 350); }, seconds * 1000);
}
api.listen('desk-notice', (n) => notice(n.title, n.detail, n));

// ---- colors ----

/** The light's two colors: the artwork's, or the user's own (LightStyle.lightColors). */
function lightColors() {
  const album = style.useArtworkColors ? albumColors : null;
  const first = album?.primary ?? style.primary;
  const second = style.twoColors ? (album?.secondary ?? style.secondary) : first;
  return [first, second];
}

/** The heart's color: the song's own, made bright enough to read on the glass (DesktopPlayer's likeTint); white
 *  while it isn't known. */
function likeTint() {
  const c = albumColors?.primary;
  if (!c) return '#fff';
  const rgb = hsbToRgb({ hue: c.hue, saturation: Math.min(c.saturation, 0.85), brightness: Math.max(c.brightness, 0.92) });
  return `rgb(${rgb.map((v) => Math.round(v * 255)).join(', ')})`;
}

function readColors(url) {
  if (url === colorsFor) return;
  colorsFor = url;
  if (!url) { albumColors = null; bar.tintLike(likeTint()); render(); return; }
  const image = new Image();
  image.onload = () => {
    if (colorsFor !== url) return;
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, 32, 32);
    albumColors = paletteFromPixels(g.getImageData(0, 0, 32, 32).data);
    bar.tintLike(likeTint());
    render();
    drawLyrics();
  };
  image.src = url;
}

// ---- the ring ----

function deckNow() {
  const albums = shelf.albums;
  const cardsList = albums.map((a) => ({ key: a.id, title: a.title, line: a.line, art: a.art, isLoose: a.isLoose, link: a.link || null }));
  const home = shelf.playingIndex;
  return { deck: new Deck(cardsList, home ?? (albums.length ? albums.length - 1 : null)), home };
}

/** An album's cover: the playing album's is the song's own artwork, there at once; the others', Apple's. */
function albumImage(card) {
  const home = shelf.playingIndex;
  if (home != null && shelf.albums[home]?.id === card.key && now.artwork) return now.artwork;
  return card.art;
}

/** The lyrics beside the playing album's card, or with the middle to themselves (the cards folded away or back): shown,
 *  the words never jump across — they drift out where they were and drift in where they go, after the cards (his call,
 *  2026-10-10: "çok katı sola geçiyor"; DesktopPlayer.lyricsStage). */
let lyricsShift = 0;
function placeLyrics(beside, shown) {
  const box = $('#lyrics');
  if (box.classList.contains('beside') === beside && !box.dataset.going) return;
  if (box.dataset.going === String(beside)) return;
  if (!shown || box.classList.contains('hidden')) { delete box.dataset.going; box.classList.toggle('beside', beside); return; }
  const turn = ++lyricsShift;
  box.dataset.going = String(beside);
  const s = m.s;
  box.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `${-30 * s}px 0` }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
    .finished.then(() => {
      if (turn !== lyricsShift) return;
      delete box.dataset.going;
      box.getAnimations().forEach((a) => a.cancel());
      box.classList.toggle('beside', beside);
      box.animate([{ opacity: 0, translate: `${(beside ? -46 : 40) * s}px 0`, scale: '0.96' }, { opacity: 1, translate: '0 0', scale: '1' }],
        { duration: 620, delay: beside ? 300 : 220, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)', fill: 'backwards' });
    }).catch(() => {});
}

function render() {
  const { deck, home } = deckNow();
  const lyricsOut = showsLyrics;
  const mini = Boolean(style.desktop?.mini);
  // The card the lyrics stand beside; with none — no album found, or the player small — they have the middle.
  // The card the lyrics stand beside; with none — no album found, or the player small — they have the middle. That card
  // folded away to the left by the eye beside the tools (shown only then): the words have the middle too (his call,
  // 2026-10-10: only that card, and the eye only while the lyrics show).
  const lyricsCard = lyricsOut && !mini && home != null ? deck.cards[home]?.key ?? null : null;
  const folded = Boolean(style.desktop?.hidesLyricsCard) && lyricsCard != null;
  const besideKey = folded ? null : lyricsCard;
  const eye = $('[data-tool="lyricsCard"]');
  eye.classList.toggle('gone', !lyricsCard);
  if (eye.dataset.hidden !== String(folded)) {
    eye.dataset.hidden = String(folded);
    eye.innerHTML = folded ? icons.eyeSlash : icons.eye;
    eye.title = folded ? 'Show the album' : 'Hide the album';
  }
  placeLyrics(Boolean(besideKey), lyricsOut);
  besideNow = besideKey;
  drawOther();
  $('#bar').classList.toggle('hidden', mini);
  $('#mini').classList.toggle('hidden', !mini);
  // The shelf hides while the player is small, and comes back as it grows again.
  $('#lists').classList.toggle('hidden', !lists.isOpen || mini);
  const cardsGone = mini || search.showsGrid || lists.isOpen || (lyricsOut && !besideKey);
  // A song on its way waits in the middle only while nothing else has it: search's results, the lists, the lyrics or
  // the small player put it out of sight until they go (DesktopPlayer.waiting). Left showing, it stood as an empty box
  // behind the search (a friend's PC, 2026-10-10).
  const middleTaken = mini || search.showsGrid || lists.isOpen || lyricsOut;
  $('#starting').classList.toggle('away', Boolean(starting) && middleTaken);
  document.body.classList.toggle('waiting', Boolean(starting) && !middleTaken);
  // The extension asked for, when nothing else has the middle.
  const asking = Boolean(extension?.asks) && !starting && !middleTaken;
  drawExtension(asking);
  // Search, the lyrics, the lists, the small player or the extension asked for take the middle: the album open goes
  // back to the cards.
  if (openAlbum && (cardsGone || lyricsOut || asking || document.body.classList.contains('waiting'))) closeAlbum(false);
  // Another artist's albums: the one open isn't on the shelf any more.
  if (openAlbum && !deck.cards.some((c) => c.key === openAlbum.key)) closeAlbum(false);
  // Cards stepped back, out of sight, take no clicks: what took their place does.
  $('#stage').style.pointerEvents = cardsGone ? 'none' : '';
  const focusIndex = browseKey ? deck.cards.findIndex((c) => c.key === browseKey) : -1;
  const focus = focusIndex >= 0 ? focusIndex : deck.anchor;
  $('#empty').classList.toggle('gone', focus != null || cardsGone || folded);
  $('#empty').style.display = focus != null ? 'none' : '';
  if (focus == null) { cards.show([], { turn: 0, m, hoveredKey: null, refusedKey, refusals, receded: cardsGone, image: albumImage, pendingKey: pendingPlay }); aura.update(lightColors(), false, card()); drawAlbum(); return; }
  const turn = ring.turnTo(focus, deck);
  const isHome = focus === home;
  const list = placements(deck, turn, hoveredKey, style.desktop?.sideCards ?? 2, style.desktop?.tilt ?? 0.5, m, Math.max(Math.abs(ring.lastStep) - 1, 0));
  cards.show(list, { turn, m, hoveredKey, refusedKey, refusals, receded: cardsGone, image: albumImage, pendingKey: pendingPlay,
    focusedKey: openAlbum?.key ?? lyricsCard, focus: !openAlbum && lyricsCard ? 'lyrics' : 'album',
    floating: Boolean(besideKey) && !document.hidden, folded });
  // The song playing comes alive in the middle. Not beside the lyrics: there the card only floats (his call, 2026-10-10).
  aura.update(lightColors(), Boolean(now.playing) && isHome && !cardsGone && !folded && !lyricsOut && !openAlbum && !document.hidden, card());
  const refusal = $('#refusal');
  const middle = deck.cards[deck.wrap(turn)];
  refusal.classList.toggle('shown', Boolean(refusedKey) && !cardsGone && !lyricsOut && !openAlbum && middle?.key === refusedKey);
  drawAlbum();
}

const card = () => ({ width: m.cardWidth, height: m.cardHeight, radius: m.cardRadius });

// ---- pointer ----

const carousel = $('#carousel');
carousel.addEventListener('pointermove', (event) => {
  // An album open, or the lyrics: the card stands still.
  if (openAlbum || showsLyrics) { if (hoveredKey) { hoveredKey = null; render(); } return; }
  const hit = cards.hit(event.clientX, event.clientY);
  if ((hit?.key ?? null) !== hoveredKey) { hoveredKey = hit?.key ?? null; render(); }
  cards.lean(hit?.key ?? null, hit?.spot ?? null);
});
carousel.addEventListener('pointerleave', () => { if (hoveredKey) { hoveredKey = null; render(); } cards.lean(null, null); });

/** A click on an album opens it: its card turns at the left and its songs are listed beside it (his call, 2026-10-10);
 *  play and pause are the bar's. A browser's song standing in for an album plays instead — or, playing, pauses or
 *  resumes. With an album open, a click on the cards goes back to them. */
async function clickCard(key) {
  if (openAlbum) { closeAlbum(true); return; }
  // The lyrics open: a click on the cards goes back to them.
  if (showsLyrics) { bar.closePanels(); return; }
  const { deck, home } = deckNow();
  const index = deck.cards.findIndex((c) => c.key === key);
  if (index < 0) return;
  clearTimeout(returnHome);
  hoveredKey = null;
  if (!deck.cards[index].link) { openAlbumCard(deck.cards[index]); return; }
  if (index === home) {
    const focusIndex = browseKey ? deck.cards.findIndex((c) => c.key === browseKey) : home;
    if (focusIndex === home) api.send('desk-control', 'toggle');
    else { browseKey = null; if (!now.playing) api.send('desk-control', 'toggle'); }
    render();
    return;
  }
  if (pendingPlay) return;
  browseKey = key;
  pendingPlay = key;
  render();
  const started = await api.invoke('desk-play-album', deck.cards[index]);
  pendingPlay = null;
  render();
  if (started) { goHome(8000); return; }
  refusedKey = key; refusals++;
  render();
  setTimeout(() => { if (refusedKey !== key) return; refusedKey = null; if (browseKey === key) browseKey = null; render(); }, 1800);
}

// ---- an album opened ----

/** The same song (CatalogPlayer.isSame): the same title, versions' additions cut off, and the same artist — one name
 *  starting the other, or the same first artist however the others are joined ("Lil Tecca ve NAV"). */
const leadArtist = (artist) => {
  let name = String(artist || '').toLowerCase();
  for (const mark of [',', ' & ', ' feat.', ' ft.', ' x ', ' with ', ' ve ', ' und ', ' et ', ' y ', ' e ']) { const at = name.indexOf(mark); if (at >= 0) name = name.slice(0, at); }
  return name.trim();
};
const plainSongTitle = (title) => {
  let text = String(title || '').toLowerCase();
  for (const mark of [' (', ' [', ' - ']) { const at = text.indexOf(mark); if (at >= 0) text = text.slice(0, at); }
  return text.trim();
};
function sameSong(title, artist, song) {
  if (!song || plainSongTitle(title) !== plainSongTitle(song.title)) return false;
  const told = String(artist || '').toLowerCase(), listed = String(song.artist || '').toLowerCase();
  if (told.startsWith(listed) || listed.startsWith(told)) return true;
  const first = leadArtist(told);
  return Boolean(first) && first === leadArtist(listed);
}

const escapeHTML = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clockText = (seconds) => { const whole = Math.round(seconds || 0); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`; };

/** The album's card slides to the left and turns toward its songs, the other cards step away, and its songs come in at
 *  its right. */
async function openAlbumCard(cardOpened) {
  cards.lean(null, null);
  openAlbum = cardOpened;
  openSongs = [];
  isOpening = true;
  pendingSong = null;
  // Each album's list starts at its top.
  $('#album .album-rows').scrollTop = 0;
  fillAlbum();
  render();
  const songs = await api.invoke('desk-album-songs', cardOpened);
  if (openAlbum !== cardOpened) return;
  openSongs = songs || [];
  isOpening = false;
  fillAlbum(true);
}

function closeAlbum(redraw = true) {
  if (!openAlbum) return;
  openAlbum = null;
  pendingSong = null;
  $('#album').classList.add('hidden');
  if (redraw) render();
}

/** The open album's songs as rows, as the artist page lists its top songs: its cover, the title, who sings it when that
 *  isn't only the album's artist, how long it is. Drawn whole when the songs come; marked as they play. */
function fillAlbum(scrollToPlaying = false) {
  const panel = $('#album');
  if (!openAlbum) return;
  const artist = shelf.artist || '';
  panel.querySelector('.album-title').textContent = openAlbum.title;
  panel.querySelector('.album-sub').textContent = [artist, openAlbum.line, openSongs.length ? `${openSongs.length} songs` : ''].filter(Boolean).join(' · ');
  const rows = panel.querySelector('.album-rows');
  const cover = albumImage(openAlbum);
  if (isOpening && !openSongs.length) {
    rows.innerHTML = Array.from({ length: 6 }, (_, i) => `<div class="album-song ghost" style="--i:${i}"><div class="cover"></div>
      <div class="words"><b>&nbsp;</b><span>&nbsp;</span></div><div class="time">&nbsp;</div></div>`).join('');
  } else if (!openSongs.length) {
    rows.innerHTML = `<div class="album-note">Couldn't find this album's songs</div>`;
  } else {
    rows.innerHTML = openSongs.map((song, i) => {
      const line = song.artist && song.artist.toLowerCase() !== artist.toLowerCase() ? song.artist : `Track ${i + 1}`;
      return `<div class="album-song" data-i="${i}" style="--i:${i}"><div class="cover" style="background-image:url('${escapeHTML(song.art || cover || '')}')">
        <div class="over"></div></div><div class="words"><b>${escapeHTML(song.title)}</b><span>${escapeHTML(line)}</span></div>
        <div class="time">${song.duration ? clockText(song.duration) : ''}</div></div>`;
    }).join('');
  }
  panel.classList.remove('hidden');
  markAlbum();
  // Opened on the song playing: the list goes to it, so it's seen at once.
  if (scrollToPlaying) {
    const row = rows.querySelector('.album-song.playing');
    if (row) rows.scrollTop = Math.max(0, row.offsetTop - rows.clientHeight / 2 + row.offsetHeight / 2);
  }
}

/** Each album row's glass, made the first time it plays (PlayingGlass). */
const albumGlass = new WeakMap();

/** The song playing stands out of the list as glass, glowing in its colors; the one picked turns while on its way. */
function markAlbum() {
  const panel = $('#album');
  if (!openAlbum) return;
  const rows = panel.querySelector('.album-rows');
  const track = now.track;
  const playingIndex = track ? openSongs.findIndex((s) => sameSong(track.title, track.artist, s)) : -1;
  rows.classList.toggle('has-playing', playingIndex >= 0);
  rows.classList.toggle('running', Boolean(now.playing) && !document.hidden);

  // The glass glows in the song's own colors (DesktopPlayer.songGlow), white while they aren't known.
  const glow = albumColors ? [albumColors.primary, albumColors.secondary].map((c) => hsbToRgb(c).map((v) => v * 255)) : null;
  const artist = shelf.artist || '';
  for (const row of rows.querySelectorAll('.album-song[data-i]')) {
    const i = Number(row.dataset.i);
    const playing = i === playingIndex, pending = i === pendingSong && !playing;
    row.classList.toggle('playing', playing);
    if (playing || albumGlass.has(row)) {
      const glass = albumGlass.get(row) || new PlayingGlass(row);
      albumGlass.set(row, glass);
      const song = openSongs[i];
      glass.update({ playing, running: Boolean(now.playing) && !document.hidden, colors: glow, s: m.s,
        face: { title: song.title, line: song.artist && song.artist.toLowerCase() !== artist.toLowerCase() ? song.artist : `Track ${i + 1}`,
          time: song.duration ? clockText(song.duration) : null, explicit: false, cover: song.art || albumImage(openAlbum) || null } });
    }
    row.classList.toggle('pending', pending);
    const over = row.querySelector('.over');
    const want = playing ? 'bars' : pending ? 'spin' : 'play';
    if (over.dataset.shows !== want) {
      over.dataset.shows = want;
      over.innerHTML = playing ? '<div class="bars"><i></i><i></i><i></i></div>' : pending ? '<div class="spin"></div>'
        : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
    }
  }
}

function drawAlbum() {
  // The song playing's two colors, for the glow of its glass in the album and of the list shown on the shelf.
  const glow = lightColors().map((c) => hsbToRgb(c).map((v) => Math.round(v * 255)).join(', '));
  const key = glow.join('|');
  if (key !== drawAlbum.glow) {
    drawAlbum.glow = key;
    document.documentElement.style.setProperty('--glow', `rgba(${glow[0]}, 0.75)`);
    document.documentElement.style.setProperty('--glow2', `rgba(${glow[1]}, 0.55)`);
  }
  if (openAlbum) markAlbum();
}

$('#album .album-close').addEventListener('click', () => closeAlbum(true));
$('#album .album-rows').addEventListener('click', async (event) => {
  const row = event.target.closest('.album-song[data-i]');
  if (!row || !openAlbum) return;
  const index = Number(row.dataset.i);
  // The song playing pauses or resumes.
  if (row.classList.contains('playing')) { api.send('desk-control', 'toggle'); return; }
  pendingSong = index;
  markAlbum();
  const album = openAlbum;
  await api.invoke('desk-album-play', { songs: openSongs, index, album: album.title, artist: shelf.artist || '' });
  if (pendingSong === index) { pendingSong = null; markAlbum(); }
});

function goHome(delay) {
  clearTimeout(returnHome);
  returnHome = setTimeout(() => { browseKey = null; scrollDebt = 0; render(); }, delay);
}

/** Scrolling turns the ring without playing anything, round and round; after a few quiet seconds the ring turns
 *  back to the album playing. */
carousel.addEventListener('wheel', (event) => {
  // The album's songs scroll themselves; the lyrics' card stands still, and the cards stepped away for the extension.
  if (openAlbum || showsLyrics || document.body.classList.contains('asking')) return;
  event.preventDefault();
  const { deck } = deckNow();
  if (deck.cards.length < 2) return;
  scrollDebt += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  let steps = 0;
  while (Math.abs(scrollDebt) >= 36) { const d = scrollDebt > 0 ? 1 : -1; scrollDebt -= d * 36; steps += d; }
  if (steps) {
    const fromIndex = browseKey ? deck.cards.findIndex((c) => c.key === browseKey) : deck.anchor ?? 0;
    const target = deck.cards[deck.wrap((fromIndex < 0 ? deck.anchor ?? 0 : fromIndex) + steps)];
    browseKey = deck.anchor != null && deck.cards[deck.anchor].key === target.key ? null : target.key;
    hoveredKey = null;
    render();
  }
  goHome(6000);
}, { passive: false });

// Empty space moves the player; a press that hardly moves on a card is a click on it.
let press = null;
$('#player').addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button, input, .strip, #tools .circle, #search-grid, #lists, #searchbar, #album, #ext-card')) return;
  const inCards = Boolean(event.target.closest('#carousel'));
  // The cards stepped away for the extension asked for take no clicks.
  const hit = inCards && !document.body.classList.contains('asking') ? cards.hit(event.clientX, event.clientY) : null;
  press = { x: event.screenX, y: event.screenY, key: hit?.key ?? null, inCards, dragging: false, at: performance.now() };
  $('#player').setPointerCapture(event.pointerId);
});
$('#player').addEventListener('pointermove', (event) => {
  if (!press || press.dragging) return;
  // A press on a card that wobbles a little, or lets go quickly, is still a click; a real pull moves the player.
  const far = Math.hypot(event.screenX - press.x, event.screenY - press.y);
  if (far > (press.key ? 14 : 6) && (far > 30 || performance.now() - press.at > 180)) { press.dragging = true; api.send('desk-drag', 'start', { dx: event.screenX - press.x, dy: event.screenY - press.y }); }
});
// However the press ends, a drag ends with it.
for (const name of ['pointercancel', 'lostpointercapture']) {
  $('#player').addEventListener(name, () => { if (press?.dragging) api.send('desk-drag', 'end'); press = null; });
}
window.addEventListener('blur', () => { if (press?.dragging) api.send('desk-drag', 'end'); press = null; });
$('#player').addEventListener('pointerup', () => {
  if (!press) return;
  const { key, inCards, dragging } = press;
  press = null;
  if (dragging) api.send('desk-drag', 'end');
  // An album open, or the lyrics: a click on the cards, anywhere, goes back to them.
  else if (openAlbum && inCards) closeAlbum(true);
  else if (showsLyrics && inCards) bar.closePanels();
  else if (key) clickCard(key);
});

// ---- the clear window round the player ----
// Windows hands a see-through window every click inside its rectangle, clear or not: the player's clear margin
// swallowed the clicks meant for the desktop and the clock beneath (a friend's PC, 2026-10-09). Where nothing of the player is under the pointer, the window lets it through,
// as the Mac's does by itself; told where the pointer is meanwhile, it takes it again over the player.
const CLEAR = new Set(['player', 'carousel', 'stage', 'aura', 'lyrics', 'search-grid', 'lists', 'tools', 'notice-slot', 'starting', 'refusal']);
let solid = null;
function solidAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === document.body || el === document.documentElement || el.closest('.hidden')) return false;
  // An album open: the cards' place takes the click that goes back to them.
  if (openAlbum && el.closest('#carousel')) return true;
  // Between the cards, and round them where their glow is, is the desktop.
  if (el.closest('#aura') || el.id === 'stage') return Boolean(cards.hit(x, y));
  return !CLEAR.has(el.id) && !el.classList.contains('stage');
}
function feelPointer(x, y) {
  const now = Boolean(press) || solidAt(x, y);
  if (now !== solid) { solid = now; api.send('desk-solid', now); }
}
function letGo() { if (!press && solid !== false) { solid = false; api.send('desk-solid', false); } }
window.__solidAt = solidAt; // for the test machine
window.addEventListener('mousemove', (event) => feelPointer(event.clientX, event.clientY));
document.addEventListener('mouseleave', letGo);
// While see-through the window hears no pointer at all: the app looks where it is (main desktop.js's feel()).
api.listen('desk-pointer', (at) => { if (at) feelPointer(at.x, at.y); else letGo(); });

// ---- from the app ----

function setNow(next) {
  const songChanged = next.track?.id !== now.track?.id;
  now = next;
  search.place(now.searchIn);
  if (songChanged) search.trackChanged();
  if (songChanged) {
    browseKey = null;
    hoveredKey = null;
    cards.lean(null, null);
  }
  readColors(now.artwork);
  if (songChanged) findLyrics();
  drawLyrics();
  const [first] = lightColors();
  const rgb = hsbToRgb(first);
  bar.update({ ...now, isClear, glow: `rgba(${rgb.map((v) => Math.round(v * 255)).join(', ')}, 0.7)` });
  mini.update(now);
  render();
}

// The desk cleared or back (cleardesk.js): the moon beside the lyrics lit or not.
let isClear = false;
api.listen('desk-clear', (on) => { isClear = Boolean(on); setNow(now); });

function setStyle(next) {
  style = { ...DEFAULT_STYLE, ...next };
  m = metricsFor(style.desktop || { size: 0.45, glassBrightness: 0.6 }, style.fit || 1);
  applyMetrics(m);
  search.metrics(m);
  lists.metrics(m);
  // Made small: search closes with the cards. The lyrics stay, in the cards' place above the small bar (his call,
  // 2026-10-09).
  if (style.desktop?.mini && (search.isOpen || search.hasQuery)) search.close();
  $('#tools').classList.toggle('gone', Boolean(style.desktop?.mini));
  render();
  drawLyrics();
}

api.onNow(setNow);
api.onShelf((next) => { shelf = next; render(); });
api.onHistory?.((next) => { history = next; });
api.onDeskStyle(setStyle);
api.onStyle((next) => setStyle({ ...style, ...next }));
api.onMeter((value) => { meter = value; });
document.addEventListener('visibilitychange', render);

api.invoke('desk-hello').then((hello) => {
  setStyle(hello.style);
  shelf = hello.shelf;
  history = hello.history || [];
  setNow(hello.now);
  // The lists' shelf, if it was open, comes back into this page.
  api.send('desk-ready');
});


