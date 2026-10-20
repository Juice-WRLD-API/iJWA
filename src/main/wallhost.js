// The live wallpaper's own process. Its windows live inside the desktop (desktop-layer.ps1), as children of Explorer's
// own window, and Windows ties a window's input to its parent's: were they the app's, a busy or stuck Explorer would
// stop clicks on the player, the playlist and the clock too. Here they share nothing with the rest of iBaila, which
// says what to show, one JSON line at a time over a named pipe (an app like this one can't read its standard input on
// Windows), and hears back the still the glass should frost.
//   in:  { type: 'config', clips, videos, beneath, preload, layer }  where things are
//        { type: 'show', displays: [{ id, bounds, pixels }], states: { [id]: state } }   (none: everything goes)
//   out: { type: 'still', data } | { type: 'log', text }
const { app, BrowserWindow, protocol, ipcMain, net } = require('electron');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const readline = require('readline');
const net_ = require('net');
const path = require('path');
const fs = require('fs');

// A data folder of its own: two processes can't share one.
app.setPath('userData', path.join(app.getPath('appData'), 'iBaila Wallpaper'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([
  { scheme: 'ibaila', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const pipe = (process.argv.find((a) => a.startsWith('--ibaila-pipe=')) || '').slice('--ibaila-pipe='.length);
let link = null;
const say = (message) => { try { link?.write(JSON.stringify(message) + '\n'); } catch { /* the app is gone */ } };
const log = (...parts) => say({ type: 'log', text: parts.join(' ') });
const root = path.join(__dirname, '..');
let config = null;
const windows = new Map(); // display id → { window, display, ready }
let states = {};

function serve(request) {
  const url = new URL(request.url);
  const { serveFile } = require('./files');
  const inside = (folder, rest) => {
    const file = path.normalize(path.join(folder, decodeURIComponent(rest)));
    return file.startsWith(folder) ? file : null;
  };
  if (url.pathname.startsWith('/clip/') && config) { const f = inside(config.clips, url.pathname.slice(6)); return f ? serveFile(f, request) : new Response('', { status: 404 }); }
  if (url.pathname.startsWith('/desktop-video/') && config) { const f = inside(config.videos, url.pathname.slice(15)); return f ? serveFile(f, request) : new Response('', { status: 404 }); }
  if (url.pathname === '/wallpaper.jpg') {
    try { return new Response(fs.readFileSync(config.beneath), { headers: { 'Content-Type': 'image/jpeg' } }); } catch { return new Response('', { status: 404 }); }
  }
  const file = inside(root, url.pathname);
  return file ? net.fetch(pathToFileURL(file).toString()) : new Response('', { status: 404 });
}

/** Into the desktop itself, beneath the icons. */
function intoDesktop(win, display) {
  if (process.platform !== 'win32') { win.setBounds(display.bounds); return Promise.resolve(); }
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  const r = display.pixels;
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', config.layer,
      '-Handle', String(hwnd), '-Left', String(r.x), '-Top', String(r.y), '-Width', String(r.width), '-Height', String(r.height)], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('exit', () => { clearTimeout(timer); log('[wallpaper] desktop layer:', out.trim() || 'no answer'); resolve(); });
  });
}

function show(displays, next) {
  states = next;
  const wanted = new Set(displays.map((d) => d.id));
  for (const [id, entry] of windows) if (!wanted.has(id)) { entry.window.destroy(); windows.delete(id); }
  for (const display of displays) {
    let entry = windows.get(display.id);
    if (entry && JSON.stringify(entry.display.bounds) !== JSON.stringify(display.bounds)) { entry.window.destroy(); windows.delete(display.id); entry = null; }
    if (!entry) entry = open(display);
    if (entry.ready) entry.window.webContents.send('wall-state', states[display.id]);
  }
}

function open(display) {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x, y, width, height, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#000000', title: 'iBaila',
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    webPreferences: { preload: config.preload, backgroundThrottling: false, contextIsolation: true },
  });
  win.setIgnoreMouseEvents(true);
  const entry = { window: win, display, ready: false, placing: false };
  windows.set(display.id, entry);
  win.loadURL('ibaila://app/wallpaper/wallpaper.html');
  win.webContents.once('did-finish-load', () => {
    entry.ready = true;
    if (states[display.id]) win.webContents.send('wall-state', states[display.id]);
    // On screen once the page has drawn the Windows wallpaper (or after three seconds, whatever it has).
    entry.fallback = setTimeout(() => onScreen(entry), 3000);
  });
  // Explorer restarted takes the window with it: it is made again.
  win.on('closed', () => {
    if (windows.get(display.id)?.window !== win) return;
    windows.delete(display.id);
    setTimeout(() => { if (states[display.id] && !windows.has(display.id)) open(display); }, 2000);
  });
  win.webContents.on('console-message', (event) => {
    if ((event.level === 'warning' || event.level === 'error') && !event.message.includes('Electron Security Warning')) log('[wallpaper page]', event.message);
  });
  return entry;
}

/** Into the desktop and on screen, looking just like the wallpaper it covers; then its pictures come out of it. */
async function onScreen(entry) {
  if (entry.placing) return;
  entry.placing = true;
  clearTimeout(entry.fallback);
  const win = entry.window;
  await intoDesktop(win, entry.display);
  if (win.isDestroyed()) return;
  // A picture of it, drawn unseen, for building on the Mac: IBAILA_SHOT_WALL=file.png.
  if (process.env.IBAILA_SHOT_WALL) {
    win.webContents.send('wall-shown');
    setTimeout(async () => { if (win.isDestroyed()) return; fs.writeFileSync(process.env.IBAILA_SHOT_WALL, (await win.webContents.capturePage()).toPNG()); log('[shot] wall saved'); }, 9000);
    return;
  }
  win.showInactive();
  setTimeout(() => { if (!win.isDestroyed()) win.webContents.send('wall-shown'); }, 120);
}

app.whenReady().then(() => {
  protocol.handle('ibaila', serve);
  ipcMain.handle('wall-hello', (event) => {
    const entry = [...windows.values()].find((w) => w.window.webContents === event.sender);
    return entry ? states[entry.display.id] || null : null;
  });
  ipcMain.on('wall-still', (_e, data) => say({ type: 'still', data }));
  ipcMain.on('wall-ready', (event) => {
    const entry = [...windows.values()].find((w) => w.window.webContents === event.sender);
    if (entry) onScreen(entry);
  });
  link = net_.connect(pipe);
  link.on('error', () => app.quit());
  readline.createInterface({ input: link }).on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'config') config = message;
    else if (message.type === 'show' && config) show(message.displays, message.states);
  }).on('close', () => app.quit());
});
// Its windows come and go with what there is to show; the process goes only when the app lets it go.
app.on('window-all-closed', () => {});
