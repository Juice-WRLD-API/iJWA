// What every window of iBaila's own on the desktop shares, on Windows: a tool window, so it has no taskbar button,
// stays out of Alt+Tab and Task View, and the app shows up once — as the icon by the clock — not as five windows.
const { BrowserWindow } = require('electron');

const TOOL = process.platform === 'win32' ? { type: 'toolbar' } : {};

// And one process for their pages. Chromium gives every window a process of its own, 20–40 MB apiece (measured
// 2026-10-09: player, list, clock, sound, each its own); a page's popups live in the page's process instead. So the
// windows are opened as popups of one hidden page — the player, the list, the clock, the sound, the settings, the
// artist's page, the chooser, the songs' player — and share its process. The light's windows keep their own, so nothing
// else ever holds up a frame of it.
let host = null;
let hostReady = null;
let count = 0;
const asked = new Map(); // window name → { options, made, cancelled }

function startHost() {
  host = new BrowserWindow({ ...TOOL, show: false, title: 'iBaila', webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  host.webContents.setWindowOpenHandler(({ frameName }) => {
    const one = asked.get(frameName);
    return one ? { action: 'allow', overrideBrowserWindowOptions: one.options } : { action: 'deny' };
  });
  host.webContents.on('did-create-window', (win, { frameName }) => {
    const one = asked.get(frameName);
    if (!one) return;
    asked.delete(frameName);
    if (one.cancelled) win.destroy(); else one.made(win);
  });
  host.webContents.on('render-process-gone', (_e, details) => console.error('[windows] the shared process ended:', details.reason));
  hostReady = host.loadURL('ibaila://app/shared/host.html').catch((error) => console.error('[windows] host:', error.message));
}

/** Opens `url` in a new window made with `options`, in the shared process; `made(window)` once it's there. Returns a
 *  function that calls it off: a window asked for and no longer wanted is closed as it arrives. */
function openShared(url, options, made) {
  if (!host || host.isDestroyed()) startHost();
  const name = `w${++count}`;
  const one = { options, made, cancelled: false };
  asked.set(name, one);
  hostReady.then(() => host.webContents.executeJavaScript(`void window.open(${JSON.stringify(url)}, ${JSON.stringify(name)})`, true))
    .catch((error) => console.error('[windows] open', url, error.message));
  return () => { one.cancelled = true; };
}

/** Runs `code` in the hidden page itself (which draws the tray's icon), and answers with what it gives back. */
async function runShared(code) {
  if (!host || host.isDestroyed()) startHost();
  await hostReady;
  return host.webContents.executeJavaScript(code);
}

module.exports = { TOOL, openShared, runShared };
