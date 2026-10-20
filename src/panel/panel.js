// The see-through playlist (PlaylistPanelView in PlaylistPanel.swift): a header with the list's covers and name,
// then its songs, the whole of it turned away in 3D like the lists in a story. The song playing climbs to the top
// as if weightless, each song it passes stepping down a place, and stands out of the list as a slab of glass;
// while it plays it floats, little bars dance at its end and sparks of the artwork's colors rise off it.
import { paletteFromPixels, hsbToRgb } from '../light/engine.js';

const api = window.ibaila;
const $ = (selector) => document.querySelector(selector);
const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const random = (a, b) => a + Math.random() * (b - a);
const css = (rgb, alpha = 1) => `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`;

let model = null;
let m = null;
let order = [];             // song indexes in the order they stand, top down
const rows = new Map();     // song index → { el, key }
let scroll = 0;
let hovered = null;         // the slot under the pointer
let heroSong = null;
let colors = null;          // the artwork's two colors (HSB), once read
let colorsFor = null;
let aliveHost = null;
let climbing = 0;           // until when rows are on their way to new places (ms)

// ---- measurements ----

function metricsFor(style) {
  const s = (0.8 + 0.5 * style.size) * (style.fit || 1);
  const width = 300 * s, headerHeight = 66 * s, gap = 8 * s, rowHeight = 50 * s, listHeight = style.rows * rowHeight;
  const turn = 10 + 35 * style.tilt;
  return { s, width, headerHeight, gap, rowHeight, listHeight, stageHeight: headerHeight + gap + listHeight,
    angle: style.side === 'right' ? -turn : turn, depth: width * 4, hinge: style.side === 'right' ? 1 : 0,
    room: 26 * s, clipHeight: listHeight + gap + 14 * s };
}

function applyMetrics() {
  const root = document.documentElement.style;
  const px = (v) => `${v}px`;
  root.setProperty('--s', String(m.s));
  for (const [name, value] of Object.entries({ width: m.width, 'stage-height': m.stageHeight, 'header-height': m.headerHeight, gap: m.gap,
    'row-height': m.rowHeight, 'list-height': m.listHeight, 'clip-height': m.clipHeight, room: m.room, depth: m.depth })) root.setProperty(`--${name}`, px(value));
  root.setProperty('--angle', `${m.angle}deg`);
  root.setProperty('--hinge', `${m.hinge * 100}%`);
}

const most = () => Math.max((model?.songs.length || 0) * m.rowHeight - m.listHeight, 0);

// ---- colors ----

function palette() {
  const white = { hue: 0, saturation: 0, brightness: 1 };
  return colors ? [colors.primary, colors.secondary] : [white, white];
}

function readColors(url) {
  if (url === colorsFor) return;
  colorsFor = url;
  if (!url) { colors = null; paint(); return; }
  const image = new Image();
  image.onload = () => {
    if (colorsFor !== url) return;
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, 32, 32);
    colors = paletteFromPixels(g.getImageData(0, 0, 32, 32).data);
    paint();
  };
  image.src = url;
}

/** The title runs from the artwork's first color to its second; the bars and sparks come in both, as does the glass. */
function paint() {
  const [first, second] = palette().map(hsbToRgb);
  document.documentElement.style.setProperty('--title-colors', `linear-gradient(90deg, ${css(first)}, ${css(second)})`);
  document.documentElement.style.setProperty('--spin', css(first));
  const mixed = first.map((v, i) => (v + second[i]) / 2);
  const hero = $('#hero');
  hero.querySelector('.foot').style.background = `linear-gradient(to top, ${css(mixed)} 0%, ${css(mixed, 0.35)} 35%, ${css(mixed, 0)} 70%)`;
  Object.assign(hero.querySelector('.halo').style, { background: css(second, 0.85), boxShadow: `0 0 ${10 * m.s}px ${css(second)}` });
  hero.querySelectorAll('.slices i').forEach((slice, index, all) => {
    const depth = (index + 1) / all.length;
    const t = 0.25 + 0.45 * depth;
    const tone = [1 - t + t * first[0], 1 - t + t * first[1], 1 - t + t * first[2]];
    slice.style.borderColor = css(tone, 0.34 - 0.24 * depth);
  });
  document.querySelectorAll('.bars i').forEach((bar, index, all) => {
    const share = all.length > 1 ? (index % 4) / 3 : 0;
    bar.style.background = css(first.map((v, i) => v + (second[i] - v) * share));
  });
  document.querySelectorAll('.embers i').forEach((dot, index) => {
    const tint = index % 2 ? second : first;
    dot.style.background = `radial-gradient(circle, #fff 0%, ${css(tint, 0.85)} 30%, ${css(tint, 0)} 70%)`;
  });
}

// ---- the frost behind the glass ----

/** The wallpaper under the glass of the song playing, blurred (WallpaperFrost.swift): the piece of it that lies
 *  behind the pane on the screen. Without a wallpaper to read, the glass is a darker one of its own. */
function placeFrost() {
  const frost = $('#hero .pane .frost');
  const url = model?.frost, display = model?.display;
  $('#hero').classList.toggle('frosted', Boolean(url));
  if (!url || !display) { frost.style.backgroundImage = ''; return; }
  const image = `url("${url}")`;
  if (frost.dataset.url !== url) { frost.dataset.url = url; frost.style.backgroundImage = image; }
  const box = frost.getBoundingClientRect();
  const x = display.x - (window.screenX + box.left), y = display.y - (window.screenY + box.top);
  const key = `${display.width}x${display.height}@${Math.round(x)},${Math.round(y)}`;
  if (frost.dataset.key === key) return;
  frost.dataset.key = key;
  Object.assign(frost.style, { backgroundSize: `${display.width}px ${display.height}px`, backgroundPosition: `${x}px ${y}px`,
    // From a light haze to heavy frost, as on the player's glass.
    filter: `blur(${((2 + 10 * (model.frostAmount ?? 0.35)) * display.width / 640).toFixed(1)}px) saturate(1.35)` });
}
// The window moves when it is dragged: the frost keeps to what lies behind it.
setInterval(() => { if (heroSong != null) placeFrost(); }, 400);

// ---- the header ----

function drawHeader() {
  const header = $('#header');
  header.querySelector('.title span').textContent = model.title;
  header.querySelector('.subtitle').textContent = model.subtitle;
  // The first four albums' covers make the list's.
  const covers = [];
  for (const song of model.songs) { if (song.cover && !covers.includes(song.cover)) covers.push(song.cover); if (covers.length === 4) break; }
  const tiles = [0, 1, 2, 3].map((i) => covers[i] || covers[0]);
  const key = tiles.join('|');
  const mosaic = header.querySelector('.mosaic');
  if (mosaic.dataset.key !== key) {
    mosaic.dataset.key = key;
    mosaic.innerHTML = tiles.map((url) => (url ? `<img src="${escape(url)}" draggable="false">` : '<span></span>')).join('');
  }
  header.classList.toggle('reserve', Boolean(model.canRefresh || model.canPlay));
  header.classList.toggle('both', Boolean(model.canRefresh && model.canPlay));
  const play = $('#play-list');
  play.classList.toggle('shown', Boolean(model.canPlay));
  play.classList.toggle('beside', Boolean(model.canRefresh));
  // Its song playing plays now: the button pauses it, and shows so (his call, 2026-10-10).
  play.classList.toggle('playing', Boolean(model.listPlaying));
  play.setAttribute('aria-label', model.listPlaying ? 'Pause' : 'Play this playlist');
  const refresh = $('#refresh');
  refresh.classList.toggle('shown', model.canRefresh);
  if (model.isRefreshing) refresh.classList.add('spinning');
  else if (refresh.classList.contains('spinning')) { refresh.classList.remove('spinning'); spinOnce(); }
}

function spinOnce() {
  const refresh = $('#refresh');
  refresh.classList.remove('once'); void refresh.offsetWidth; refresh.classList.add('once');
}

// ---- the rows ----

/** A song's cover, title and artist; while Spotify is being asked to start it, a turning ring and word of it. */
function faceHTML(song, playing, starting = false) {
  const cover = song.cover ? `<img class="cover" src="${escape(song.cover)}" draggable="false">` : '<span class="cover"></span>';
  const line = starting ? '<div class="a starting">Starting in Spotify…</div>' : `<div class="a">${escape(song.artist)}</div>`;
  return `${cover}<div class="texts"><div class="t">${escape(song.title)}</div>${line}</div>${starting ? '<i class="spinner"></i>' : ''}`;
}

/** Stands a song in its place, drawing it anew only when it changed. */
function stand(index, slot) {
  const song = model.songs[index];
  if (!song) return null;
  const isPlaying = model.playing === index;
  const isStarting = isPlaying && Boolean(model.starting);
  const key = `${song.id}|${song.cover}|${isPlaying}|${isStarting}`;
  let row = rows.get(index);
  if (!row) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = '<div class="face"></div>';
    el.dataset.index = String(index);
    $('#list').appendChild(el);
    row = { el, key: '' };
    rows.set(index, row);
  }
  const face = row.el.querySelector('.face');
  if (row.key !== key) {
    const melting = row.key !== '';
    row.key = key;
    face.innerHTML = faceHTML(song, isPlaying, isStarting);
    // A song starting or stopping, its cover arriving: the new look melts over the old.
    if (melting) face.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 350 });
  }
  row.el.classList.toggle('playing', isPlaying);
  row.el.style.top = `${slot * m.rowHeight}px`;
  row.el.style.zIndex = isPlaying ? '1' : '0';
  // While a song plays, the others step back a little.
  row.el.classList.toggle('stepped', model.playing != null && !isPlaying);
  face.style.opacity = heroSong === index ? '0' : '1';
  return row;
}

function layOutRows() {
  if (!model || order.length !== model.songs.length) return;
  for (const [index, row] of rows) if (!model.songs[index]) { row.el.remove(); rows.delete(index); }
  order.forEach((index, slot) => stand(index, slot));
  moveList(false);
  updateHero();
  bringPlayingToLife();
}

/** The clip's fade: the bottom edge melts while more songs wait below, the top edge while some have scrolled away. */
function moveList(animated) {
  const list = $('#list');
  list.style.transition = animated ? '' : 'none';
  list.style.transform = `translateY(${-scroll}px)`;
  if (!animated) { void list.offsetWidth; list.style.transition = ''; }
  const edge = Math.min(m.listHeight * 0.12, m.rowHeight * 0.6);
  const above = m.clipHeight - m.listHeight;
  const top = scroll > 0.5 ? 'transparent' : '#000';
  const bottom = scroll < most() - 0.5 ? 'transparent' : '#000';
  document.documentElement.style.setProperty('--fade',
    `linear-gradient(to bottom, ${top} 0px, ${top} ${above}px, #000 ${above + edge}px, #000 ${m.clipHeight - edge}px, ${bottom} ${m.clipHeight}px)`);
  placeScrollBar(animated);
  moveHighlight();
}

/** The bar beside the list: its thumb as long as the part in sight and as far down as the scroll. */
function placeScrollBar(animated) {
  const total = model.songs.length * m.rowHeight;
  const far = most();
  const lane = m.listHeight - 12 * m.s;
  $('#track').classList.toggle('hidden', far <= 0);
  const length = far > 0 ? Math.max(lane * m.listHeight / total, 22 * m.s) : lane;
  const down = far > 0 ? Math.min(Math.max(scroll / far, 0), 1) : 0;
  const thumb = $('#thumb');
  thumb.style.height = `${length}px`;
  thumb.style.transform = `translateY(${(lane - length) * down}px)`;
  if (animated) {
    thumb.classList.add('awake');
    clearTimeout(placeScrollBar.timer);
    placeScrollBar.timer = setTimeout(() => thumb.classList.remove('awake'), 700);
  }
}

// ---- a new list, or the song playing climbing to the top ----

function show(next) {
  const old = model;
  model = next;
  const sizeChanged = !m || old?.style.size !== next.style.size || old?.style.fit !== next.style.fit || old?.style.rows !== next.style.rows || old?.style.tilt !== next.style.tilt || old?.style.side !== next.style.side;
  if (sizeChanged) { m = metricsFor(next.style); applyMetrics(); buildHero(); }
  readColors(next.artwork);
  placeFrost();
  drawHeader();

  const oldIDs = old?.songs.map((s) => s.id) ?? [];
  const newIDs = next.songs.map((s) => s.id);
  const joined = oldIDs.length > 0 && newIDs.length > oldIDs.length && order.length === oldIDs.length && newIDs.slice(0, oldIDs.length).join('\n') === oldIDs.join('\n');
  if (joined) {
    // Songs joined at the end: they stand below the others, and everything already standing stays where it is.
    for (let i = oldIDs.length; i < newIDs.length; i++) order.push(i);
    layOutRows();
    return;
  }
  if (oldIDs.join('\n') !== newIDs.join('\n') || !old) {
    scroll = 0;
    hovered = null;
    const leaving = [...rows.values()].map((r) => r.el);
    rows.clear();
    // A list opens with its song playing, if any, already on top — Continue Playing's way. A playlist chosen keeps its
    // own order, its song playing lit where it is (his call, 2026-10-10: on top, it looked shuffled).
    order = next.songs.map((_, i) => i);
    if (next.playing != null && !next.inPlace) { order.splice(next.playing, 1); order.unshift(next.playing); }
    // A playlist chosen opens scrolled to its song playing, in the middle.
    if (next.playing != null && next.inPlace) scroll = middleScroll(next.playing);
    // The glass sinks with the list it stood out of: a list without the song playing left it standing, empty (2026-10-10).
    if (heroSong != null) { heroSong = null; stand3D(false); }
    leave(leaving, old && oldIDs.length > 0);
    layOutRows();
    if (old && oldIDs.length) arrive();
    return;
  }
  if (next.playing != null && next.playing !== old.playing && next.inPlace) {
    // The next song of the playlist: the list glides to keep it in the middle (his call, 2026-10-10), and its glass
    // waits for its row to arrive before rising out of it.
    scroll = middleScroll(next.playing);
    climbing = performance.now() + 260;
    order.forEach((index, slot) => stand(index, slot));
    moveList(true);
    updateHero();
    setTimeout(() => updateHero(), 280);
    return;
  }
  if (next.playing != null && next.playing !== old.playing && !next.inPlace) {
    const slot = order.indexOf(next.playing);
    if (slot > 0) { climb(next.playing, slot); return; }
  }
  layOutRows();
}

/** The scroll that brings `song`'s row to the middle of the list, as far as the list goes. */
function middleScroll(song) {
  const slot = order.indexOf(song);
  if (slot < 0) return scroll;
  return Math.min(Math.max((slot + 0.5) * m.rowHeight - m.listHeight / 2, 0), most());
}

/** The rows of a list being replaced sink a little and fade, top first, then go. */
function leave(elements, animated) {
  elements.forEach((el, i) => {
    if (!animated) { el.remove(); return; }
    const slot = Math.min(Number(el.style.top.replace('px', '')) / m.rowHeight || 0, 8);
    el.animate([{ transform: 'none', opacity: getComputedStyle(el).opacity }, { transform: `translateY(${10 * m.s}px) scale(0.97)`, opacity: 0 }],
      { duration: 240, delay: slot * 25, easing: 'ease-in', fill: 'forwards' });
    setTimeout(() => el.remove(), 500);
  });
}

/** The rows of a new list drop into place one after another, as the old ones go. */
function arrive() {
  order.forEach((index, slot) => {
    const row = rows.get(index);
    if (!row) return;
    row.el.animate([{ transform: `translateY(${-14 * m.s}px) scale(0.97)`, opacity: 0 }, { transform: 'none', opacity: getComputedStyle(row.el).opacity }],
      { duration: 420, delay: 140 + Math.min(slot, 10) * 40, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.1)', fill: 'backwards' });
  });
}

/** When, from 0 to 1, a move on this curve has covered `progress` of its way. */
function timeReaching(progress, [x1, y1, x2, y2]) {
  const bezier = (a, b, u) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  let low = 0, high = 1;
  for (let i = 0; i < 30; i++) { const u = (low + high) / 2; if (bezier(y1, y2, u) < progress) low = u; else high = u; }
  return bezier(x1, x2, (low + high) / 2);
}

/** The song that starts playing rises to the top as if weightless, and each song it passes steps down a place as it
 *  goes by, one after another, dimming a little as if giving way into the distance. Only the stretch in sight is
 *  played out. */
function climb(song, start) {
  const height = m.rowHeight;
  const lastInSight = Math.ceil((scroll + m.listHeight) / height) - 1;
  const from = Math.min(start, lastInSight + 1);
  order.splice(start, 1);
  order.unshift(song);
  const steps = from;
  const duration = Math.min(0.55 + 0.1 * steps, 1.5) * 1000;
  const curve = [0.45, 0, 0.2, 1];
  const easing = `cubic-bezier(${curve.join(', ')})`;
  if (scroll > 0) { scroll = 0; $('#list').style.transition = `transform ${duration}ms ${easing}`; }
  climbing = performance.now() + duration;
  heroSong = null;
  layOutRows();
  const s = m.s;
  const climber = rows.get(song)?.el;
  climber?.animate([
    { transform: `translate(0px, ${from * height}px) scale(1)`, offset: 0 },
    { transform: `translate(${3 * s}px, ${from * height * 0.62}px) scale(1.045)`, offset: 0.3 },
    { transform: `translate(${-1.5 * s}px, ${from * height * 0.08}px) scale(1.045)`, offset: 0.75 },
    { transform: 'translate(0px, 0px) scale(1)', offset: 1 },
  ], { duration, easing });
  for (let passed = 0; passed < from; passed++) {
    const el = rows.get(order[passed + 1])?.el;
    if (!el) continue;
    // The climber goes by between these points of its way up.
    const meets = Math.max(0, (from - passed - 1.35) / steps);
    const leaves = Math.min(1, (from - passed - 0.15) / steps);
    const begin = timeReaching(meets, curve) * duration;
    const span = Math.max(timeReaching(leaves, curve) * duration - begin, 240);
    const rest = Number(getComputedStyle(el).opacity) || 1;
    el.animate([
      { transform: `translateY(${-height}px) scale(1)`, opacity: rest },
      { transform: `translateY(${-height * 0.5}px) scale(0.965)`, opacity: rest * 0.55 },
      { transform: 'translateY(0px) scale(1)', opacity: rest },
    ], { duration: span, delay: begin, easing: 'ease-in-out', fill: 'backwards' });
  }
  setTimeout(() => { $('#list').style.transition = ''; layOutRows(); }, duration + 60);
}

// ---- the glass ----

function buildHero() {
  const slices = $('#hero .slices');
  slices.innerHTML = '';
  // Twelve points of glass behind the pane, in slices lit less the deeper they lie.
  for (let i = 0; i < 14; i++) {
    const slice = document.createElement('i');
    const depth = (i + 1) / 14;
    slice.style.transform = `translateZ(${-12 * m.s * depth}px)`;
    slice.style.borderColor = `rgba(255, 255, 255, ${0.3 - 0.22 * depth})`;
    slices.appendChild(slice);
  }
  paint();
}

/** Out toward the eye, in the panel's own perspective, and back a little toward the hinge so it stays over its row. */
function forwardTurn() {
  const out = 34 * m.s;
  const back = -out * Math.sin(m.angle * Math.PI / 180) * 0.6;
  return `translate3d(${back}px, ${-2 * m.s}px, ${out}px) scale(1.03)`;
}

/** Stands the glass in front of the song playing while it is in sight — on top, or in its own place in a playlist
 *  chosen — and sinks it back into its row as the song changes, climbs or is scrolled away. */
function updateHero() {
  const now = performance.now();
  const playing = model?.playing;
  const slot = playing != null ? order.indexOf(playing) : -1;
  const y = Math.max(slot, 0) * m.rowHeight - scroll;
  const inSight = slot >= 0 && y > -m.rowHeight * 0.5 && y < m.listHeight - m.rowHeight * 0.5;
  const song = inSight && now >= climbing && rows.get(playing) ? playing : null;
  const hero = $('#hero');
  hero.style.marginTop = `${y}px`;
  // While Spotify is asked to start it, light sweeps across the glass.
  hero.classList.toggle('starting', song != null && Boolean(model.starting));
  $('#floor').style.marginTop = `${y}px`;
  if (song != null) {
    const face = hero.querySelector('.face');
    const html = `<div class="face-row playing">${faceHTML(model.songs[song], true, Boolean(model.starting))}</div>`;
    if (face.dataset.key !== rows.get(song).key) { face.dataset.key = rows.get(song).key; face.innerHTML = html; }
  }
  if (song === heroSong) return;
  const old = heroSong;
  heroSong = song;
  if (old != null) rows.get(old)?.el.querySelector('.face')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: 'forwards' });
  if (song != null) { const f = rows.get(song).el.querySelector('.face'); f.style.opacity = '0'; }
  stand3D(song != null);
  placeFrost();
  bringPlayingToLife();
}

function stand3D(up) {
  const hero = $('#hero');
  const parts = [...hero.children];
  const from = getComputedStyle(hero).transform;
  const to = up ? forwardTurn() : 'none';
  hero.style.transform = to;
  hero.animate([{ transform: from === 'none' ? 'none' : from }, { transform: to }],
    up ? { duration: 700, easing: 'cubic-bezier(0.3, 1.4, 0.5, 1)' } : { duration: 280, easing: 'ease-in' });
  for (const part of parts) {
    const before = getComputedStyle(part).opacity;
    part.style.opacity = up ? '1' : '0';
    part.animate([{ opacity: before }, { opacity: up ? 1 : 0 }], { duration: up ? 350 : 250 });
  }
  $('#floor').style.opacity = up ? '0.5' : '0';
}

// ---- the song playing comes alive ----

/** While its song plays, the song's row floats as if in space, sparks of the artwork's color rise off it and little bars
 *  dance at its end. Paused or hidden, it all stops. */
function bringPlayingToLife() {
  const playing = model?.playing;
  const alive = model?.isAlive && playing != null && !document.hidden;
  const host = !alive ? null : heroSong === playing ? $('#hero') : rows.get(playing)?.el;
  if (host === aliveHost) { paint(); return; }
  if (aliveHost) {
    aliveHost.getAnimations().filter((a) => a.id === 'float').forEach((a) => a.cancel());
    aliveHost.querySelectorAll('.bars, .embers').forEach((el) => el.remove());
  }
  document.querySelectorAll('.bars, .embers').forEach((el) => el.remove());
  aliveHost = host;
  if (!host) return;
  const s = m.s;
  // Floating: a slow drift of a point or two, never the same way twice in a row.
  const float = host.animate([
    { translate: '0px 0px' }, { translate: `${1.6 * s}px ${-1.8 * s}px` }, { translate: `${0.4 * s}px ${-3 * s}px` },
    { translate: `${-1.4 * s}px ${-1.4 * s}px` }, { translate: '0px 0px' }], { duration: 4600, iterations: Infinity, easing: 'ease-in-out' });
  float.id = 'float';
  const target = host.id === 'hero' ? host.querySelector('.face') : host;
  const bars = document.createElement('div');
  bars.className = 'bars';
  for (let i = 0; i < 4; i++) {
    const bar = document.createElement('i');
    bars.appendChild(bar);
    bar.animate([{ transform: `scaleY(${0.2 + 0.1 * (i % 2)})` }, { transform: `scaleY(${1 - 0.15 * (i % 3)})` }],
      { duration: [420, 550, 360, 490][i], direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
  }
  target.appendChild(bars);
  const embers = document.createElement('div');
  embers.className = 'embers';
  for (let i = 0; i < 9; i++) {
    const dot = document.createElement('i');
    const side = random(3, 6) * s;
    Object.assign(dot.style, { width: `${side}px`, height: `${side}px`, marginLeft: `${-side / 2}px`, marginTop: `${-side / 2}px` });
    const start = { x: random(56 * s, m.width * 0.72), y: random(m.rowHeight * 0.3, m.rowHeight * 0.7) };
    const rise = random(14, 28) * s, sway = random(-8, 8) * s;
    const at = (t) => ({ x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * (start.x - sway) + t * t * (start.x + sway),
      y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * (start.y - rise / 2) + t * t * (start.y - rise) });
    const frames = [0, 0.2, 0.6, 1].map((t, k) => {
      const p = at(t);
      return { offset: t, transform: `translate(${p.x}px, ${p.y}px) scale(${[0.6, 1, 0.75, 0.3][k]})`, opacity: [0, 0.9, 0.6, 0][k] };
    });
    dot.animate(frames, { duration: random(1700, 2800), delay: random(0, 2500), iterations: Infinity, fill: 'backwards' });
    embers.appendChild(dot);
  }
  target.appendChild(embers);
  paint();
}

// ---- the pointer ----

function slotAt(element) {
  const row = element?.closest('.row');
  if (!row) return null;
  const index = Number(row.dataset.index);
  const slot = order.indexOf(index);
  return slot >= 0 ? slot : null;
}

function moveHighlight() {
  const highlight = $('#highlight');
  if (hovered == null) { highlight.style.opacity = '0'; return; }
  const appearing = highlight.style.opacity !== '1';
  if (appearing) highlight.style.transition = 'opacity 0.18s';
  highlight.style.transform = `translateY(${m.clipHeight - m.listHeight + hovered * m.rowHeight - scroll}px)`;
  highlight.style.opacity = '1';
  if (appearing) requestAnimationFrame(() => { highlight.style.transition = ''; });
}

document.addEventListener('pointermove', (event) => {
  if (press) return;
  const slot = slotAt(document.elementFromPoint(event.clientX, event.clientY));
  if (slot !== hovered) { hovered = slot; moveHighlight(); }
});
document.addEventListener('pointerleave', () => { hovered = null; moveHighlight(); });

/** A trackpad glides through the songs; a mouse wheel moves one song per notch. */
document.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (!model) return;
  const delta = event.deltaY;
  const step = Math.abs(delta) >= 50 ? Math.sign(delta) * m.rowHeight : delta;
  const next = Math.min(Math.max(scroll + step, 0), most());
  if (next === scroll) return;
  scroll = next;
  hovered = null;
  moveList(true);
  updateHero();
}, { passive: false });

// A press that hardly moves is a click; a real pull moves the panel.
let press = null;
document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  press = { x: event.screenX, y: event.screenY, at: performance.now(), target: event.target, dragging: false };
  document.body.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove', (event) => {
  if (!press || press.dragging) return;
  const far = Math.hypot(event.screenX - press.x, event.screenY - press.y);
  if (far > 12 && (far > 30 || performance.now() - press.at > 180)) { press.dragging = true; api.send('panel-drag', 'start'); }
});
// However the press ends, a drag ends with it.
for (const name of ['pointercancel', 'lostpointercapture']) {
  document.addEventListener(name, () => { if (press?.dragging) api.send('panel-drag', 'end'); press = null; });
}
window.addEventListener('blur', () => { if (press?.dragging) api.send('panel-drag', 'end'); press = null; });
document.addEventListener('pointerup', () => {
  if (!press) return;
  const { target, dragging } = press;
  press = null;
  if (dragging) { api.send('panel-drag', 'end'); return; }
  if (target.closest('#play-list')) { api.send('panel-play-list'); return; }
  if (target.closest('#refresh')) { if (!$('#refresh').classList.contains('spinning')) spinOnce(); api.send('panel-refresh'); return; }
  if (target.closest('#header')) { api.send('panel-header'); return; }
  const slot = slotAt(target);
  if (slot == null) return;
  const index = order[slot];
  rows.get(index)?.el.animate([{ scale: '1' }, { scale: '0.96', offset: 0.35 }, { scale: '1' }], { duration: 300 });
  api.send('panel-play', index);
});
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const slot = slotAt(event.target);
  if (slot != null) api.send('panel-song-menu', order[slot]);
});

// ---- from the app ----

api.onPanel?.((next) => show(next));
document.addEventListener('visibilitychange', () => bringPlayingToLife());
api.invoke('panel-hello').then(show);

// Folders (or songs) dropped on the list become playlists of the user's own songs.
document.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('drop', (event) => {
  event.preventDefault();
  const paths = [...event.dataTransfer.files].map((file) => api.pathOf(file)).filter(Boolean);
  if (paths.length) api.send('panel-drop', paths);
});
