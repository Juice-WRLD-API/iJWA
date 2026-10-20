// iBaila for Windows: the app's main process. One transparent, click-through window per display
// carries the light; one hidden window listens to the PC's sound; a tray icon holds the controls.
// Started again with --ibaila-wallpaper, the app only holds the live wallpaper (wallhost.js).
if (process.argv.includes('--ibaila-wallpaper')) { require('./wallhost'); return; }
const { app, BrowserWindow, Tray, Menu, screen, session, desktopCapturer, ipcMain, nativeImage, systemPreferences, powerMonitor, shell, dialog } = require('electron');
const path = require('path');
const protocol = require('./protocol');
const settings = require('./settings');
const { fitOf } = require('./fit');
const { TOOL, openShared, runShared } = require('./windows');
const { NowPlaying } = require('./nowplaying');
const { findLyrics } = require('./lyrics');
const { DesktopPlayer } = require('./desktop');
const { PlaylistPanel } = require('./panel');
const { DesktopClock } = require('./clock');
const { LiveWallpaper } = require('./livewallpaper');
const { ArtistWindow } = require('./artist');
const { SourceChooser } = require('./chooser');
const license = require('./license');

require('./log').install();
// One iBaila at a time: started again (from the Start menu, say), the running one opens its settings.
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
// Windows' notifications name the app by the ID its Start menu shortcut carries (electron-builder's appId).
if (process.platform === 'win32') app.setAppUserModelId('com.yomilly.ibaila.windows');
app.on('second-instance', () => (started ? openSettings() : showWelcome()));
protocol.registerScheme();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// No usable graphics card (a virtual machine, a blocklisted driver): draw the light in software
// rather than not at all. A PC with a working GPU never takes this path.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
// The pages may ask for a collection when they're idle (shared/host.html): the player's pages left what they no longer
// used lying for minutes, up to hundreds of MB, before a collection came by itself (memory measured, 2026-10-10).
app.commandLine.appendSwitch('js-flags', '--expose-gc');
// The network in this process rather than one of its own: a process less, for the little iBaila asks of the network
// (measured as a test, 2026-10-10).
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');

let lights = []; // { window, displayId }
let audioWindow = null;
let tray = null;
let settingsWindow = null;
let desktop = null;
let panel = null;
let clock = null;
let live = null;
let away = false;      // the screen locked or the PC asleep
let desktopFront = true; // the desktop or iBaila is the window in front (said while the light shows only there)
let fullScreens = [];  // the displays an app in front fills: a game, a video in full screen
let waitsForMusic = false; // nothing has played for a few seconds: the light is gone until a song plays
let energySaver = false;   // Windows' Energy saver is on
let onBattery = false;
const nowPlaying = new NowPlaying();
let lyrics = null; // { track, status, lyrics } for the song playing
let lastMeter = null; // for the self-check
let playing = false;
let album = null;
let shownArtwork; // the song's artwork the lights were last given

const PRELOAD = path.join(__dirname, 'preload.js');

function lightWindow(display) {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    ...TOOL,
    x, y, width, height,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, show: false, alwaysOnTop: true, fullscreenable: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, contextIsolation: true },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setBounds({ x, y, width, height });
  win.loadURL('ibaila://app/light/light.html');
  win.once('ready-to-show', () => {
    win.showInactive();
    win.webContents.send('style', { ...lightStyle(settings.get()), fit: fitOf(display) });
    win.webContents.send('playing', playing);
    if (album) win.webContents.send('album', album);
    if (shownArtwork) win.webContents.send('artwork', shownArtwork);
    if (tickerSent) win.webContents.send('ticker', tickerSent);
  });
  return { window: win, displayId: display.id };
}

// ---- the Lyrics Ticker's line (EdgeRenderer.followPictures on the Mac) ----------------------------------------
// The line being sung now, sent to the lights while the ticker is the light chosen; the song's name and artist between
// lines, before the words come and when they aren't timed. Its words are looked up once a song.
let tickerSong = null;
let tickerLyrics = null;
let tickerSent = null;

function tickerText() {
  const track = nowPlaying.track;
  if (!track) return 'iBaila';
  const name = `${track.title} — ${track.artist}`;
  const key = `${track.title}\n${track.artist}`;
  if (key !== tickerSong) {
    tickerSong = key;
    tickerLyrics = null;
    findLyrics(track).then((found) => { if (tickerSong === key && found.status === 'found') tickerLyrics = found.lyrics; }).catch(() => {});
  }
  const clock = nowPlaying.clock;
  if (!tickerLyrics?.isSynced || !clock) return name;
  const now = clock.running ? clock.seconds + (Date.now() / 1000 - clock.at) : clock.seconds;
  const sung = [...tickerLyrics.lines].reverse().find((line) => (line.time ?? Infinity) <= now);
  return sung?.text?.trim() || name;
}

setInterval(() => {
  if (settings.get().look !== 'ticker' || !lights.length) { tickerSent = null; return; }
  const text = tickerText();
  if (text !== tickerSent) { tickerSent = text; broadcast('ticker', text); }
}, 250);

// ---- the light chooser (LightPicker.swift) --------------------------------------------------------------------
// A window in the middle of the screen where every light plays in a small screen of its own; a click puts it on the
// edges. Its previews draw only while it's open.
let lightPicker = null;

function openLightPicker() {
  if (lightPicker && !lightPicker.isDestroyed()) { lightPicker.show(); lightPicker.focus(); return; }
  lightPicker = new BrowserWindow({
    width: 780, height: 560, center: true, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: 'Lights', backgroundColor: '#141418',
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  lightPicker.loadURL('ibaila://app/lightpicker/picker.html');
  lightPicker.once('ready-to-show', () => {
    lightPicker.show();
    lightPicker.webContents.send('style', settings.get());
    if (shownArtwork) lightPicker.webContents.send('artwork', shownArtwork);
  });
  lightPicker.on('closed', () => { lightPicker = null; });
}

// ---- the lyric chooser (LyricPicker.swift), the light chooser's twin ---------------------------------------------
let lyricPicker = null;

function openLyricPicker() {
  if (lyricPicker && !lyricPicker.isDestroyed()) { lyricPicker.show(); lyricPicker.focus(); return; }
  lyricPicker = new BrowserWindow({
    width: 780, height: 560, center: true, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: 'Lyrics', backgroundColor: '#141418',
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  lyricPicker.loadURL('ibaila://app/lyricpicker/picker.html');
  lyricPicker.once('ready-to-show', () => {
    lyricPicker.show();
    lyricPicker.webContents.send('style', settings.get());
    if (shownArtwork) lyricPicker.webContents.send('artwork', shownArtwork);
  });
  lyricPicker.on('closed', () => { lyricPicker = null; });
}

/** The displays iBaila lives on: all but those switched off in the settings. */
function shownDisplays() {
  const hidden = new Set(settings.get().hiddenDisplays || []);
  return screen.getAllDisplays().filter((d) => !hidden.has(d.label));
}

/** The light's windows are there only while it can show: made as a song starts, closed once it has faded away (each
 *  is a process of its own, 20–30 MB). */
function lightsWanted() {
  const s = settings.get();
  return s.isEnabled !== false && s.isOn && !waitsForMusic && !(s.energy?.restWhenAway && away) && !process.env.IBAILA_SHOT;
}

function closeLights() {
  lights.forEach(({ window }) => { if (!window.isDestroyed()) window.destroy(); });
  lights = [];
}

function buildLights() {
  closeLights();
  if (lightsWanted()) lights = shownDisplays().map(lightWindow);
}

let lightsGoing = 0;
function fitLights() {
  clearTimeout(lightsGoing);
  if (lightsWanted()) { if (!lights.length) buildLights(); return; }
  // Gone only after half a minute of silence: a song paused a moment and played on again finds its light there, not
  // made afresh just as it resumes.
  if (lights.length) lightsGoing = setTimeout(() => { if (!lightsWanted()) closeLights(); }, 30000);
}

/** What the lights see of the settings: the light shows only while a song plays (his ask, 2026-10-09: paused, it goes
 *  — and a video's sound, never followed, never brings it), rests while nobody is there to see it, and runs leaner on
 *  battery. */
function lightStyle(value) {
  const energy = value.energy || {};
  // In Energy saver the light holds still (Hold still in Energy saver), its sound no longer listened to.
  const holdsStill = energy.stillInLowPower !== false && energySaver;
  return { ...value, isOn: value.isOn && !waitsForMusic && !(energy.restWhenAway && away),
    motion: holdsStill ? 'still' : value.motion,
    budget: holdsStill || (energy.saveOnBattery && onBattery) ? 'low' : 'full' };
}

/** Whether an app fills this display — in physical pixels, as Windows says — and the light should leave it be. */
function stepsAside(display) {
  // Shown only on the desktop: put away while another app is in front (Isaac's suggestion, 2026-10-11).
  if (settings.get().onlyOnDesktop && !desktopFront) return true;
  if (!settings.get().energy?.hideInFullScreen || !fullScreens.length) return false;
  const area = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
  return fullScreens.some((r) => Math.abs(r.x - area.x) < 4 && Math.abs(r.y - area.y) < 4 && Math.abs(r.width - area.width) < 8 && Math.abs(r.height - area.height) < 8);
}

function broadcast(channel, value) {
  if (channel === 'style' || channel === 'meter') settingsWindow?.isDestroyed?.() === false && settingsWindow.webContents.send(channel, value);
  if ((channel === 'style' || channel === 'artwork') && lightPicker && !lightPicker.isDestroyed()) lightPicker.webContents.send(channel, value);
  if ((channel === 'style' || channel === 'artwork') && lyricPicker && !lyricPicker.isDestroyed()) lyricPicker.webContents.send(channel, value);
  if (channel === 'style') value = lightStyle(value);
  for (const { window, displayId } of lights) {
    if (window.isDestroyed()) continue;
    // Each display's light keeps its own share of its screen (fit.js), and steps aside where an app fills it.
    if (channel === 'style') {
      const display = screen.getAllDisplays().find((d) => d.id === displayId);
      window.webContents.send(channel, { ...value, fit: display ? fitOf(display) : 1, isOn: value.isOn && !(display && stepsAside(display)) });
    } else window.webContents.send(channel, value);
  }
  if (channel === 'style') fitLights();
}

function startAudio() {
  // The PC's own sound (WASAPI loopback), which Chromium only hands out with a video track. The video is
  // the hidden audio window itself, not the screen: cheaper, and it works where screen capture is
  // refused (no desktop duplication). The screen stays as the fallback.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame) { callback({ video: request.frame, audio: 'loopback' }); return; }
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => callback({ video: sources[0], audio: 'loopback' }));
  }, { useSystemPicker: false });
}

/** The hidden window that listens, there only while music plays: made, it listens at once. */
let audioOpening = null;
function openAudio() {
  if (audioWindow && !audioWindow.isDestroyed()) { audioWindow.webContents.send('listen', true); return; }
  if (audioOpening) return;
  audioOpening = openShared('ibaila://app/light/audio.html', { ...TOOL, show: false, title: 'iBaila',
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, contextIsolation: true } }, (win) => {
    audioOpening = null;
    audioWindow = win;
  });
}

/** The meter falls to silence first, so the light comes to rest, not to a halt; then the window goes. */
function closeAudio(stillWanted) {
  audioOpening?.();
  audioOpening = null;
  const win = audioWindow;
  if (!win || win.isDestroyed()) { audioWindow = null; return; }
  win.webContents.send('listen', false);
  // The window itself goes after half a minute of silence, so a song paused a moment finds it still there.
  setTimeout(() => {
    if (stillWanted() || audioWindow !== win) return;
    audioWindow = null;
    if (!win.isDestroyed()) win.destroy();
  }, 30000);
}

/** What only the light draws with. */
const LIGHT_ONLY = new Set(['thickness', 'glow', 'particles', 'tailLength', 'sensitivity', 'reaction', 'smoothness']);

/** A setting changed: the light hears it at once; the player, the list, the clock, the wallpaper and the tray at most
 *  20 times a second, the last change always — and a change only the light draws with, once the slider rests. Every
 *  part redrawn for each move of a slider (60 a second) froze the settings while a song played: the desktop's pages
 *  share one process (a friend's PC, 2026-10-09). */
let applying = 0, appliedAt = 0;
function updateStyle(patch) {
  const displaysBefore = JSON.stringify(settings.get().hiddenDisplays);
  broadcast('style', settings.set(patch));
  if ('onlyOnDesktop' in patch) { desktopFront = true; nowPlaying?.watchDesk(Boolean(patch.onlyOnDesktop)); }
  if (JSON.stringify(settings.get().hiddenDisplays) !== displaysBefore) buildLights();
  clearTimeout(applying);
  const lightOnly = Object.keys(patch).every((key) => LIGHT_ONLY.has(key));
  const wait = lightOnly ? 250 : Math.max(0, 50 - (Date.now() - appliedAt));
  applying = setTimeout(applyStyle, wait);
}

function applyStyle() {
  appliedAt = Date.now();
  desktop?.apply();
  panel?.apply();
  clock?.apply();
  live?.refresh();
  if (live) desktop?.send('wall-status', live.statusNow());
  rebuildMenu();
  paintTray();
}

/** The settings, rising from the corner over the tray as Windows' own panels do; gone again when something else is
 *  clicked. Opened from the tray icon, the player's ••• menu, or by starting iBaila again. */
let settingsOpening = null;
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // Shown, or still fading away: it comes back as it was.
    if (settingsWindow.isVisible()) {
      if (settingsLeaving) { settingsLeaving = false; settingsWindow.webContents.send('settings-arriving'); }
      settingsWindow.focus();
      return;
    }
    settingsLeaving = false;
    placeSettings();
    settingsWindow.webContents.send('settings-arriving');
    settingsWindow.show(); settingsWindow.focus();
    return;
  }
  if (settingsOpening) return;
  settingsOpening = openShared('ibaila://app/settings/settings.html', {
    ...settingsBounds(), frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, show: false, alwaysOnTop: true, hasShadow: false, title: 'iBaila Settings', backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  }, (win) => {
    settingsOpening = null;
    settingsWindow = win;
    if (!process.env.IBAILA_SHOT) win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.on('blur', () => { if (!settingsBusy) closeSettings(); });
  });
}

/** The welcome, at the first start (Welcome.swift): where iBaila lives, what it follows, how to make it one's own.
 *  Started or closed, it isn't shown again. IBAILA_WELCOME=1 shows it all the same. */
let welcomeWindow = null;
function showWelcome() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) { welcomeWindow.focus(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  const width = 528, height = 488;
  // A window of its own, not one of the shared process's popups (windows.js): those get no button on the taskbar, and
  // the welcome asking for a key must be findable there.
  const win = new BrowserWindow({
    width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    show: false, title: 'Welcome to iBaila', backgroundColor: '#00000000', webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  welcomeWindow = win;
  win.loadURL('ibaila://app/welcome/welcome.html');
  if (!process.env.IBAILA_SHOT) win.once('ready-to-show', () => { win.show(); win.focus(); });
  // Closed without a key, iBaila has nothing to do: it quits.
  win.on('closed', () => { welcomeWindow = null; if (license.state === 'locked') app.quit(); else settings.set({ welcomed: true }); });
}

/** Bottom right, just over the taskbar, as tall as the screen allows. */
function settingsBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 380, height = Math.min(720, area.height - 8);
  return { x: area.x + area.width - width - 4, y: area.y + area.height - height - 4, width, height };
}
function placeSettings() { settingsWindow.setBounds(settingsBounds()); }

let settingsBusy = false; // a file dialog is open over it
let settingsLeaving = false; // fading away, not yet hidden
/** Gone with a fade. Gone from being left (blur), it stays should the keys come back to it at once; closed on purpose
 *  (its ✕, Escape), it goes whatever has the keys — the ✕ pressed in it had them, the faded window stayed shown, and
 *  the player's gear then found it "open" and showed nothing (a friend's PC, 2026-10-09). */
function closeSettings(onPurpose = false) {
  if (!settingsWindow || settingsWindow.isDestroyed() || !settingsWindow.isVisible()) return;
  settingsLeaving = true;
  settingsWindow.webContents.send('settings-leaving');
  setTimeout(() => {
    if (!settingsLeaving || !settingsWindow || settingsWindow.isDestroyed()) return;
    if (onPurpose || !settingsWindow.isFocused()) settingsWindow.hide();
    else { settingsLeaving = false; settingsWindow.webContents.send('settings-arriving'); }
  }, 150);
}

/** Windows 11 hides a new app's tray icon behind the arrow: the first time, iBaila's is put on the taskbar, where its
 *  settings can be found. Hidden again by the user, it stays hidden. */
function showTrayIcon() {
  if (process.platform !== 'win32' || settings.get().trayShown) return;
  setTimeout(() => {
    const exe = process.execPath.replace(/'/g, "''");
    const script = `$done = $false; Get-ChildItem 'HKCU:\\Control Panel\\NotifyIconSettings' -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath; if ($p.ExecutablePath -and ($p.ExecutablePath -ieq '${exe}')) { Set-ItemProperty $_.PSPath -Name IsPromoted -Value 1 -Type DWord; $done = $true } }
      if ($done) { 'shown' } else { 'not yet' }`;
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (error, out) => {
      const answer = String(out || '').trim();
      console.log('[tray] taskbar icon:', answer || error?.message);
      if (answer === 'shown') settings.set({ trayShown: true });
    });
  }, 4000);
}

function resetPosition(which) {
  const parts = { desktop, playlist: panel, clock };
  updateStyle({ [which]: { place: null } });
  parts[which]?.hide();
  parts[which]?.apply();
}

/** The icon by the clock: the playing song's artwork in a ring of the light's colors; iBaila's own mark when
 *  nothing plays. Its tooltip names the song. */
const trayMark = () => nativeImage.createFromPath(require('./unpacked').unpacked(path.join(__dirname, '../../resources/tray.png')));
let trayShows = null;
let trayBeat = 0;   // 0...1, in steps: how hard the ring beats now (Pulse with the beat, in Music Sync)
async function paintTray() {
  if (!tray) return;
  const state = nowPlaying.snapshot();
  const style = settings.get();
  const art = state.playing && state.artwork && style.tray?.artworkIcon !== false ? state.artwork : null;
  tray.setToolTip(state.track ? `iBaila — ${state.track.title}${state.track.artist ? ` · ${state.track.artist}` : ''}`.slice(0, 127) : 'iBaila');
  const key = art ? `${art}|${JSON.stringify([style.primary, style.secondary, style.twoColors, style.useArtworkColors, style.tray])}|${trayBeat}` : null;
  if (key === trayShows) return;
  trayShows = key;
  if (!art) { tray.setImage(trayMark()); return; }
  try {
    const drawn = await runShared(`window.__trayIcon(${JSON.stringify(art)}, ${JSON.stringify(style)}, ${trayBeat})`);
    if (trayShows !== key) return;
    const image = nativeImage.createEmpty();
    for (const [scale, url] of Object.entries(drawn.sizes)) image.addRepresentation({ scaleFactor: Number(scale), dataURL: url });
    tray.setImage(image);
  } catch { if (trayShows === key) tray.setImage(trayMark()); }
}

function rebuildMenu() {
  const s = settings.get();
  const motion = (value, label) => ({ label, type: 'radio', checked: s.motion === value, click: () => updateStyle({ motion: value }) });
  tray.setContextMenu(Menu.buildFromTemplate([
    // "Light" switches the light alone, as Settings › Light › Edge Light does; it switched all of iBaila off (Isaac's
    // report, 2026-10-11). Turned on, it wakes iBaila too, for those it had switched off that way.
    { label: 'Light', type: 'checkbox', checked: s.isEnabled && s.isOn, click: (item) => updateStyle(item.checked ? { isOn: true, isEnabled: true } : { isOn: false }) },
    { label: 'Motion', submenu: [motion('flow', 'Flow'), motion('music', 'Follow the music'), motion('still', 'Still')] },
    { label: 'Desktop Player', type: 'checkbox', checked: s.desktop.isOn, click: (item) => updateStyle({ desktop: { isOn: item.checked } }) },
    { label: 'Playlist', type: 'checkbox', checked: s.playlist.isOn, click: (item) => updateStyle({ playlist: { isOn: item.checked } }) },
    { label: 'Clock', type: 'checkbox', checked: s.clock.isOn, click: (item) => updateStyle({ clock: { isOn: item.checked } }) },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit iBaila', click: () => app.quit() },
  ]));
}

// The main process's own heap collected at a quiet moment once a minute too, as the pages' are (shared/host.html).
app.whenReady().then(() => {
  require('v8').setFlagsFromString('--expose-gc');
  const collect = require('vm').runInNewContext('gc');
  setInterval(() => setImmediate(collect), 60000).unref();
});
app.whenReady().then(() => {
  protocol.handle();
  // A license first (license.js): without one on this PC, only the welcome shows, asking for the key; with it, all
  // of iBaila starts.
  license.start();
  ipcMain.handle('welcome-hello', () => ({ needsKey: license.state === 'locked', welcomed: Boolean(settings.get().welcomed) }));
  ipcMain.handle('license-activate', async (_e, key) => {
    const failure = await license.activate(key);
    if (!failure) start();
    return failure;
  });
  ipcMain.on('open-store', () => shell.openExternal(license.STORE));
  ipcMain.on('welcome-done', () => { settings.set({ welcomed: true }); welcomeWindow?.close(); });
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('open-light-picker', () => openLightPicker());
  ipcMain.on('close-light-picker', () => lightPicker?.close());
  ipcMain.on('open-lyric-picker', () => openLyricPicker());
  ipcMain.on('close-lyric-picker', () => lyricPicker?.close());
  ipcMain.on('license-move', () => moveToAnotherComputer());
  ipcMain.on('check-updates', () => require('./updater').checkNow());
  // Taken away while iBaila runs (revoked on Polar, or the activation gone): it asks for a key again.
  license.onChange((state) => { if (state === 'locked') showWelcome(); });
  if (license.state === 'active') start();
  // The first time, a welcome; without a key, the welcome asking for it.
  if (license.state === 'locked') showWelcome();
  else if (!settings.get().welcomed || process.env.IBAILA_WELCOME) setTimeout(showWelcome, 1200);
  else if (!startedAtLogin()) setTimeout(sayStarted, 2000);
  license.check();
  // A picture of the welcome asking for a key, drawn unseen: IBAILA_LICENSE=1 IBAILA_SHOT=file.png [IBAILA_SHOT_JS=code].
  if (process.env.IBAILA_SHOT && license.state === 'locked') {
    setTimeout(async () => {
      const win = welcomeWindow;
      if (process.env.IBAILA_SHOT_JS) console.log('[shot] js:', await win.webContents.executeJavaScript(process.env.IBAILA_SHOT_JS).catch((e) => e.message));
      await new Promise((r) => setTimeout(r, Number(process.env.IBAILA_SHOT_WAIT || 900)));
      require('fs').writeFileSync(process.env.IBAILA_SHOT, (await win.webContents.capturePage()).toPNG());
      console.log('[shot] saved');
      app.quit();
    }, Number(process.env.IBAILA_SHOT_MS || 4000));
  }
});

/** Lets this PC go, after asking: the key can then be entered on another computer, and iBaila quits here. */
async function moveToAnotherComputer() {
  settingsBusy = true;
  const asked = await dialog.showMessageBox(settingsWindow, { type: 'question', buttons: ['Deactivate', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    title: 'iBaila', message: 'Move iBaila to another computer?', detail: 'This PC lets go of your license, and iBaila quits. You can then enter your key on another computer.' });
  if (asked.response !== 0) { settingsBusy = false; return; }
  const failure = await license.deactivate();
  if (failure) {
    await dialog.showMessageBox(settingsWindow, { type: 'warning', buttons: ['OK'], noLink: true, title: 'iBaila', message: 'iBaila couldn’t let this PC go',
      detail: failure === 'offline' ? 'Can’t reach the license server. Check your connection and try again.' : 'Something went wrong. Try again in a moment.' });
    settingsBusy = false;
    return;
  }
  app.quit();
}

/** Whether iBaila starts with Windows: its login item, with "--login" or from before it had it. */
function loginItem() {
  return app.getLoginItemSettings({ args: ['--login'] }).openAtLogin || app.getLoginItemSettings().openAtLogin;
}

/** Started with Windows rather than by the user: asked to with "--login", or by an older login item (none), in the
 *  first minutes after the PC started. */
function startedAtLogin() {
  return process.argv.includes('--login') || require('os').uptime() < 180;
}

/** Opened by the user: iBaila has no window of its own nor a button on the taskbar, and its icon may wait under the
 *  tray's ^ — opened, nothing showed it had (a friend, 2026-10-10). A notification says so; clicked, the settings. */
function sayStarted() {
  const { Notification } = require('electron');
  if (!started || !Notification.isSupported()) return;
  const note = new Notification({
    title: 'iBaila is on',
    body: 'Your player is on the desktop. Its icon is by the clock, click here for its settings.',
    icon: nativeImage.createFromPath(require('./unpacked').unpacked(path.join(__dirname, '../../resources/app-icon.png'))), silent: true,
  });
  note.on('click', () => openSettings());
  note.on('show', () => console.log('[started] notification shown'));
  note.on('failed', (_e, error) => console.log('[started] notification failed:', error));
  note.show();
}

/** Everything iBaila does, once, when its license is active. */
let started = false;
/** On a fresh install with Wallpaper Engine running, iBaila's own wallpaper starts off: on, it covered the one the user
 *  chose, with nothing saying why (Isaac's report, 2026-10-11). It can be turned on in Settings › Wallpaper. */
function leaveLiveWallpaperBe() {
  if (process.platform !== 'win32' || !settings.isFresh()) return;
  try {
    const running = require('child_process').execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 4000 });
    if (/"wallpaper(32|64)\.exe"/i.test(running)) {
      settings.set({ wallpaper: { ...settings.get().wallpaper, isOn: false } });
      console.log('[wallpaper] Wallpaper Engine is running: iBaila\'s wallpaper starts off');
    }
  } catch { /* not known: as it was */ }
}

function start() {
  if (started) return;
  started = true;
  leaveLiveWallpaperBe();
  require('./wallpaper').start();
  tray = new Tray(trayMark());
  tray.setToolTip('iBaila');
  tray.on('click', () => (settingsWindow?.isVisible?.() ? closeSettings() : openSettings()));
  showTrayIcon();
  rebuildMenu();
  buildLights();
  startAudio();
  // A display added, taken away or changed (its size, its scale): the light is made again for every display, and the
  // player, the list and the clock go back to their places — kept as fractions of a display — made afresh a moment
  // later, once the displays have settled.
  let settling = null;
  const displaysChanged = (_e, _display, changed) => {
    buildLights();
    if (changed && !changed.some((what) => what === 'bounds' || what === 'scaleFactor' || what === 'workArea')) return;
    clearTimeout(settling);
    settling = setTimeout(() => {
      console.log('[displays] changed: the desktop windows find their places again');
      for (const part of [desktop, panel, clock]) { part?.hide(); part?.apply(); }
    }, 900);
  };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, displaysChanged);
  // The tray's ring beats with the music (Pulse with the beat, in Music Sync): in four steps, at most ten times a second.
  let trayBeatAt = 0;
  ipcMain.on('meter', (_event, value) => {
    lastMeter = value; broadcast('meter', value); desktop.send('meter', value);
    const style = settings.get();
    const pulses = style.motion === 'music' && style.tray?.ring !== false && style.tray?.ringPulse !== false && playing;
    const beat = pulses ? Math.round(Math.min(Math.max(((value?.punch || 0) - 1.15) / 0.7, 0), 1) * 4) / 4 : 0;
    if (beat !== trayBeat && Date.now() - trayBeatAt > 100) { trayBeat = beat; trayBeatAt = Date.now(); paintTray(); }
  });
  ipcMain.on('playing', (_event, value) => { playing = value; broadcast('playing', value); });
  ipcMain.handle('get-style', () => settings.get());
  ipcMain.on('set-style', (_event, patch) => updateStyle(patch));
  ipcMain.handle('settings-hello', () => ({
    style: settings.get(), version: app.getVersion(), clipBytes: require('./clips').size(),
    accent: process.platform === 'win32' ? `#${systemPreferences.getAccentColor().slice(0, 6)}` : null,
    displays: screen.getAllDisplays().map((d) => ({ id: d.id, label: d.label || `Display ${d.id}` })),
    openAtLogin: loginItem(), licensed: license.held,
    extension: require('./extension').extension.browsers(),
  }));
  // The browser extension, added by hand: its folder shown, the browser's extensions page's address ready to paste,
  // and the steps said in the settings.
  ipcMain.handle('install-extension', () => require('./extensionsetup').extensionSetup.add());
  require('./extension').extension.on('links', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('extension-browsers', require('./extension').extension.browsers());
  });
  // Started with Windows, it says "--login", and stays quiet (sayStarted).
  ipcMain.handle('login-item', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: false });
    app.setLoginItemSettings({ openAtLogin: Boolean(on), args: ['--login'] });
    return loginItem();
  });
  ipcMain.on('reset-position', (_e, which) => resetPosition(which));
  // Choosing a video takes the keys from the settings for a moment: they stay open meanwhile.
  ipcMain.handle('wall-choose-video', async () => {
    settingsBusy = true;
    try { return await live.chooseVideo(settingsWindow); } finally { settingsBusy = false; settingsWindow?.focus(); }
  });
  ipcMain.on('settings-close', () => closeSettings(true));
  // Away (locked, asleep) and on battery: what the light gives up for them (lightStyle).
  for (const [name, value] of [['lock-screen', true], ['suspend', true], ['unlock-screen', false], ['resume', false]]) {
    powerMonitor.on(name, () => { away = value; broadcast('style', settings.get()); });
  }
  onBattery = powerMonitor.isOnBatteryPower();
  for (const [name, value] of [['on-battery', true], ['on-ac', false]]) powerMonitor.on(name, () => { onBattery = value; broadcast('style', settings.get()); });

  // The desktop player: the artist's albums as cards, and a bar with the song and its controls.
  // An artist's page, opened from search over the player.
  const artists = new ArtistWindow({ nowPlaying, preload: PRELOAD, player: () => ({ window: desktop?.window, metrics: desktop?.metricsNow() }) });
  // Music in two places at once: which one to hear.
  new SourceChooser({ nowPlaying, preload: PRELOAD });
  desktop = new DesktopPlayer({ nowPlaying, preload: PRELOAD, onHide: rebuildMenu, openSettings: () => openSettings(), artists });
  // The song's words looked for by hand, and timed to the song (Search lyrics, Other lyrics).
  new (require('./lyricstiming').LyricsTiming)({ nowPlaying, desktop, preload: PRELOAD });
  desktop.apply();
  // The test machine's hooks (diag.js): only where its file of steps is already there, never on a user's PC.
  if (require('fs').existsSync(require('path').join(app.getPath('userData'), 'diag.txt'))) require('./diag').install(desktop);
  // The user's own songs: the folders they made playlists, played by iBaila itself.
  const shared = require('./main-state');
  shared.folders = new (require('./folders').FolderLibrary)();
  shared.files = new (require('./fileplayer').FilePlayer)({ nowPlaying, preload: PRELOAD });
  // Beside it, the playlist turned away in 3D: Continue Playing, or a folder of the user's own songs.
  panel = new PlaylistPanel({ nowPlaying, preload: PRELOAD });
  shared.panel = panel;
  shared.desktop = desktop;
  panel.apply();
  // And the clock, in tall digits of glass.
  clock = new DesktopClock({ nowPlaying, preload: PRELOAD });
  clock.apply();
  // Presses Windows eats on windows that never take the keys are handed back (presses.js).
  require('./presses').watch([() => desktop.window, () => panel.window, () => clock.window]);
  // And the desktop itself, alive with the song's video.
  live = new LiveWallpaper({ nowPlaying, preload: PRELOAD });
  live.on('status', (status) => desktop.send('wall-status', status));
  live.on('settings', () => { rebuildMenu(); settingsWindow?.webContents.send('style', settings.get()); });

  // What is playing: it sets the light's rest and its colors, and the words are looked up.
  nowPlaying.on('playing', (value) => { playing = value; broadcast('playing', value); });
  // A song playing brings the light at once; paused or stopped, it fades away three seconds later — long enough that the
  // gap between two songs doesn't take it.
  let musicGone = 0;
  const lightFollows = (value) => {
    clearTimeout(musicGone);
    if (value) { if (waitsForMusic) { waitsForMusic = false; broadcast('style', settings.get()); } return; }
    musicGone = setTimeout(() => { if (!nowPlaying.playing && !waitsForMusic) { waitsForMusic = true; broadcast('style', settings.get()); } }, 3000);
  };
  nowPlaying.on('playing', lightFollows);
  lightFollows(nowPlaying.playing);
  // The PC's sound is listened to only while music plays, and a little after, so a gap between songs costs nothing; the
  // window that listens is there only then.
  let listening = false, quiet = 0;
  const listen = (on) => {
    if (on === listening) return;
    listening = on;
    if (on) openAudio(); else closeAudio(() => listening);
  };
  // Not while the light holds still in Energy saver either: nothing then moves with the sound.
  const hearNow = () => {
    clearTimeout(quiet);
    const still = settings.get().energy?.stillInLowPower !== false && energySaver;
    if (nowPlaying.playing && !away && !still) listen(true);
    else quiet = setTimeout(() => listen(false), still ? 0 : 5000);
  };
  nowPlaying.on('playing', hearNow);
  hearNow();
  nowPlaying.on('state', (state) => {
    if (state.artwork !== shownArtwork) { shownArtwork = state.artwork; broadcast('artwork', state.artwork); }
    paintTray();
  });
  nowPlaying.on('track', async (track) => {
    if (!track) { lyrics = null; return; }
    lyrics = { track, status: 'finding' };
    const found = await findLyrics(track);
    if (lyrics && lyrics.track === track) lyrics = { track, ...found };
  });
  // iBaila's desktop windows live just above the desktop, as the Mac's do at its desktop level: under every app, over
  // the desktop wherever it is (Win+D raises it over everything; they rise with it). The media helper keeps them there;
  // it is told which they are, the player first, whenever they change. Not while one of them has the keys (search typed
  // into, an artist's page open): that one stays where the user is working.
  // Nor while the desk is cleared: they stand over its curtain then (cleardesk.js).
  const { clearDesk } = require('./cleardesk');
  const keepDown = () => {
    const working = desktop?.window?.isFocused?.() || artists.window?.isFocused?.() || panel?.window?.isFocused?.();
    nowPlaying.keepAtDesktop(working || clearDesk.holding ? [] : [desktop?.window, panel?.window, clock?.window]);
  };
  setInterval(keepDown, 2000);
  clearDesk.configure({ windows: () => [clock?.window, panel?.window, desktop?.window, artists.window], live, preload: PRELOAD, nowPlaying });
  // The helper stops keeping them down at once: left to its next look, it pulled them back under the curtain.
  clearDesk.on('change', (on) => { desktop?.send('desk-clear', on); keepDown(); });
  // Music in a browser without iBaila's extension: the player asks for it in its middle (extensionsetup.js).
  const { extensionSetup } = require('./extensionsetup');
  extensionSetup.start({ nowPlaying });
  extensionSetup.on('state', (state) => desktop?.send('desk-extension', state));
  ipcMain.handle('desk-extension', () => extensionSetup.state());
  ipcMain.on('desk-extension-add', () => extensionSetup.add());
  // Back down among the other windows at once, not at the next look.
  clearDesk.on('lowered', keepDown);
  nowPlaying.on('energy-saver', (on) => {
    energySaver = on;
    console.log('[energy] Energy saver', on ? 'on' : 'off');
    broadcast('style', settings.get());
    hearNow();
  });
  nowPlaying.on('desktop-front', (front) => {
    desktopFront = front;
    if (settings.get().onlyOnDesktop) broadcast('style', settings.get());
  });
  nowPlaying.watchDesk(Boolean(settings.get().onlyOnDesktop));
  nowPlaying.on('fullscreen', (rects) => {
    fullScreens = rects;
    console.log('[fullscreen]', rects.length ? JSON.stringify(rects) : 'none');
    broadcast('style', settings.get());
  });
  nowPlaying.start();
  require('./players').useHelper(nowPlaying);
  // New versions, from iBaila's releases (updater.js).
  require('./updater').start();

  // A picture of the desktop player, drawn unseen: IBAILA_SHOT=file.png [IBAILA_SHOT_MS=6000] [IBAILA_SHOT_JS=code].
  if (process.env.IBAILA_SHOT) {
    if (process.env.IBAILA_SHOT_WINDOW === 'settings') openSettings();
    setTimeout(async () => {
      if (process.env.IBAILA_SHOT_JS) console.log('[shot] js:', await desktop.window.webContents.executeJavaScript(process.env.IBAILA_SHOT_JS).catch((e) => e.message));
      // A real click (through Chromium's own input), for trying what a mouse does: IBAILA_SHOT_CLICK=x,y.
      if (process.env.IBAILA_SHOT_CLICK) {
        const [x, y] = process.env.IBAILA_SHOT_CLICK.split(',').map(Number);
        const wc = desktop.window.webContents;
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 90));
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        console.log('[shot] clicked', x, y);
      }
      if (process.env.IBAILA_SHOT_JS2) { await new Promise((r) => setTimeout(r, 400)); console.log('[shot] js2:', await desktop.window.webContents.executeJavaScript(process.env.IBAILA_SHOT_JS2).catch((e) => e.message)); }
      if (process.env.IBAILA_SHOT_WAIT) await new Promise((r) => setTimeout(r, Number(process.env.IBAILA_SHOT_WAIT)));
      const win = { panel: panel.window, clock: clock.window, settings: settingsWindow, artist: artists.window, welcome: welcomeWindow }[process.env.IBAILA_SHOT_WINDOW] || desktop.window;
      await new Promise((r) => setTimeout(r, 900));
      const image = await win.webContents.capturePage();
      require('fs').writeFileSync(process.env.IBAILA_SHOT, image.toPNG());
      console.log('[shot] saved', image.getSize());
      app.quit();
    }, Number(process.env.IBAILA_SHOT_MS || 6000));
  }

  // A quick self-check: IBAILA_SMOKE=1 runs for a few seconds, reports what happened, and quits.
  if (process.env.IBAILA_SMOKE) {
    nowPlaying.on('track', (track) => console.log('[smoke] track:', track?.title, '-', track?.artist));
    setTimeout(() => console.log('[smoke] gpu:', JSON.stringify(app.getGPUFeatureStatus())), 3000);
    const report = async () => {
      const drawing = lights[0] && !lights[0].window.isDestroyed()
        ? await lights[0].window.webContents.executeJavaScript('window.__light ? (window.__light.lost() ? "context lost" : "drawing") : "no light"').catch((e) => `error ${e.message}`)
        : 'no window';
      console.log('[smoke] lights:', lights.length, drawing, '| playing:', playing,
        '| lyrics:', lyrics ? `${lyrics.status}${lyrics.lyrics ? ' ' + lyrics.lyrics.lines.length + ' lines' : ''}` : 'none',
        '| meter:', lastMeter ? `${lastMeter.decibels.toFixed(1)} dB, punch ${lastMeter.punch.toFixed(2)}` : 'no audio values yet');
    };
    const total = Number(process.env.IBAILA_SMOKE_MS || 9000);
    for (let t = 4000; t < total; t += 4000) setTimeout(report, t);
    setTimeout(() => report().then(() => app.quit()), total);
  }
}

app.on('window-all-closed', (event) => event.preventDefault()); // lives in the tray
app.on('before-quit', () => settings.save());
app.on('will-quit', () => live?.stopHost());
