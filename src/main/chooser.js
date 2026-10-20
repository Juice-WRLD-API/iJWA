// The small window that asks which of two players or more to hear (SourceChooser.swift), in the middle of the screen,
// above everything; gone once a player is picked, or the question no longer stands.
const { ipcMain, screen } = require('electron');
const { openShared } = require('./windows');

/** An app's name and mark, from the ID Windows gives its media session. */
function describe(app) {
  const id = String(app || '');
  if (/spotify/i.test(id)) return { name: 'Spotify', kind: 'spotify' };
  if (/applemusic|itunes/i.test(id)) return { name: 'Apple Music', kind: 'appleMusic' };
  if (/unreleased|com\.juicewrldapi\.player/i.test(id)) return { name: 'Unreleased', kind: 'unreleased' };
  if (/msedge/i.test(id)) return { name: 'Microsoft Edge', kind: 'browser' };
  if (/chrome/i.test(id)) return { name: 'Google Chrome', kind: 'browser' };
  if (/firefox|308046B0AF4A39CB/i.test(id)) return { name: 'Firefox', kind: 'browser' };
  if (/brave/i.test(id)) return { name: 'Brave', kind: 'browser' };
  if (/opera/i.test(id)) return { name: 'Opera', kind: 'browser' };
  return { name: id.replace(/\.exe$/i, '').split(/[!._]/).filter(Boolean).pop() || 'A player', kind: 'browser' };
}

class SourceChooser {
  window = null;
  players = [];

  constructor({ nowPlaying, preload }) {
    this.nowPlaying = nowPlaying;
    this.preload = preload;
    nowPlaying.on('contenders', (list) => this.show(list));
    ipcMain.handle('chooser-hello', () => this.players);
    ipcMain.on('chooser-keep', (_e, app) => {
      if (app) nowPlaying.keep(app);
      this.close();
    });
    ipcMain.on('chooser-size', (_e, size) => this.place(size));
  }

  show(list) {
    if (!list?.length) return this.close();
    this.players = list.map((one) => ({ ...one, ...describe(one.app) }));
    if (!this.window || this.window.isDestroyed()) {
      // On its way already, it asks for the players when it's there.
      if (this.opening) return;
      this.opening = openShared('ijwa://app/chooser/chooser.html', {
        width: 520, height: 300, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, focusable: true, backgroundColor: '#00000000',
        title: 'iJWA', webPreferences: { preload: this.preload, contextIsolation: true },
      }, (win) => {
        this.opening = null;
        this.window = win;
        win.setAlwaysOnTop(true, 'floating');
        win.once('ready-to-show', () => { this.place({ width: 520, height: 300 }); win.showInactive(); });
      });
    } else this.window.webContents.send('chooser-players', this.players);
  }

  place(size) {
    if (!this.window || this.window.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.max(320, size.width), height = Math.max(200, size.height);
    this.window.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2 - area.height * 0.08), width, height });
  }

  close() {
    this.opening?.();
    this.opening = null;
    this.players = [];
    const win = this.window;
    this.window = null;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('chooser-players', []);
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 260);
  }
}

module.exports = { SourceChooser };
