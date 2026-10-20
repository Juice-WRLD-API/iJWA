// An artist's page in a window of its own over the player (ArtistWindowController in ArtistWindow.swift): opened from
// search, its bottom edge just above the search over the player's bar, so the bar still shows what plays. It takes
// the keys while open (Escape closes it); everything on it plays in Spotify.
const { screen, ipcMain } = require('electron');
const { openShared } = require('./windows');
const applemusic = require('./applemusic');
const covers = require('./covers');
const { playInSpotify, playInAppleMusic } = require('./players');

class ArtistWindow {
  window = null;
  item = null;
  s = 1;

  constructor({ nowPlaying, preload, player }) {
    this.nowPlaying = nowPlaying;
    this.preload = preload;
    this.player = player; // () => { window, metrics }
    ipcMain.handle('artist-hello', () => ({ item: this.item, s: this.s, now: this.nowSong() }));
    ipcMain.handle('artist-page', (_e, id) => this.page(id));
    ipcMain.handle('artist-play', (_e, request) => this.play(request));
    ipcMain.on('artist-close', () => this.close());
    nowPlaying.on('track', () => this.send('artist-now', this.nowSong()));
    // Its glass's bars move only while the song plays.
    nowPlaying.on('playing', () => this.send('artist-now', this.nowSong()));
  }

  get isOpen() { return Boolean(this.window && !this.window.isDestroyed()); }
  send(channel, value) { if (this.isOpen) this.window.webContents.send(channel, value); }
  nowSong() { const t = this.nowPlaying.track; return t ? { title: t.title, artist: t.artist, playing: Boolean(this.nowPlaying.playing) } : null; }

  /** Opens the artist (an item from search), or shows them in the window already open. */
  open(item, s) {
    console.log('[artist] open', item.title);
    this.item = { id: item.id, title: item.title, art: item.art || null, link: item.link || null };
    this.s = s;
    if (this.isOpen) { this.send('artist-scale', s); this.send('artist-show', this.item); this.window.focus(); return; }
    // On its way already: the page asks for the artist when it's there.
    if (this.opening) return;
    const { width, height } = this.size();
    const { window: player } = this.player();
    this.opening = openShared('ibaila://app/artist/artist.html', {
      // Owned by the player, it always stands in front of it, even as the player is clicked.
      ...(player && !player.isDestroyed() ? { parent: player } : {}),
      ...this.place(width, height), frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000', title: 'iBaila',
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      webPreferences: { preload: this.preload, contextIsolation: true },
    }, (win) => {
      this.opening = null;
      if (!process.env.IBAILA_SHOT) win.once('ready-to-show', () => { win.show(); win.focus(); });
      win.on('closed', () => { if (this.window === win) this.window = null; });
      this.window = win;
      require('./cleardesk').clearDesk.adopt(win);
    });
  }

  /** The page's size: 880 by 470 at the player's scale, and the margin its shadow falls into. */
  size() { return { width: Math.round(880 * this.s + 20 * this.s), height: Math.round(470 * this.s + 20 * this.s) }; }

  place(width, height) {
    const { window: player, metrics } = this.player();
    const bounds = player && !player.isDestroyed() ? player.getBounds() : null;
    const area = (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workArea;
    let x = area.x + (area.width - width) / 2, y = area.y + (area.height - height) / 2;
    if (bounds && metrics) {
      x = bounds.x + bounds.width / 2 - width / 2;
      y = bounds.y + metrics.toolsTop - 2 * metrics.s - height;
    }
    x = Math.min(Math.max(x, area.x), Math.max(area.x + area.width - width, area.x));
    y = Math.min(Math.max(y, area.y), Math.max(area.y + area.height - height, area.y));
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  /** Sinks a little and fades away. */
  close() {
    this.opening?.();
    this.opening = null;
    if (!this.isOpen) return;
    const win = this.window;
    this.window = null;
    win.webContents.send('artist-leaving');
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 260);
  }

  /** The artist's page from Apple Music — or from YouTube Music or SoundCloud, for an artist found there — its pictures
   *  through iBaila's own folder. */
  async page(id) {
    const webmusic = require('./webmusic');
    const item = this.item?.id === id ? this.item : { id, title: '' };
    const found = webmusic.siteOf(item) ? await webmusic.artistPage(item).catch(() => null) : await applemusic.artist(id);
    if (!found) return null;
    const art = (artwork, side) => covers.local(applemusic.artworkURL(artwork, side));
    return {
      name: found.name, bio: found.bio, art: art(found.artwork, 600), shuffle: found.shuffle || null,
      topSongs: found.topSongs.map((song) => ({ id: song.id, title: song.title, album: song.album, duration: song.duration, isExplicit: song.isExplicit,
        art: art(song.artwork, 120), link: song.link || null })),
      albums: found.albums.map((album) => ({ id: album.id, title: album.title, album: album.album, art: art(album.artwork, 300), link: album.link || null })),
      similar: found.similar.map((other) => ({ id: other.id, title: other.title, art: art(other.artwork, 200), link: other.link || null })),
    };
  }

  /** Plays what was picked in Spotify: a song or album by its name and the artist's, or the artist, shuffled if asked. */
  async play(request) {
    if (!request) return false;
    // The player shows it on its way, in the middle: a song by its name; the artist or an album until any song comes.
    const id = this.nowPlaying.ask({ title: request.title,
      artist: request.kind === 'artist' ? (request.shuffle ? 'Shuffle' : 'Top Songs') : request.artist || this.item?.title || '',
      picture: request.art || (request.kind === 'artist' ? this.item?.art : null) || null,
      any: request.kind !== 'track' && request.kind !== 'song', album: request.kind === 'album' });
    const started = await this.start(request);
    if (!started) this.nowPlaying.askFailed(id);
    return started;
  }

  async start(request) {
    const bare = (text) => String(text || '').replace(/\s*[([].*?[)\]]/g, '').trim() || String(text || '');
    console.log('[artist] play', request.kind, request.title, request.shuffle ? '(shuffled)' : '');
    // On the web, by the page found there: the artist shuffled by YouTube Music's own shuffle list, else from their
    // best known song on.
    const web = this.nowPlaying.web;
    if (request.link || request.shuffleLink || request.topLink || web.site) {
      if (request.kind === 'artist') {
        const link = request.shuffle ? request.shuffleLink || request.topLink : request.topLink || request.shuffleLink;
        return web.play({ kind: 'artist', title: request.title, link: link || null });
      }
      return web.play({ kind: request.kind === 'album' ? 'album' : 'song', title: request.title, artist: request.artist, link: request.link || null });
    }
    // In Apple Music: through its own search and pages.
    if (this.nowPlaying.inAppleMusic) {
      return playInAppleMusic(request.kind === 'artist' ? 'artist' : request.kind === 'album' ? 'album' : 'track', request.title,
        request.kind === 'artist' ? '' : request.artist || this.item?.title || '');
    }
    if (request.kind === 'artist') {
      const ok = await playInSpotify('artist', request.title, '');
      if (ok && request.shuffle && !this.nowPlaying.shuffle) setTimeout(() => this.nowPlaying.toggleShuffle(), 1500);
      return ok;
    }
    return playInSpotify(request.kind === 'album' ? 'album' : 'track', bare(request.title), request.artist);
  }
}

module.exports = { ArtistWindow };
