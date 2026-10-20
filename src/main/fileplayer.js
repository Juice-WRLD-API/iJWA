// Plays the user's own songs — the folders they made playlists — in iBaila itself (FilePlayer.swift): the app
// playing elsewhere pauses first. A folder plays in its own order or shuffled, and every change is told to NowPlaying
// the way the apps' own players tell Windows theirs, with where the song is exact from the player itself. The sound
// is made in a window never shown (player/player.html).
const { ipcMain } = require('electron');
const fs = require('fs');
const artwork = require('./artwork');
const { TOOL, openShared } = require('./windows');

class FilePlayer {
  window = null;
  list = [];          // the songs playing, in their folder's order
  order = [];         // places in `list`, in the order they play
  place = 0;          // where in `order` the song playing is
  shuffle = false;
  repeat = 'off';     // off | one | all
  playing = false;
  position = 0;
  duration = 0;
  broken = new Set(); // songs whose files wouldn't open: skipped from then on
  loads = 0;

  constructor({ nowPlaying, preload }) {
    this.nowPlaying = nowPlaying;
    this.preload = preload;
    ipcMain.on('player-state', (event, state) => { if (this.window && event.sender === this.window.webContents) this.heard(state); });
    ipcMain.on('player-action', (_e, action, value) => {
      if (action === 'play') this.resume();
      if (action === 'pause') this.pause();
      if (action === 'nexttrack') this.skipForward();
      if (action === 'previoustrack') this.skipBack();
      if (action === 'seekto') this.seek(Number(value));
    });
  }

  get song() { return this.list[this.order[this.place]] || null; }
  get isActive() { return Boolean(this.song); }

  /** The hidden window the sound plays in, made when first needed. */
  host() {
    if (this.window && !this.window.isDestroyed()) return Promise.resolve(this.window);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve) => {
      openShared('ibaila://app/player/player.html', { ...TOOL, show: false, title: 'iBaila', skipTaskbar: true,
        webPreferences: { preload: this.preload, backgroundThrottling: false, contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' } }, (win) => {
        this.window = win;
        win.on('closed', () => { if (this.window === win) this.window = null; });
        win.webContents.once('did-finish-load', () => { this.opening = null; resolve(win); });
      });
    });
    return this.opening;
  }

  /** Plays `songs` from `index` on. */
  play(songs, index) {
    if (!songs?.[index]) return false;
    this.list = songs.slice();
    this.broken.clear();
    this.order = this.list.map((_, i) => i);
    if (this.shuffle) this.order = this.shuffled(index);
    this.place = this.order.indexOf(index);
    // One place plays: the app playing elsewhere pauses.
    const track = this.nowPlaying.track;
    if (track && track.source !== 'files' && this.nowPlaying.playing) this.nowPlaying.send(`pause-app ${track.app}`);
    this.start(true);
    return true;
  }

  /** A song again, as a card of the desktop player asks: in the list playing if it's there, else on its own. */
  playAgain(song) {
    const at = this.list.findIndex((s) => s.id === song.id);
    if (at >= 0) return this.play(this.list, at);
    if (!fs.existsSync(song.id)) return false;
    return this.play([song], 0);
  }

  shuffled(first) {
    const rest = this.list.map((_, i) => i).filter((i) => i !== first);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    return [first, ...rest];
  }

  async start(play, position = 0) {
    const song = this.song;
    if (!song) return;
    const id = `${++this.loads}`;
    this.loadedID = id;
    this.playing = play;
    this.position = position;
    this.duration = 0;
    this.picture = song.artworkFile && artwork.has(song.artworkFile) ? fs.readFileSync(artwork.file(song.artworkFile)) : null;
    this.tell(true);
    const win = await this.host();
    if (this.loadedID !== id) return;
    win.webContents.send('player-load', { id, url: `ibaila://app/song/${encodeURIComponent(song.id)}`, play, position,
      song: { title: song.title, artist: song.artist, album: song.album, art: song.artworkFile ? artwork.url(song.artworkFile) : null } });
  }

  /** The player's word: where the song is, whether it plays, and when it ends or won't open. */
  heard(state) {
    if (state.id !== this.loadedID) return;
    if (state.failed) {
      // A file that won't open is passed over; nothing left that opens, everything stops.
      this.broken.add(this.order[this.place]);
      if (this.broken.size >= this.list.length) { this.stop(); return; }
      this.skipForward(true);
      return;
    }
    if (state.ended) {
      if (this.repeat === 'one') { this.start(true); return; }
      const next = this.nextPlace();
      if (next == null) { this.place = 0; this.start(false); return; }   // the list played out: it waits at its start
      this.place = next;
      this.start(true);
      return;
    }
    this.playing = state.playing;
    this.position = state.position;
    if (state.duration) this.duration = state.duration;
    this.tell(false);
  }

  /** Tells NowPlaying, as the apps' players tell Windows. */
  tell(withPicture) {
    const song = this.song;
    if (!song) return;
    this.nowPlaying.update({ fromFiles: true, playKey: `file:${song.id}`, title: song.title, artist: song.artist, album: song.album, app: 'iBaila',
      playing: this.playing, position: this.position, duration: this.duration, shuffle: this.shuffle,
      repeat: { off: 'None', one: 'Track', all: 'List' }[this.repeat],
      can: { next: true, previous: true, seek: true, shuffle: true, repeat: true } }, withPicture ? this.picture : null);
  }

  command(action, value) { this.window?.webContents.send('player-command', { action, value }); }

  togglePlayback() { if (this.playing) this.pause(); else this.resume(); }
  resume() {
    if (!this.song) return;
    const track = this.nowPlaying.track;
    if (track && track.source !== 'files' && this.nowPlaying.playing) this.nowPlaying.send(`pause-app ${track.app}`);
    this.playing = true;
    this.command('play');
  }
  pause() { if (this.playing) { this.playing = false; this.command('pause'); } }

  skipForward(passing = false) {
    const next = this.nextPlace(passing);
    if (next == null) return;
    this.place = next;
    this.start(true);
  }

  /** Within the first few seconds the song before; later this one again from its start. */
  skipBack() {
    if (this.position > 3) { this.seek(0); return; }
    const before = this.placeBefore();
    if (before == null) { this.seek(0); return; }
    this.place = before;
    this.start(true);
  }

  seek(seconds) { if (Number.isFinite(seconds)) { this.position = seconds; this.command('seek', seconds); } }

  /** Shuffled, the song playing stays and the others follow in a new order; back in order, the list goes on from it. */
  setShuffle(on) {
    const now = this.order[this.place];
    this.shuffle = on;
    if (!this.list.length) return;
    this.order = on ? this.shuffled(now) : this.list.map((_, i) => i);
    this.place = this.order.indexOf(now);
    this.tell(false);
  }

  setRepeat(mode) { this.repeat = mode; this.tell(false); }

  /** The next place that plays after `from` (the song playing's, unless told): past the end, the first again when
   *  repeating the list, or `passing` a song that won't open. */
  nextPlace(passing = false, from = this.place) {
    for (let step = 1; step <= this.order.length; step++) {
      let at = from + step;
      if (at >= this.order.length) {
        if (this.repeat !== 'all' && !passing) return null;
        at %= this.order.length;
      }
      if (!this.broken.has(this.order[at])) return at;
    }
    return null;
  }

  placeBefore() {
    for (let at = this.place - 1; at >= 0; at--) if (!this.broken.has(this.order[at])) return at;
    return this.repeat === 'all' && this.order.length > 1 ? this.order.length - 1 : null;
  }

  // ---- the queue (FilePlayer.skip, remove, add, coming; 2026-10-12): what plays next, from the panel's Queue ----

  /** Plays the song `id` coming after the one playing, the order kept: whether it was coming. */
  skip(id) {
    let at = this.place;
    for (let next = this.nextPlace(false, at); next != null && next !== this.place; next = this.nextPlace(false, at)) {
      if (this.list[this.order[next]]?.id === id) {
        this.place = next;
        this.start(true);
        return true;
      }
      at = next;
    }
    return false;
  }

  /** The song `id` coming after the one playing taken out of what plays: whether it was coming. */
  remove(id) {
    if (this.place < 0 || this.place >= this.order.length) return false;
    const index = this.list.findIndex((s) => s.id === id);
    if (index < 0 || index === this.order[this.place]) return false;
    const at = this.order.indexOf(index);
    if (at < 0) return false;
    this.order.splice(at, 1);
    if (at < this.place) this.place -= 1;
    this.requeue();
    return true;
  }

  /** One of the user's songs played next, or after the rest of the list: whether it went in. */
  add(song, next) {
    if (this.place < 0 || this.place >= this.order.length || !song) return false;
    let index = this.list.findIndex((s) => s.id === song.id);
    if (index >= 0) {
      const at = this.order.indexOf(index);
      if (at >= 0 && at !== this.place) {
        this.order.splice(at, 1);
        if (at < this.place) this.place -= 1;
      }
    } else {
      this.list.push(song);
      index = this.list.length - 1;
    }
    this.order.splice(next ? this.place + 1 : this.order.length, 0, index);
    this.requeue();
    return true;
  }

  /** The order changed around the song playing. The Mac's player holds the next song queued behind it, made afresh
   *  here; this one loads a song at a time and asks for the next as one ends (`heard`), so nothing waits to be made
   *  again. */
  requeue() {}

  /** The songs coming after the one playing, up to `count`. */
  coming(count) {
    const songs = [];
    let at = this.place;
    for (let next = this.nextPlace(false, at); songs.length < count && next != null && next !== this.place; next = this.nextPlace(false, at)) {
      const song = this.list[this.order[next]];
      if (song) songs.push(song);
      at = next;
    }
    return songs;
  }

  /** Nothing left that can play: everything is let go. */
  stop() {
    this.command('stop');
    this.list = []; this.order = []; this.place = 0; this.playing = false;
    if (this.nowPlaying.track?.source === 'files') this.nowPlaying.forget();
    this.nowPlaying.changed();
  }
}

module.exports = { FilePlayer };
