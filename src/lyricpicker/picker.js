// The lyric chooser (LyricPicker.swift): every lyric style sings a few made-up lines over and over in a small screen
// of its own, in its own face and the playing song's colors; a click picks it. Screens out of sight rest.
import { WordBlock } from '../desktop/wordblock.js';
import { SCENES } from '../desktop/lyricstyles.js';
import { LYRIC_LOOKS, lyricFontFor } from '../desktop/lyriclooks.js';
import { paletteFromPixels } from '../light/engine.js';

const api = window.ibaila;
const SCALE = 0.36;
const LINES = ['your words land here', 'word by word on the beat', 'in the style you pick'];
const EACH = 2.4;
const PERIOD = EACH * LINES.length + 0.6;
const lyrics = {
  isSynced: true,
  lines: LINES.map((text, index) => {
    const start = 0.3 + index * EACH, parts = text.split(' '), step = (EACH - 0.4) / parts.length;
    return { time: start, text, words: parts.map((t, i) => ({ text: t, start: start + i * step, end: start + (i + 1) * step })), adlibs: [] };
  }),
};

let style = null;
let album = null;
const started = performance.timeOrigin / 1000 + performance.now() / 1000;
const grid = document.getElementById('grid');
const CHECK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="white"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const tiles = LYRIC_LOOKS.map((look) => {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.innerHTML = `<div class="screen"></div><div class="name"><span>${look.title}</span>${CHECK}</div>`;
  tile.addEventListener('click', () => {
    api.setStyle({ desktop: { ...(style?.desktop || {}), lyricsLook: look.id } });
    choose(look.id);
  });
  grid.appendChild(tile);
  const host = tile.querySelector('.screen');
  const view = look.id === 'fisheye' ? new WordBlock(host) : new SCENES[look.id](host);
  return { look, tile, view, seen: false };
});
const sight = new IntersectionObserver((entries) => {
  for (const entry of entries) { const t = tiles.find((x) => x.tile === entry.target); if (t) { t.seen = entry.isIntersecting; sing(t); } }
}, { root: grid });
tiles.forEach((t) => sight.observe(t.tile));

function choose(id) { tiles.forEach((t) => t.tile.classList.toggle('chosen', t.look.id === id)); }

/** One screen, from the top of the lines this time round: a new clock each round, so the lines start again. */
function sing(t) {
  if (!style) return;
  const now = performance.timeOrigin / 1000 + performance.now() / 1000;
  const round = Math.floor((now - started) / PERIOD);
  const clock = { seconds: 0, at: started + round * PERIOD, running: true };
  t.view.show({ id: `preview-${round}`, lyrics, title: 'iBaila', artist: '', duration: PERIOD },
    { clock, isSeen: t.seen, colors: album, face: lyricFontFor(style.desktop, t.look.id), scale: SCALE });
}
function singAll() { tiles.forEach(sing); }
function nextRound() {
  const now = performance.timeOrigin / 1000 + performance.now() / 1000;
  const wait = PERIOD - ((now - started) % PERIOD);
  setTimeout(() => { singAll(); nextRound(); }, wait * 1000 + 5);
}
nextRound();

// ---- from the app --------------------------------------------------------------------------------------------
api.onStyle((next) => { style = next; choose(style.desktop?.lyricsLook || 'fisheye'); singAll(); });
api.onArtwork((dataUrl) => {
  if (!dataUrl) { album = null; singAll(); return; }
  const image = new Image();
  image.onload = () => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, 32, 32);
    album = paletteFromPixels(g.getImageData(0, 0, 32, 32).data);
    singAll();
  };
  image.src = dataUrl;
});
document.getElementById('close').addEventListener('click', () => api.send('close-lyric-picker'));
addEventListener('keydown', (event) => { if (event.key === 'Escape') api.send('close-lyric-picker'); });
