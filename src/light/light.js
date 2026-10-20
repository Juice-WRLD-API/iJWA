// One display's light: a transparent full-screen canvas drawn with WebGL2.
import { RIM_VERTEX, SPARK_VERTEX, SPARK_FRAGMENT, lookFragment } from './shader.js';
import { lookOf, tickerHeight } from './looks.js';
import { DEFAULT_STYLE, LightEngine, paletteFromPixels } from './engine.js';
import { startMeter } from './audio.js';

const params = new URLSearchParams(location.search);
const preview = params.has('preview');
if (preview) document.body.classList.add('preview');

let style = { ...DEFAULT_STYLE, motion: params.get('motion') || DEFAULT_STYLE.motion };
let playing = preview ? params.get('playing') !== '0' : false;
let meter = { decibels: -120, punch: 0 };
const engine = new LightEngine();

const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
if (!gl) throw new Error('WebGL2 is unavailable');
// The graphics driver was reset (a driver update, sleep, a GPU crash): start the light again from scratch.
canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); setTimeout(() => location.reload(), 1000); });

function compile(type, source, name) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    console.error(`Shader ${name} failed:\n${log}`);
    throw new Error(`Shader ${name} failed`);
  }
  return shader;
}
function program(vertex, fragment, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vertex, `${name} vertex`));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment, `${name} fragment`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error(`Program ${name} failed to link:\n${gl.getProgramInfoLog(p)}`);
    throw new Error(`Program ${name} failed`);
  }
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, uniforms };
}

// Each light's program, made the first time it's drawn: lights nobody picks cost nothing.
const looks = new Map();
function lookProgram(fn) {
  if (!looks.has(fn)) looks.set(fn, program(RIM_VERTEX, lookFragment(fn), fn));
  return looks.get(fn);
}
const sparks = program(SPARK_VERTEX, SPARK_FRAGMENT, 'sparks');

// ---- the ticker's words ----------------------------------------------------------------------
// The line being sung, in white on black, two pixels a point (LightTextures.words on the Mac); its strip's width in
// points, with a gap so a repeated line doesn't run into the next, goes to the engine for the scroll.
let tickerLine = '';
let wordsTexture = null;
let wordsFor = null;
function makeWords(text, height) {
  const scale = 2, paper = document.createElement('canvas');
  const g = paper.getContext('2d');
  const font = `700 ${Math.round(height * 0.72 * scale)}px "Segoe UI", system-ui, sans-serif`;
  g.font = font;
  const gap = height * 2.4;
  const width = Math.min(Math.ceil(g.measureText(text).width / scale + gap), 4000);
  paper.width = Math.max(Math.round(width * scale), 1);
  paper.height = Math.round(height * scale);
  g.font = font;
  g.fillStyle = '#000'; g.fillRect(0, 0, paper.width, paper.height);
  g.fillStyle = '#fff'; g.textBaseline = 'middle';
  g.fillText(text, (gap / 2) * scale, paper.height / 2 + scale);
  if (!wordsTexture) wordsTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, wordsTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, paper);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  engine.tickerWidth = width;
}
function followWords() {
  if (!lookOf(style.look).words) return;
  const height = tickerHeight(style.thickness);
  const text = tickerLine || 'iJWA';
  const key = `${text}|${height}`;
  if (key !== wordsFor) { wordsFor = key; makeWords(text, height); }
}
const vao = gl.createVertexArray(); // no attributes: the vertices come from gl_VertexID

function setUniforms(prog, u) {
  const l = prog.uniforms;
  const set = (name, fn) => { if (l[name] !== undefined && l[name] !== null) fn(l[name]); };
  set('uSize', (x) => gl.uniform2f(x, u.size[0], u.size[1]));
  set('uColorA', (x) => gl.uniform3f(x, ...u.colorA));
  set('uColorB', (x) => gl.uniform3f(x, ...u.colorB));
  for (const [name, key] of [['uScale', 'scale'], ['uWiggle', 'wiggle'], ['uHeadA', 'headA'], ['uHeadB', 'headB'],
    ['uSpan', 'span'], ['uThickness', 'thickness'], ['uGlow', 'glow'], ['uCorner', 'corner'], ['uBand', 'band'],
    ['uStill', 'still'], ['uPresence', 'presence'], ['uPulse', 'pulse'], ['uSwell', 'swell'], ['uTime', 'time'],
    ['uSparkle', 'sparkle'], ['uTaper', 'taper'], ['uLook', 'look'], ['uDrift', 'drift'], ['uBeat', 'beat'], ['uPlace', 'place']]) {
    set(name, (x) => gl.uniform1f(x, u[key]));
  }
  for (const [name, key] of [['uDrops', 'drops'], ['uDropAt', 'dropAt'], ['uStrip', 'strip']]) {
    set(name, (x) => gl.uniform4f(x, ...u[key]));
  }
  set('uWords', (x) => gl.uniform1i(x, 0));
}

function sparkInstances(size) {
  const bend = Math.min(size[0], size[1]) * 0.2;
  const total = 2 * (size[0] + size[1] - 4 * bend) + 2 * Math.PI * bend;
  return 2 * Math.max(Math.floor(total / 48), 3) + 2;
}

function resize() {
  // Optimized mode: drawn at one pixel per point, however sharp the display — a quarter of the pixels on a 2x one.
  const scale = style.energy?.optimize ? Math.min(window.devicePixelRatio || 1, 1) : window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * scale), h = Math.round(window.innerHeight * scale);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  return scale;
}

let timer = 0;
let lastDraw = 0;
const t0 = performance.now();

function draw(now) {
  const scale = resize();
  // On a smaller screen the rim keeps its share of it: the light is drawn as if on a screen `fit` times bigger.
  const fit = style.fit || 1;
  const size = [window.innerWidth / fit, window.innerHeight / fit];
  followWords();
  const u = engine.step(now, meter, playing, style, size, scale * fit);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindVertexArray(vao);
  const rim = lookProgram(u.fn);
  gl.useProgram(rim.p);
  if (wordsTexture && lookOf(style.look).words) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, wordsTexture); }
  setUniforms(rim, u);
  gl.drawArrays(gl.TRIANGLES, 0, 24);
  if (u.sparkle > 0 && u.still < 0.5) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(sparks.p);
    setUniforms(sparks, u);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, sparkInstances(size));
  }
  lastDraw = now;
}

function loop() {
  timer = 0;
  const now = (performance.now() - t0) / 1000;
  // On battery, when the user asks to save energy, half the frames.
  const rate = engine.frameRate(style, playing, now) * (style.budget === 'low' ? 0.5 : 1);
  if (now - lastDraw >= 1 / (rate || 60) - 0.004 || rate === 0) draw(now);
  const after = engine.frameRate(style, playing, now);
  if (after > 0) timer = requestAnimationFrame(loop);
}
/** Something changed: draw again, and keep going while the light moves. */
function wake() {
  if (!timer) timer = requestAnimationFrame(loop);
}

// ---- style and the song, from the app ------------------------------------------------------
engine.fadeTo(style.isEnabled && style.isOn ? 1 : 0, 0);
if (window.ijwa) {
  window.ijwa.onStyle((next) => { style = { ...DEFAULT_STYLE, ...next }; engine.fadeTo(style.isEnabled && style.isOn ? 1 : 0, (performance.now() - t0) / 1000); wake(); });
  window.ijwa.onPlaying((value) => { playing = value; wake(); });
  window.ijwa.onAlbum((album) => { engine.setAlbum(album); wake(); });
  window.ijwa.onMeter((value) => { meter = value; });
  // The Lyrics Ticker's line, from the app: the line being sung, or the song's name and artist.
  window.ijwa.onTicker?.((text) => { tickerLine = text || ''; wake(); });
  // A song's artwork, as a picture: the light takes its two colors from it (grey artwork gives none).
  window.ijwa.onArtwork((dataUrl) => {
    if (!dataUrl) { engine.setAlbum(null); wake(); return; }
    const image = new Image();
    image.onload = () => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 32;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(image, 0, 0, 32, 32);
      engine.setAlbum(paletteFromPixels(g.getImageData(0, 0, 32, 32).data));
      wake();
    };
    image.src = dataUrl;
  });
}

// ---- the audio -----------------------------------------------------------------------------
const source = params.get('audio') || (preview ? 'synth' : null);
if (source) {
  startMeter(source, (value) => { meter = value; if (style.motion === 'music') wake(); })
    .catch((error) => console.error('Audio failed:', error));
}

// Pre-set colors for a preview: the colors come from a picture the harness hands over.
if (preview && params.get('album')) {
  const [a, b] = params.get('album').split(',').map(Number);
  engine.setAlbum({ primary: { hue: a, saturation: 0.8, brightness: 1 }, secondary: { hue: b, saturation: 0.9, brightness: 1 } });
}
window.addEventListener('resize', wake);
wake();
window.__light = { engine, get style() { return style; }, set style(v) { style = v; wake(); }, wake, lost: () => gl.isContextLost() };
