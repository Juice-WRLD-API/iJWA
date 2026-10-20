// Puts the clock on the desktop where the user leaves it (DesktopClockController in DesktopClock.swift). The page
// measures its digits and says how big its window must be; the window grows and shrinks about its center.
const { screen, ipcMain } = require('electron');
const settings = require('./settings');
const { fitAt } = require('./fit');
const { TOOL, openShared } = require('./windows');
const { follow } = require('./drag');

const DEFAULT_PLACE = [0.5, 0.26]; // the Mac's (0.5, 0.74) from the bottom

class DesktopClock {
  window = null;
  drag = null;

  constructor({ nowPlaying, preload }) {
    this.nowPlaying = nowPlaying;
    this.preload = preload;
    nowPlaying.on('state', (state) => this.send('now', state));
    ipcMain.handle('clock-hello', () => ({ style: this.styled(), now: nowPlaying.snapshot() }));
    ipcMain.on('clock-size', (_e, size) => this.resize(size));
    ipcMain.on('clock-drag', (_e, phase) => this.dragPhase(phase));
  }

  get style() { return settings.get().clock; }
  /** The clock's settings with how much it shrinks on its display (fit.js). */
  styled() { return { ...this.style, fit: fitAt(this.window && !this.window.isDestroyed() ? this.window.getBounds() : null) }; }
  send(channel, value) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value); }

  apply() {
    if (!this.style.isOn || !settings.get().isEnabled) { this.hide(); return; }
    if (!this.window || this.window.isDestroyed()) { if (!this.opening) this.show(); }
    else this.send('clock-style', this.styled());
  }

  show() {
    const area = screen.getPrimaryDisplay().workArea;
    const place = this.style.place || DEFAULT_PLACE;
    const size = { width: 400, height: 420 };
    this.opening = openShared('ibaila://app/clock/clock.html', {
      ...TOOL,
      x: Math.round(area.x + area.width * place[0] - size.width / 2), y: Math.round(area.y + area.height * place[1] - size.height / 2), ...size,
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, show: false, focusable: false, alwaysOnTop: false, backgroundColor: '#00000000', title: 'iBaila',
      webPreferences: { preload: this.preload, backgroundThrottling: false, contextIsolation: true },
    }, (win) => {
      this.opening = null;
      this.window = win;
      require('./cleardesk').clearDesk.adopt(win);
      if (!process.env.IBAILA_SHOT) win.once('ready-to-show', () => win.showInactive());
    });
  }

  hide() {
    this.opening?.();
    this.opening = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  /** The page measured itself: the window takes that size about its center, kept on the screen. */
  resize(size) {
    if (!this.window || this.window.isDestroyed() || this.drag) return;
    const b = this.window.getBounds();
    // A pixel or two off is Windows rounding at a display scale like 125%: recentred on that, the clock would creep.
    if (Math.abs(b.width - size.width) <= 3 && Math.abs(b.height - size.height) <= 3) return;
    // Centred on the place kept in the settings, not on where Windows says it stands: at 125% that is a pixel off, and
    // the clock crept sideways with every change of its height (a friend's PC, 2026-10-09).
    const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
    const place = this.style.place || DEFAULT_PLACE;
    const x = Math.round(area.x + area.width * place[0] - size.width / 2), y = Math.round(area.y + area.height * place[1] - size.height / 2);
    this.window.setBounds({ ...size,
      x: Math.min(Math.max(x, area.x), Math.max(area.x + area.width - size.width, area.x)),
      y: Math.min(Math.max(y, area.y), Math.max(area.y + area.height - size.height, area.y)) });
  }

  dragPhase(phase) {
    if (!this.window || this.style.locked) return;
    if (phase === 'start') { this.drag?.end(); this.drag = follow(this.window, () => this.dropped()); }
    else this.drag?.end();
  }

  dropped() {
    this.drag = null;
    if (!this.window || this.window.isDestroyed()) return;
    const b = this.window.getBounds();
    const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
    settings.set({ clock: { place: [Math.min(Math.max((b.x + b.width / 2 - area.x) / area.width, 0), 1), Math.min(Math.max((b.y + b.height / 2 - area.y) / area.height, 0), 1)] } });
  }
}

module.exports = { DesktopClock };
