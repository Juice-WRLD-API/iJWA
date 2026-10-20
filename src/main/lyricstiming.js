// The song's words looked for by hand on Genius (DesktopPlayer.searchLyrics in iJWA's DesktopPlayer.swift): the one
// chosen is kept for the song and shown at once.
'use strict';

const { BrowserWindow, ipcMain, screen } = require('electron');
const genius = require('./genius');

const log = (...words) => console.log('[lyrics search]', ...words);

class LyricsTiming {
  window = null;
  chosen = null;   // what a pick in the panel does

  constructor({ nowPlaying, desktop, preload }) {
    this.nowPlaying = nowPlaying;
    this.desktop = desktop;
    this.preload = preload;
    ipcMain.on('desk-search-lyrics', () => this.searchLyrics());
    // The panel's searches: the song's own candidates (null), or the words typed.
    ipcMain.handle('lyrics-search', async (_e, text) => {
      const track = this.searchedFor;
      if (!track) return [];
      return (text == null ? await genius.candidates(track) : await genius.search(text)) || [];
    });
    ipcMain.on('lyrics-search-pick', (_e, url) => { const chosen = this.chosen; this.close(); chosen?.(url); });
    ipcMain.on('lyrics-search-close', () => this.close());
  }

  async searchLyrics() {
    const song = this.nowPlaying.track;
    if (!song) return;
    log('looking for words by hand:', song.title);
    await this.show(song, (url) => {
      log('picked', url, 'for', song.title);
      genius.picks.choose(url, song);
      this.desktop.send('desk-lyrics-again');
    });
  }

  /** The panel of Genius's songs for `song`, a pick handed to `chosen`: its window, once shown. */
  show(song, chosen) {
    this.searchedFor = song;
    this.chosen = chosen;
    const asked = genius.query(song, false);
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('lyrics-search-open', asked);
      this.window.show(); this.window.focus();
      return Promise.resolve(this.window);
    }
    const area = screen.getPrimaryDisplay().workArea;
    this.window = new BrowserWindow({
      width: 420, height: 470, x: Math.round(area.x + (area.width - 420) / 2), y: Math.round(area.y + (area.height - 470) / 2),
      frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      alwaysOnTop: true, show: false, title: 'Which song is this?', backgroundColor: '#141418',
      webPreferences: { preload: this.preload, contextIsolation: true },
    });
    const window = this.window;
    window.loadURL('ijwa://app/lyricsearch/search.html');
    window.on('closed', () => { if (this.window === window) { this.window = null; this.chosen = null; } });
    return new Promise((done) => window.once('ready-to-show', () => {
      window.webContents.send('lyrics-search-open', asked);
      window.show(); window.focus();
      done(window);
    }));
  }

  close() {
    this.chosen = null;
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }
}

module.exports = { LyricsTiming };
