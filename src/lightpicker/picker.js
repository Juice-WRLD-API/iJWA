// The light chooser (LightPicker.swift): every light plays in a small screen of its own — the real shader, told it
// draws a 1920 × 1080 screen, scaled down — to a made-up song: a beat every half second, every other one harder, with
// the user's own thickness, glow, tail and colors. A click puts it on the edges. Only the screens in sight draw, all
// through one WebGL canvas kept off the page.
import { RIM_VERTEX, lookFragment } from '../light/shader.js';
import { LOOKS, placeNumber, tickerHeight } from '../light/looks.js';
import { hsbToRgb, paletteFromPixels } from '../light/engine.js';

const api = window.ibaila;
const SCREEN = [1920, 1080];
const W = 440, H = 248; // each tile's pixels: 220 × 124 points, two pixels a point

let style = null;
let album = null;
const grid = document.getElementById('grid');
const CHECK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="white"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---- the tiles -----------------------------------------------------------------------------------------------
const tiles = LOOKS.map((look, number) => {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.innerHTML = `<canvas width="${W}" height="${H}"></canvas><div class="name"><span>${look.title}</span>${CHECK}</div>`;
  tile.addEventListener('click', () => { api.setStyle({ look: look.id }); choose(look.id); });
  grid.appendChild(tile);
  return { look, number, tile, paint: tile.querySelector('canvas').getContext('2d'), seen: false, drops: [] };
});
const sight = new IntersectionObserver((entries) => {
  for (const entry of entries) { const t = tiles.find((x) => x.tile === entry.target); if (t) t.seen = entry.isIntersecting; }
}, { root: grid });
tiles.forEach((t) => sight.observe(t.tile));

function choose(id) { tiles.forEach((t) => t.tile.classList.toggle('chosen', t.look.id === id)); }

// ---- one GL canvas for all of them ---------------------------------------------------------------------------
const glCanvas = document.createElement('canvas');
glCanvas.width = W; glCanvas.height = H;
const gl = glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
const vao = gl.createVertexArray();
const programs = new Map();
function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}
function programFor(fn) {
  if (programs.has(fn)) return programs.get(fn);
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, RIM_VERTEX));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, lookFragment(fn)));
  gl.linkProgram(p);
  const where = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) { const info = gl.getActiveUniform(p, i); where[info.name] = gl.getUniformLocation(p, info.name); }
  const made = { p, where };
  programs.set(fn, made);
  return made;
}

// The ticker's words, made once.
let words = null, wordsWidth = 0;
function makeWords() {
  const height = tickerHeight(style?.thickness ?? 0.1), scale = 2, text = 'Your lyrics, in lights';
  const paper = document.createElement('canvas'), g = paper.getContext('2d');
  const font = `700 ${Math.round(height * 0.72 * scale)}px "Segoe UI", system-ui, sans-serif`;
  g.font = font;
  const gap = height * 2.4;
  wordsWidth = Math.ceil(g.measureText(text).width / scale + gap);
  paper.width = wordsWidth * scale; paper.height = Math.round(height * scale);
  g.font = font; g.fillStyle = '#000'; g.fillRect(0, 0, paper.width, paper.height);
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, (gap / 2) * scale, paper.height / 2 + scale);
  words = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, words);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, paper);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// ---- the made-up song ----------------------------------------------------------------------------------------
let last = 0, nextBeat = 0, beats = 0, kick = 0, travel = 0, wiggle = 0, drift = 0;
function play(now, seconds) {
  if (now >= nextBeat) {
    nextBeat = Math.max(nextBeat + 0.5, now);
    beats += 1;
    const hit = beats % 2 === 0 ? 1 : 0.6;
    kick = Math.max(kick, hit);
    for (const t of tiles) if (t.look.drops) { t.drops.push({ born: now, at: Math.random() }); if (t.drops.length > 4) t.drops.shift(); }
  }
  kick *= Math.exp(-seconds / 0.14);
  const tempo = 1.1;
  travel = (travel + (seconds / 16) * (tempo + 6 * kick)) % 1;
  wiggle = (wiggle + seconds * 3 * (tempo + 1.5 * kick)) % (2 * Math.PI);
  drift = (drift + seconds * (tempo + 0.7 * kick) * 0.6) % 1000;
}

function colors() {
  const s = style;
  const palette = s.useArtworkColors ? album : null;
  const first = palette ? palette.primary : s.primary;
  const second = s.twoColors ? (palette ? palette.secondary : s.secondary) : first;
  return [hsbToRgb(first), hsbToRgb(second)];
}

function draw(t, now) {
  const { look, number } = t;
  const prog = programFor(look.fn);
  const u = prog.where;
  const set1 = (name, v) => { if (u[name]) gl.uniform1f(u[name], v); };
  const thickness = 12 + style.thickness * 52;
  const tail = style.tailLength;
  const [a, b] = colors();
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog.p);
  gl.bindVertexArray(vao);
  if (u.uSize) gl.uniform2f(u.uSize, ...SCREEN);
  if (u.uColorA) gl.uniform3f(u.uColorA, ...a);
  if (u.uColorB) gl.uniform3f(u.uColorB, ...b);
  set1('uScale', W / SCREEN[0]); set1('uWiggle', wiggle); set1('uHeadA', travel);
  set1('uHeadB', look.id === 'twin' ? (1.5 - travel) % 1 : (travel + 0.5) % 1);
  set1('uSpan', 0.18 + 0.54 * tail); set1('uThickness', thickness); set1('uGlow', style.glow); set1('uCorner', 12);
  set1('uBand', thickness * look.reach * 2.6); set1('uStill', 0); set1('uPresence', 1);
  set1('uPulse', 0.85 + 1.3 * 0.6 * kick); set1('uSwell', 1 + 1.25 * 0.6 * kick); set1('uTime', now % 3600);
  set1('uSparkle', 0); set1('uTaper', 1.6 - tail); set1('uLook', number); set1('uDrift', drift); set1('uBeat', kick);
  set1('uPlace', placeNumber(style.place));
  const recent = t.drops.slice(-4).reverse();
  if (u.uDrops) gl.uniform4f(u.uDrops, ...[0, 1, 2, 3].map((i) => (i < recent.length ? now - recent[i].born : -1)));
  if (u.uDropAt) gl.uniform4f(u.uDropAt, ...[0, 1, 2, 3].map((i) => (i < recent.length ? recent[i].at : 0)));
  if (u.uStrip) gl.uniform4f(u.uStrip, look.words ? wordsWidth : 0, tickerHeight(style.thickness), (now * 90) % Math.max(wordsWidth, 1), 0);
  if (look.words) { if (!words) makeWords(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, words); if (u.uWords) gl.uniform1i(u.uWords, 0); }
  gl.drawArrays(gl.TRIANGLES, 0, 24);
  t.paint.clearRect(0, 0, W, H);
  t.paint.drawImage(glCanvas, 0, 0);
}

function frame(ms) {
  requestAnimationFrame(frame);
  const now = ms / 1000;
  if (now - last < 1 / 30 - 0.004) return; // thirty frames a second is plenty for a preview
  const seconds = last ? Math.min(now - last, 0.1) : 0;
  last = now;
  if (!style) return;
  play(now, seconds);
  for (const t of tiles) if (t.seen) draw(t, now);
}
requestAnimationFrame(frame);

// ---- from the app --------------------------------------------------------------------------------------------
api.onStyle((next) => { const thicker = style && next.thickness !== style.thickness; style = next; choose(style.look || 'snake'); if (thicker) words = null; });
api.onArtwork((dataUrl) => {
  if (!dataUrl) { album = null; return; }
  const image = new Image();
  image.onload = () => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, 32, 32);
    album = paletteFromPixels(g.getImageData(0, 0, 32, 32).data);
  };
  image.src = dataUrl;
});
document.getElementById('close').addEventListener('click', () => api.send('close-light-picker'));
addEventListener('keydown', (event) => { if (event.key === 'Escape') api.send('close-light-picker'); });
