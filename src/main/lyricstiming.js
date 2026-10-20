// The song's words looked for by hand on Genius, and timed to the song (DesktopPlayer.searchLyrics / timeLyrics /
// downloadVoiceModel in iJWA's DesktopPlayer.swift): the one chosen is kept for the song, shown at once, and — with
// the voice model downloaded — timed to the song (lyricsync.js). The first search offers the download, once (his call,
// 2026-10-12: "ilk seferde sorarsın, kullanıcı isterse indirir").
'use strict';

const { BrowserWindow, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const genius = require('./genius');
const synced = require('./syncedlyrics');
const sync = require('./lyricsync');

const log = (...words) => console.log('[lyrics timing]', ...words);

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

  /** A notice over the desktop's bar: { title, detail, progress, busy, symbol }, standing `seconds`. */
  notice(notice, seconds = 4, update = false) {
    this.desktop.send('desk-notice', { ...notice, seconds, update });
  }

  async searchLyrics() {
    const song = this.nowPlaying.track;
    if (!song) return;
    log('looking for words by hand:', song.title);
    const panel = await this.show(song, (url) => {
      genius.picks.choose(url, song);
      // Timed words kept from an earlier choice belong to that choice.
      synced.forget(song);
      this.desktop.send('desk-lyrics-again');
      this.timeLyrics(song, url);
    });
    if (!sync.isInstalled() && !sync.wasAsked()) {
      sync.setAsked(true);
      // Asked over the panel, which stands above every window: a question of its own, iJWA being behind the others
      // (the desktop's level), came up out of sight and the panel waited for it (the test PC, 2026-10-12).
      const { response } = await dialog.showMessageBox(panel, {
        type: 'question', buttons: ['Download', 'Not Now'], defaultId: 0, cancelId: 1, noLink: true,
        title: 'iJWA', message: 'Time lyrics to the song? (Beta)',
        detail: 'iJWA can listen to songs playing on YouTube, YouTube Music and SoundCloud and put their lyrics on time, on this PC. It needs a voice model, downloaded once (190 MB).',
      });
      log('voice model:', response === 0 ? 'download' : 'not now');
      if (response === 0) this.downloadVoiceModel();
    }
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

  downloadVoiceModel() {
    const downloading = (fraction) => ({ title: `Downloading the voice model… ${Math.round(fraction * 100)}%`, detail: '190 MB, once',
      progress: fraction, symbol: 'download' });
    this.notice(downloading(0), 600);
    let shown = 0;
    sync.download((fraction) => {
      // A step a percent: the download tells far more often than that.
      const percent = Math.floor(fraction * 100);
      if (percent === shown) return;
      shown = percent;
      this.notice(downloading(fraction), 600, true);
    }).then((done) => {
      this.notice(done ? { title: 'Voice model ready', detail: 'Search lyrics to time them to the song.' }
        : { title: "The voice model didn't download", detail: 'Try again from Search lyrics.' }, 5);
      if (!done) sync.setAsked(false);
    });
  }

  /** The words chosen, timed to the song as it plays in the browser, kept and shown once timed. */
  async timeLyrics(song, url) {
    log('picked', url, 'for', song.title);
    if (!sync.isInstalled()) return;
    const sites = ['youTubeMusic', 'youTube', 'soundCloud'];
    const extension = require('./extension').extension;
    // The page followed, else the one that says it plays this song (another site than the one chosen isn't followed).
    const find = () => (extension.followed && sites.includes(extension.followed.site) ? extension.followed : null)
      || extension.pagePlaying(song.title, sites);
    let page = song.source === 'web' ? find() : null;
    // The browser's extension not back yet — iJWA just started again, and the browser lets its extension sleep: it
    // came back 20 s to 4 min later on the test PC (2026-10-12), and a pick meanwhile was never timed. Waited for, a
    // minute at most.
    if (song.source === 'web' && !page) {
      this.notice({ title: 'Waiting for the browser…', detail: 'Its iJWA extension comes back in a moment', busy: true, symbol: 'waveform' }, 70);
      for (let waited = 0; waited < 60 && !page; waited++) {
        await new Promise((done) => setTimeout(done, 1000));
        page = find();
      }
      log('waited for the page:', page ? page.site : 'none came');
    }
    if (song.source !== 'web' || !page) {
      log("can't hear it:", song.source, extension.followed?.site || 'no page followed');
      this.notice({ title: 'Lyrics are timed on YouTube and SoundCloud', detail: "This song plays where iJWA can't hear it." }, 5);
      return;
    }
    this.notice({ title: 'Timing the lyrics to the song…', detail: 'On this PC, a few seconds', busy: true, symbol: 'waveform' }, 300);
    const words = await genius.lyrics(url);
    if (!words) { this.notice({ title: "Couldn't time the lyrics", detail: "Genius didn't answer." }, 5); return; }
    // Heard before: timed again at once, without listening.
    let outcome;
    const kept = synced.heard(song);
    if (kept) {
      const lines = words.lines.map((line) => line.text.trim()).filter(Boolean);
      outcome = { timed: require('./lyricsync-align').align(lines, kept.words, kept.voiced, kept.length), heard: kept.words, voiced: kept.voiced, length: kept.length };
    } else {
      outcome = await sync.time(words, page);
    }
    if (outcome.timed) {
      synced.save(outcome.timed, outcome.heard, outcome.voiced, outcome.length, song);
      this.notice({ title: 'Lyrics on time', detail: '' }, 3);
      if (this.nowPlaying.track?.id === song.id) this.desktop.send('desk-lyrics-again');
    } else {
      const why = outcome.why || 'it went wrong';
      log("couldn't time:", why);
      this.notice({ title: "Couldn't time the lyrics", detail: `${why[0].toUpperCase()}${why.slice(1)}.` }, 6);
    }
  }
}

module.exports = { LyricsTiming };
