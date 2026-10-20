// The desktop's wallpaper as frost for the glass (WallpaperFrost.swift): a 640-pixel copy laid out the way Windows
// lays it on the primary display, served as ijwa://app/frost.jpg. Pages blur it and show the piece under their
// glass. A new wallpaper makes a new copy; with none to read, the glass is a darker one of its own.
const { screen, nativeImage } = require('electron');
const { execFile } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const events = new EventEmitter();
let made = null;      // { bytes, version }: the Windows wallpaper's frost
let live = null;      // { bytes, version }: the live wallpaper's still, while one shows (LiveBackdrop)
let file = null;      // the Windows wallpaper's own file, for the live wallpaper to show beneath its clips
let version = 0;
let making = null;
let watching = false;

function themes() { return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes'); }

function registry(name, key = 'HKCU\\Control Panel\\Desktop') {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true }, (error, out) => {
      resolve(error ? null : (String(out).match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`)) || [])[1]?.trim() || null);
    });
  });
}

/** Windows' background color ("R G B" in the registry), as [r, g, b]. */
async function backgroundColor() {
  const value = await registry('Background', 'HKCU\\Control Panel\\Colors');
  const rgb = String(value || '0 0 0').split(/\s+/).map(Number);
  return rgb.length === 3 && rgb.every((n) => n >= 0 && n <= 255) ? rgb : [0, 0, 0];
}

/** A picture of one color, as JPEG bytes. */
function solid([r, g, b], width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = b; pixels[i + 1] = g; pixels[i + 2] = r; pixels[i + 3] = 255; }
  return nativeImage.createFromBitmap(pixels, { width, height }).toJPEG(90);
}

/** The wallpaper's file and how it is laid out: 'fill', 'stretch' or 'fit'. */
async function source() {
  if (process.env.IJWA_WALLPAPER) return { file: process.env.IJWA_WALLPAPER, layout: 'fill' };
  if (process.platform !== 'win32') return null;
  // A solid color (Personalize › Background): Windows keeps the last picture's copy, TranscodedWallpaper, all the same —
  // a picture the user no longer has, which showed beneath the live wallpaper at the wrong size and frosted the glass
  // (a friend's black desktop, 2026-10-09). BackgroundType 1 is a solid color.
  const type = await registry('BackgroundType', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Wallpapers');
  if (type !== null && Number(type) === 1) return { color: await backgroundColor() };
  const style = await registry('WallpaperStyle');
  const layout = style === '2' ? 'stretch' : 'fill';
  const transcoded = path.join(themes(), 'TranscodedWallpaper');
  if (fs.existsSync(transcoded)) return { file: transcoded, layout };
  const file = await registry('WallPaper');
  return file && fs.existsSync(file) ? { file, layout } : null;
}

async function make() {
  const found = await source();
  if (found?.color) {
    // The color, for the frost; and a small picture of it beneath the live wallpaper, stretched to fill.
    const display = screen.getPrimaryDisplay().bounds;
    file = path.join(require('electron').app.getPath('userData'), 'wallpaper-color.jpg');
    try { fs.writeFileSync(file, solid(found.color, 64, 64)); } catch { file = null; }
    return solid(found.color, 640, Math.round(640 * display.height / display.width));
  }
  file = found?.file || null;
  if (!found) return null;
  let image = nativeImage.createFromBuffer(fs.readFileSync(found.file));
  if (image.isEmpty()) return null;
  const display = screen.getPrimaryDisplay().bounds;
  const width = 640, height = Math.round(640 * display.height / display.width);
  const size = image.getSize();
  if (found.layout === 'stretch') image = image.resize({ width, height, quality: 'good' });
  else {
    // Filled: the picture covers the display, its middle kept.
    const scale = Math.max(width / size.width, height / size.height);
    const w = Math.max(width, Math.round(size.width * scale)), h = Math.max(height, Math.round(size.height * scale));
    image = image.resize({ width: w, height: h, quality: 'good' })
      .crop({ x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), width, height });
  }
  return image.toJPEG(85);
}

/** Makes the frost again, and says so when it changed. */
function refresh() {
  if (making) return making;
  making = make().catch(() => null).then((bytes) => {
    making = null;
    const had = Boolean(made);
    made = bytes ? { bytes, version: ++version } : null;
    if (bytes || had) events.emit('change');
    return made;
  });
  return making;
}

/** Starts reading the wallpaper, and keeps up with a new one. */
function start() {
  refresh();
  if (watching || process.platform !== 'win32') return;
  watching = true;
  let timer = null;
  try {
    fs.watch(themes(), () => { clearTimeout(timer); timer = setTimeout(refresh, 800); });
  } catch { /* no folder: the frost stays as it is */ }
  screen.on('display-metrics-changed', () => { clearTimeout(timer); timer = setTimeout(refresh, 800); });
}

/** The live wallpaper's still in place of the Windows wallpaper (bytes of a picture of the display), or null to go
 *  back to the Windows wallpaper. */
function setLive(bytes) {
  if (!bytes && !live) return;
  live = bytes ? { bytes, version: ++version } : null;
  events.emit('change');
}

/** The frost's page address, or null with no wallpaper to frost. */
function url() { const shown = live || made; return shown ? `ijwa://app/frost.jpg?v=${shown.version}` : null; }

function serve() {
  const shown = live || made;
  return shown ? new Response(shown.bytes, { headers: { 'Content-Type': 'image/jpeg' } }) : new Response('Not found', { status: 404 });
}

/** The Windows wallpaper itself, full size, for the live wallpaper to show beneath its clips. */
function fullURL() { return file ? `ijwa://app/wallpaper.jpg?v=${made?.version || 0}` : null; }
/** The Windows wallpaper's own file. */
function fullFile() { return file; }
function serveFull() {
  try { return new Response(fs.readFileSync(file), { headers: { 'Content-Type': 'image/jpeg' } }); } catch { return new Response('Not found', { status: 404 }); }
}

module.exports = { start, url, serve, setLive, fullURL, fullFile, serveFull, on: (name, fn) => events.on(name, fn) };
