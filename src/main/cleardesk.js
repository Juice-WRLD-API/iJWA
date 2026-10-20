// The desk cleared (ClearDesk.swift; his ask, 2026-10-10: a button beside the lyrics, like Focus on a Mac or an iPhone):
// the other apps' windows, the desktop's icons and the taskbar go, and only iBaila — player, list, clock — the wallpaper
// and the light stay. Pressed again, all comes back as it was; going to another app (Alt+Tab, the Start menu) brings it
// all back too.
//
// No window is hidden, minimized or moved: the wallpaper is laid over all of them like a curtain, fading in — the live
// wallpaper's clip over it, if one plays — with iBaila's windows lifted over it, and fades away again. Every window
// waits under it exactly where it was, the taskbar too, so nothing of Windows itself is ever changed, and nothing is
// left changed should iBaila stop.
const { screen } = require('electron');
const EventEmitter = require('events');
const { TOOL, openShared } = require('./windows');

class ClearDesk extends EventEmitter {
  isOn = false;
  /** iBaila's windows held over the curtain: from the press until the curtain has opened again. */
  holding = false;
  curtains = [];   // { win, ready: Promise }
  turn = 0;

  /** windows: () => iBaila's own windows to keep in sight; live: the live wallpaper; preload: the pages' bridge. */
  configure({ windows, live, preload, nowPlaying }) {
    Object.assign(this, { windows, live, preload, nowPlaying });
    const { ipcMain } = require('electron');
    ipcMain.on('curtain-opened', (event) => {
      const one = this.curtains.find((c) => c.win && !c.win.isDestroyed() && c.win.webContents === event.sender);
      if (one) this.close(one);
    });
    // The window in front changed: the user went to another app themselves (smtc.ps1's watch).
    nowPlaying.on('front', (pid) => {
      if (!this.isOn) return;
      if (this.front == null) { this.front = pid; return; }
      if (pid === this.front || pid === process.pid || Date.now() - this.since < 1500) { this.front = pid; return; }
      console.log('[clear] another app came forward: everything back');
      this.end();
    });
  }

  toggle() { if (this.isOn) this.end(); else this.begin(); }

  begin() {
    this.isOn = true;
    this.holding = true;
    this.since = Date.now();
    this.front = null;
    const turn = ++this.turn;
    this.emit('change', true);
    this.nowPlaying.send('watch-front on');
    // What the curtain shows: the Windows wallpaper, and the live wallpaper's clip over it while one shows.
    const wallpaper = require('./wallpaper');
    const shown = this.live?.playback && this.nowPlaying.playing ? this.live.playback : this.live?.base;
    const look = { picture: wallpaper.fullURL(), clip: shown?.url || null };
    for (const display of screen.getAllDisplays()) {
      const one = { win: null };
      one.ready = new Promise((done) => {
        openShared('ibaila://app/curtain/curtain.html', {
          ...TOOL, ...display.bounds, frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
          maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false, focusable: false,
          alwaysOnTop: true, enableLargerThanScreen: true, backgroundColor: '#00000000', title: 'iBaila',
          webPreferences: { preload: this.preload, backgroundThrottling: false, contextIsolation: true },
        }, (win) => {
          one.win = win;
          win.setAlwaysOnTop(true, 'screen-saver');
          win.once('ready-to-show', () => {
            if (turn !== this.turn || !this.isOn) { this.close(one); done(); return; }
            win.showInactive();
            win.setBounds(display.bounds);
            // iBaila's own over it: the last brought to the top is the highest. Again a moment later, should the helper
            // keeping them by the desktop have looked once more meanwhile.
            this.lift();
            setTimeout(() => { if (this.isOn) this.lift(); }, 600);
            win.webContents.send('curtain-close', look);
            done();
          });
        });
      });
      this.curtains.push(one);
    }
  }

  /** Everything back: the curtain opens, then iBaila's windows go back down among the others. */
  end() {
    this.isOn = false;
    ++this.turn;
    this.emit('change', false);
    this.nowPlaying.send('watch-front off');
    for (const one of this.curtains) {
      one.ready.then(() => {
        if (!one.win || one.win.isDestroyed()) return;
        one.win.webContents.send('curtain-open');
        // Should the page never answer, it goes all the same.
        setTimeout(() => this.close(one), 2000);
      });
    }
    if (!this.curtains.length) this.lower();
  }

  close(one) {
    if (one.win && !one.win.isDestroyed()) one.win.destroy();
    one.win = null;
    this.curtains = this.curtains.filter((c) => c !== one);
    if (!this.curtains.length && !this.isOn) this.lower();
  }

  lift() {
    for (const win of this.windows().filter((w) => w && !w.isDestroyed())) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }
  }

  lower() {
    if (!this.holding) return;
    this.holding = false;
    for (const win of this.windows().filter((w) => w && !w.isDestroyed())) win.setAlwaysOnTop(false);
    this.emit('lowered');
  }

  /** A window of iBaila's made while the desk is clear: over the curtain too. */
  adopt(win) {
    if (!this.holding || !win || win.isDestroyed()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }
}

module.exports = { clearDesk: new ClearDesk() };
