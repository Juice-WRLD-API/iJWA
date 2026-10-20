// One display's live wallpaper (WallpaperWindow, WallpaperStage and WallpaperPlane in LiveWallpaper.swift). The app
// says what to show; this page fades and zooms the pictures in and out and crops a music video's black cinema bars. No
// dark is laid behind iBaila's glass any more: over a bright picture it showed as a black shadow round the player, and
// it looked at the picture ten times a second to do so (his call, 2026-10-10).
const api = window.ibaila;
const ARRIVING = 1100, LEAVING = 900;

// The window comes on screen showing the Windows wallpaper exactly as it is, and only then do the pictures come out of
// it: nothing ever pops up.
let onScreen = false;
let readySent = false;
let state = { top: null, topVisible: false, base: null, darkness: 0.5, running: { top: false, base: false }, beneath: null };

/** The user's Dim, over the whole picture: up to 80% black. */
const dim = (darkness) => 0.8 * darkness;
/** How much darker the frost inside the glass is made where the picture has brightness `level`: toward a dark
 *  wallpaper's brightness after the Dim, at most 45%, and nothing where the picture is dark already. */
function scrim(level, darkness) {
  const seen = level * (1 - dim(darkness));
  const brightest = 0.3;
  return seen > brightest ? Math.min(1 - brightest / seen, 0.45) : 0;
}

class Plane {
  constructor(el) {
    this.el = el;
    this.canvas = el.querySelector('.canvas');
    this.shadeEl = el.querySelector('.shade');
    this.video = null;
    this.item = null;
    this.shown = false;
    this.wanted = false;
    this.running = false;
    this.zoom = 1;
  }

  /** The picture to show ({ id, url, kind }) or none, whether it should be in sight, and whether it moves. */
  set(item, visible, running) {
    this.wanted = Boolean(item && visible);
    this.running = Boolean(item && running);
    if ((item?.id ?? null) !== (this.item?.id ?? null)) this.load(item);
    else this.apply();
  }

  load(item) {
    this.item = item;
    if (!item) { this.apply(); return; }
    const video = document.createElement('video');
    Object.assign(video, { muted: true, loop: true, playsInline: true, preload: 'auto' });
    video.src = item.url;
    video.addEventListener('loadeddata', () => {
      if (this.item !== item) { video.remove(); return; }
      const old = this.video;
      this.video = video;
      this.zoom = 1;
      this.bars = { top: 1, side: 1, looks: 0 };
      if (item.kind === 'musicVideo' || item.kind === 'own') this.findBars(item);
      if (old && this.shown) {
        // Another picture in its place: the new one dissolves in over the one before.
        video.style.opacity = '0';
        this.canvas.appendChild(video);
        video.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 800, easing: 'ease-in-out' }).finished.then(() => { video.style.opacity = ''; old.remove(); });
      } else {
        old?.remove();
        this.canvas.appendChild(video);
      }
      this.apply();
      changed();
    }, { once: true });
    video.addEventListener('error', () => { if (this.item === item) console.warn('[wallpaper] unplayable', item.url); }, { once: true });
  }

  apply() {
    const ready = Boolean(this.video && this.item);
    if (this.video) { if (this.running && ready) this.video.play().catch(() => {}); else this.video.pause(); }
    if (this.wanted && ready && !this.shown && onScreen) this.appear();
    else if ((!this.wanted || !this.item) && this.shown) this.disappear();
  }

  /** Comes out of what lies beneath: fading in as it settles from a little closer. */
  appear() {
    this.shown = true;
    const from = getComputedStyle(this.el).opacity;
    this.el.getAnimations().forEach((a) => a.cancel());
    this.el.style.opacity = '1';
    this.el.style.transform = 'scale(1)';
    this.el.animate([{ opacity: from, transform: `scale(${from > 0.05 ? 1.01 : 1.06})` }, { opacity: 1, transform: 'scale(1)' }],
      { duration: ARRIVING, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    setTimeout(changed, ARRIVING + 200);
  }

  /** Holds still and dissolves into what lies beneath. */
  disappear() {
    this.shown = false;
    const from = getComputedStyle(this.el).opacity;
    this.el.getAnimations().forEach((a) => a.cancel());
    this.el.style.opacity = '0';
    this.el.animate([{ opacity: from, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.03)' }], { duration: LEAVING, easing: 'ease-in' })
      .finished.then(() => { if (!this.shown && !this.item && this.video) { this.video.remove(); this.video = null; } }).catch(() => {});
    setTimeout(changed, LEAVING + 200);
  }

  shade(darkness) { this.shadeEl.style.opacity = String(dim(darkness)); }

  // ---- what the picture looks like ----

  /** The part of the video's frame on screen: it covers the display, enlarged by its zoom. */
  sourceRect() {
    const v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    const dw = innerWidth, dh = innerHeight;
    const cover = Math.max(dw / vw, dh / vh) * this.zoom;
    const w = dw / cover, h = dh / cover;
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }

  /** A music video's black cinema bars, looked for in a few frames over its first seconds (a dark scene can't pass for
   *  bars in all of them): the picture is enlarged until they are out of sight. */
  findBars(item) {
    for (const at of [1200, 3500, 7000, 12000, 20000]) {
      setTimeout(() => {
        if (this.item !== item || !this.video || this.video.readyState < 2) return;
        const found = bars(this.video);
        if (!found) return;
        this.bars = { top: Math.min(this.bars.top, found.top), side: Math.min(this.bars.side, found.side), looks: this.bars.looks + 1 };
        if (this.bars.looks < 2) return;
        // Only real bars: a hairline is noise, and more than a fifth is no film format.
        const top = this.bars.top > 0.03 && this.bars.top < 0.2 ? this.bars.top : 0;
        const side = this.bars.side > 0.03 && this.bars.side < 0.2 ? this.bars.side : 0;
        const zoom = Math.max(1 / (1 - 2 * top), 1 / (1 - 2 * side));
        if (Math.abs(zoom - this.zoom) > 0.01) { this.zoom = zoom; this.video.style.transform = `scale(${zoom})`; changed(); }
      }, at);
    }
  }

  /** A still of what shows, darkened as the desktop is, for the frosted glass of the player and the playlist. */
  still(darkness) {
    if (!this.video || this.video.readyState < 2) return null;
    const W = 640, H = Math.round(640 * innerHeight / innerWidth);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const r = this.sourceRect();
    try { g.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, W, H); } catch { return null; }
    // How bright it is: the brighter quarter of a sparse look at it, once per still.
    let level = 0.3;
    try {
      const data = g.getImageData(0, 0, W, H).data, values = [];
      for (let i = 0; i < data.length; i += 4 * 97) values.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
      values.sort((a, b) => b - a);
      const brighter = values.slice(0, Math.max(1, Math.round(values.length / 4)));
      level = brighter.reduce((sum, v) => sum + v, 0) / brighter.length * 0.7;
    } catch { /* unreadable: an even guess */ }
    g.fillStyle = `rgba(0, 0, 0, ${1 - (1 - dim(darkness)) * (1 - scrim(level, darkness))})`;
    g.fillRect(0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.85);
  }
}

/** How deep the black bands along the top and bottom, and the sides, go: the rows and columns, from the edge in, where
 *  nothing is brighter than near-black. */
function bars(video) {
  const W = 160, H = Math.max(Math.round(160 * video.videoHeight / video.videoWidth), 1);
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d', { willReadFrequently: true });
  try { g.drawImage(video, 0, 0, W, H); } catch { return null; }
  const d = g.getImageData(0, 0, W, H).data;
  const dark = (x, y) => { const i = (y * W + x) * 4; return Math.max(d[i], d[i + 1], d[i + 2]) <= 24; };
  const row = (y) => { for (let x = 0; x < W; x++) if (!dark(x, y)) return false; return true; };
  const col = (x) => { for (let y = 0; y < H; y++) if (!dark(x, y)) return false; return true; };
  let top = 0, bottom = 0, left = 0, right = 0;
  while (top < H / 2 && row(top)) top++;
  while (bottom < H / 2 && row(H - 1 - bottom)) bottom++;
  while (left < W / 2 && col(left)) left++;
  while (right < W / 2 && col(W - 1 - right)) right++;
  return { top: Math.min(top, bottom) / H, side: Math.min(left, right) / W };
}

const top = new Plane(document.getElementById('top'));
const base = new Plane(document.getElementById('base'));

function show(next) {
  state = next;
  const beneath = document.getElementById('beneath');
  if (next.beneath && beneath.dataset.url !== next.beneath) {
    beneath.dataset.url = next.beneath;
    beneath.onload = beneath.onerror = ready;
    beneath.src = next.beneath;
  }
  if (!next.beneath) { beneath.removeAttribute('src'); beneath.dataset.url = ''; ready(); }
  top.shade(next.darkness); base.shade(next.darkness);
  base.set(next.base, true, next.running.base);
  top.set(next.top, next.topVisible, next.running.top);
  changed();
}

// The still for the glass, once when something changes.
let stillTimer = 0;
function changed() {
  clearTimeout(stillTimer);
  stillTimer = setTimeout(sendStill, 500);
}

/** What the glass frosts: the clip while it shows, else the user's own video, else the Windows wallpaper (null). */
let stillKey = '';
function sendStill() {
  const plane = top.shown ? top : base.shown ? base : null;
  const key = plane ? `${plane.item?.id}|${plane.zoom}|${state.darkness}` : '';
  if (key === stillKey) return;
  stillKey = key;
  api.send('wall-still', plane ? plane.still(state.darkness) : null);
}

/** The Windows wallpaper is drawn: the window may come on screen. */
function ready() {
  if (readySent) return;
  readySent = true;
  requestAnimationFrame(() => requestAnimationFrame(() => api.send('wall-ready')));
}
api.listen('wall-shown', () => { onScreen = true; base.apply(); top.apply(); });
api.listen('wall-state', show);
api.invoke('wall-hello').then((first) => first && show(first));
