const { contextBridge, ipcRenderer, webUtils } = require('electron');
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
contextBridge.exposeInMainWorld('ijwa', {
  onStyle: on('style'),
  onPlaying: on('playing'),
  onAlbum: on('album'),
  onMeter: on('meter'),
  onArtwork: on('artwork'),
  onTicker: on('ticker'),
  onNow: on('now'),
  onShelf: on('shelf'),
  onDeskStyle: on('desk-style'),
  onPanel: on('panel-model'),
  onHistory: on('desk-history'),
  onClockStyle: on('clock-style'),
  getStyle: () => ipcRenderer.invoke('get-style'),
  setStyle: (patch) => ipcRenderer.send('set-style', patch),
  /** Any channel the app sends on. */
  listen: (channel, callback) => ipcRenderer.on(channel, (_event, value) => callback(value)),
  send: (channel, ...values) => ipcRenderer.send(channel, ...values),
  invoke: (channel, ...values) => ipcRenderer.invoke(channel, ...values),
  /** Where a file dropped on a page lies on disk. */
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});

// A cover that can't be loaded never shows Chromium's broken-picture sign (a friend's PC, 2026-10-10): every page's
// pictures, whoever drew them. One other size of the same picture is tried — the sites keep some sizes of a picture and
// not others — then the picture is left out, the cover's own empty square showing; a picture set there later shows again.
const smaller = (url) => {
  const text = String(url || '');
  if (/i\.ytimg\.com\/vi\//.test(text) && !/\/hqdefault\.jpg/.test(text)) return text.replace(/\/[a-z0-9_]+\.(jpg|webp)(\?.*)?$/i, '/hqdefault.jpg');
  if (/(googleusercontent|ggpht)\.com\//.test(text) && /=[^/]*$/.test(text)) return text.replace(/=[^/]*$/, '=w226-h226-l90-rj');
  if (/sndcdn\.com\//.test(text) && /-(t500x500|original|t300x300)\./.test(text)) return text.replace(/-(t500x500|original|t300x300)\./, '-large.');
  if (/mzstatic\.com\//.test(text) && /\/\d+x\d+[a-z]*\.(jpg|png|webp)$/i.test(text)) return text.replace(/\/\d+x\d+([a-z]*)\.(jpg|png|webp)$/i, '/300x300$1.$2');
  return null;
};
window.addEventListener('error', (event) => {
  const img = event.target;
  if (!img || img.tagName !== 'IMG') return;
  const src = img.getAttribute('src') || '';
  if (img.dataset.ijwaFor !== src && img.dataset.ijwaTried !== src) {
    // A first failure for this picture: one other size of it.
    const other = smaller(src);
    if (other && other !== src) { img.dataset.ijwaFor = other; img.dataset.ijwaTried = src; img.setAttribute('src', other); return; }
  }
  img.style.visibility = 'hidden';
}, true);
window.addEventListener('load', (event) => {
  const img = event.target;
  if (!img || img.tagName !== 'IMG' || img.style.visibility !== 'hidden') return;
  img.style.visibility = '';
}, true);
