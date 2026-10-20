// iBaila's icon by the clock (DockIcon.swift's look): the playing song's artwork, rounded or round, in a ring of the
// light's two colors that can glow and, in Music Sync, beat with the music. Drawn here, in the hidden audio window, at
// each size Windows may show it; the app sets it.
import { DEFAULT_STYLE, hsbToRgb, paletteFromPixels } from './engine.js';

const pictures = new Map();   // artwork address → { image, palette }

async function picture(url) {
  if (pictures.has(url)) return pictures.get(url);
  const image = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });
  const probe = document.createElement('canvas');
  probe.width = probe.height = 32;
  const p = probe.getContext('2d', { willReadFrequently: true });
  p.drawImage(image, 0, 0, 32, 32);
  const found = { image, palette: paletteFromPixels(p.getImageData(0, 0, 32, 32).data) };
  if (pictures.size > 12) pictures.delete(pictures.keys().next().value);
  pictures.set(url, found);
  return found;
}

function outline(g, x, y, side, round) {
  g.beginPath();
  if (round) g.arc(x + side / 2, y + side / 2, side / 2, 0, 2 * Math.PI);
  else g.roundRect(x, y, side, side, side * 0.24);
}

/** `{ sizes: { 1: dataURL, 1.5: …, 2: … } }` for the artwork at `url`: its shape and ring from `style.tray`, the ring
 *  in the light's colors (`style`); `beat` (0...1) thickens and brightens the ring. */
export async function trayIcon(url, style = {}, beat = 0) {
  const { image, palette } = await picture(url);
  const tray = { shape: 'rounded', ring: true, ringThickness: 0.5, ringGlow: 0.6, ...(style.tray || {}) };
  const colors = style.useArtworkColors === false ? null : palette;
  const first = colors?.primary || style.primary || DEFAULT_STYLE.primary;
  const second = style.twoColors === false ? first : colors?.secondary || style.secondary || DEFAULT_STYLE.secondary;
  const css = (hsb, alpha = 1) => { const [r, g, b] = hsbToRgb(hsb).map((v) => Math.round(v * 255)); return `rgba(${r},${g},${b},${alpha})`; };
  const round = tray.shape === 'circle';
  const sizes = {};
  for (const [scale, side] of [[1, 16], [1.5, 24], [2, 32]]) {
    const c = document.createElement('canvas');
    c.width = c.height = side;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (!tray.ring) {
      // The artwork alone, in its shape.
      g.save(); outline(g, 0, 0, side, round); g.clip(); g.drawImage(image, 0, 0, side, side); g.restore();
    } else {
      // Room for the glow round the ring; the ring thicker and brighter on a beat.
      const glow = side * 0.14 * tray.ringGlow;
      const inset = Math.min(glow * 0.6, side * 0.1);
      const outer = side - 2 * inset;
      const width = Math.max(1.2, outer * (0.06 + 0.12 * tray.ringThickness) * (1 + 0.5 * beat));
      const sweep = g.createConicGradient(-Math.PI / 2, side / 2, side / 2);
      sweep.addColorStop(0, css(first)); sweep.addColorStop(0.5, css(second)); sweep.addColorStop(1, css(first));
      g.save();
      g.shadowColor = css(first, Math.min(0.5 + 0.5 * beat, 1));
      g.shadowBlur = glow * (1 + beat);
      g.fillStyle = sweep;
      outline(g, inset, inset, outer, round);
      g.fill();
      g.restore();
      // The artwork inside it, in the same shape.
      g.save();
      outline(g, inset + width, inset + width, outer - 2 * width, round);
      g.clip();
      g.drawImage(image, inset + width, inset + width, outer - 2 * width, outer - 2 * width);
      g.restore();
    }
    sizes[scale] = c.toDataURL('image/png');
  }
  return { sizes };
}
