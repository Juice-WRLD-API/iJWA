// The desktop player's window and the albums on its cards (DesktopPlayerController.swift, AlbumShelf.swift).
// The window sits on the desktop, under every app, and never takes focus except while search has the keys. It
// remembers where the user left it as a place on the screen — fractions of the display's usable area — so it
// lands in the same spot on whichever display it moves to.
const { screen, ipcMain, Menu, shell } = require('electron');
const settings = require('./settings');
const { fitAt } = require('./fit');
const { TOOL, openShared } = require('./windows');
const { follow, popup } = require('./drag');
const applemusic = require('./applemusic');
const { playInSpotify, playSpotifyURI, playInAppleMusic } = require('./players');
const { matches } = require('./names');
const { findLyrics, paced } = require('./lyrics');

const DEFAULT_PLACE = [0.5, 0.64]; // the Mac's (0.5, 0.36) from the bottom

/** The player's measurements at the user's size (DeskMetrics.swift). */
function metrics(size, fit = 1) {
  const s = (0.8 + 0.45 * size) * fit;
  const cardWidth = 232 * s, cardInset = 9 * s, coverSide = cardWidth - 2 * cardInset, captionHeight = 66 * s;
  const cardHeight = cardInset + coverSide + captionHeight;
  const carouselHeight = cardHeight + 44 * s;
  const edge = 40 * s;
  const height = edge + carouselHeight + 10 * s + 42 * s + 8 * s + 64 * s + edge;
  // Where the row of search and the switches stands, from the window's top (DeskMetrics.toolsTop).
  const toolsTop = edge + carouselHeight + 10 * s;
  return { s, width: Math.round(900 * s), height: Math.round(height), edge, toolsTop };
}

// ---- the playing artist's albums ---------------------------------------------------------------

const leadArtist = (artist) => require('./names').lead(artist);
const kindOf = (title) => (title.endsWith(' - Single') ? 'Single' : title.endsWith(' - EP') ? 'EP' : 'Album');
const display = (title) => title.replace(/ - (Single|EP)$/, '');
const plain = (text) => (text || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const same = (a, b) => Boolean(a) && (a.toLowerCase() === (b || '').toLowerCase() || plain(a) === plain(b));

/** Apple's full albums, oldest first; with fewer than four, the latest singles and EPs too. Their covers at `side`
 *  pixels: as large as a card shows them, not larger (each one is held decoded while it shows). */
function shelfFrom(page, side = 600) {
  const album = (item) => {
    const kind = kindOf(item.title);
    return { id: item.id, title: display(item.title), year: item.album, line: item.album ? `${item.album} · ${kind}` : kind,
      art: applemusic.artworkURL(item.artwork, side), isLoose: false };
  };
  let chosen = page.fullAlbums.map(album);
  if (chosen.length < 4) {
    const known = new Set(chosen.map((a) => a.id));
    chosen = chosen.concat(page.singles.filter((s) => !known.has(s.id)).map(album));
  }
  // Apple lists each shelf newest first; within a year, that order turned round.
  return chosen.map((a, i) => ({ a, i })).sort((x, y) => {
    const first = Number(x.a.year) || 0, second = Number(y.a.year) || 0;
    return first !== second ? first - second : y.i - x.i;
  }).map(({ a }) => a);
}

/** Whether an artist's page has this song among their best known, or its album, or an album of its name. */
function knows(page, song) {
  const title = plain(song.title), album = plain(song.album);
  return page.topSongs.some((s) => plain(s.title) === title)
    || page.albums.some((a) => [title, album].includes(plain(display(a.title))));
}

class AlbumShelf {
  artist = '';
  albums = [];
  playingIndex = null;
  shelved = [];
  playingAlbum = '';
  playingTitle = '';
  // A song from a browser's page: its artist's name may be only whoever uploaded it, so the shelf is the artist's
  // only when their page knows this song.
  unsure = null;
  // For such a song whose artist has no shelf to show: the songs its page plays next, as Continue Playing lists them —
  // something to go on with, rather than someone else's albums.
  alikeSongs = [];
  artistIDs = new Map();

  constructor(onChange) { this.onChange = onChange; }

  /** A new song: its album comes to the middle, and, when its artist is someone else, their albums take the shelf. */
  follow(track) {
    if (!track) return;
    // A song with no album (a SoundCloud upload) stands on its own card.
    this.playingAlbum = !track.album && track.source === 'web' ? track.title : track.album;
    this.playingTitle = track.title;
    this.unsure = track.source === 'web' ? { title: track.title, album: track.album } : null;
    this.playingArt = null;
    const lead = leadArtist(track.artist);
    if (lead.toLowerCase() !== this.artist.toLowerCase()) {
      this.artist = lead;
      this.shelved = [];
      this.arrange();
      this.load(lead);
    } else {
      this.arrange();
    }
  }

  async load(name) {
    // Apple's pages unread once (the network, a slow answer): asked again a moment later, once — the cards stood as the
    // playing song's album alone (Mac, 2026-10-10).
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 3000));
      if (this.artist.toLowerCase() !== name.toLowerCase()) return;
      const id = await this.artistID(name);
      if (!id) { console.log('[albums] no artist on Apple Music for', name); continue; }
      const page = await applemusic.artist(id);
      if (!page) { console.log('[albums]', name, "— page unread"); continue; }
      if (this.artist.toLowerCase() !== name.toLowerCase()) return;
      // Someone of the same name as the uploader: their albums aren't this song's.
      if (this.unsure && !knows(page, this.unsure)) return;
      this.shelved = shelfFrom(page, this.coverSide?.() || 600);
      console.log('[albums]', this.shelved.length, 'of', name);
      this.arrange();
      return;
    }
  }

  /** The songs a browser's page plays next, for the cards when its artist's albums can't be told. */
  offer(songs) {
    const offered = songs.slice(0, 15).map((song) => ({ id: song.id, title: song.title, year: '', line: song.artist,
      art: song.art || null, isLoose: false, link: song.link || null }));
    if (JSON.stringify(offered) === JSON.stringify(this.alikeSongs)) return;
    this.alikeSongs = offered;
    this.arrange();
  }

  async artistID(name) {
    const key = name.toLowerCase();
    if (this.artistIDs.has(key)) return this.artistIDs.get(key);
    const results = await applemusic.search(name);
    if (!results) return null;
    const found = results.artists.find((a) => a.title.toLowerCase() === key)
      || results.top.find((i) => i.kind === 'artist' && i.title.toLowerCase() === key) || results.artists[0];
    if (found) this.artistIDs.set(key, found.id);
    return found?.id || null;
  }

  /** The shelf with the playing song's album found on it, or standing in at the newest end. */
  arrange() {
    const alike = !this.shelved.length && this.unsure && this.alikeSongs.length;
    const list = (alike ? this.alikeSongs : this.shelved).slice();
    const wanted = this.playingAlbum;
    const song = require('./names').simple(this.playingTitle);
    let index = alike ? list.findIndex((a) => song && require('./names').whole(a.title).includes(song))
      : list.findIndex((a) => same(a.title, wanted) || same(a.title, display(wanted)));
    if (index < 0 && wanted) {
      list.push({ id: `loose:${wanted.toLowerCase()}`, title: display(wanted), year: '', line: kindOf(wanted), art: null, isLoose: true });
      index = list.length - 1;
    }
    this.albums = list;
    this.playingIndex = index >= 0 ? index : null;
    this.onChange({ artist: this.artist, albums: this.albums, playingIndex: this.playingIndex });
  }
}

// ---- the window --------------------------------------------------------------------------------

class DesktopPlayer {
  window = null;
  drag = null;

  constructor({ nowPlaying, preload, onHide, openSettings, artists }) {
    this.artists = artists; // the artist pages opened from search
    this.nowPlaying = nowPlaying;
    this.preload = preload;
    this.onHide = onHide;
    this.openSettings = openSettings;
    this.shelf = new AlbumShelf((shelf) => this.send('shelf', shelf));
    // A card's cover in the screen's own pixels, a little over, in steps of 50: 600 at most (memory, 2026-10-10).
    this.shelf.coverSide = () => {
      const m = this.metricsNow();
      const bounds = this.window && !this.window.isDestroyed() ? this.window.getBounds() : null;
      const scale = (bounds ? require('electron').screen.getDisplayMatching(bounds) : require('electron').screen.getPrimaryDisplay()).scaleFactor || 1;
      return Math.min(600, Math.max(200, Math.ceil((214 * m.s * scale * 1.1) / 50) * 50));
    };
    nowPlaying.on('track', (track) => this.shelf.follow(track));
    // The songs a browser's page plays next, for the cards when its artist's albums can't be told.
    nowPlaying.on('web-list', (songs) => this.shelf.offer(songs));
    nowPlaying.on('state', (state) => this.send('now', state));
    // The list view's songs: the ring as it stands, whenever a song joins or learns more of itself.
    for (const event of ['track', 'artwork', 'spotify-ids', 'playing']) nowPlaying.on(event, () => this.send('desk-history', nowPlaying.history.songs));

    ipcMain.on('desk-control', (_e, action, value) => this.control(action, value));
    ipcMain.on('desk-drag', (_e, phase) => this.dragPhase(phase));
    // Over the player or over its clear window (desktop.js's solidAt): clicks taken, or let through to the desktop.
    ipcMain.on('desk-solid', (event, on) => {
      if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) return;
      this.seeThrough = !on;
      this.window.setIgnoreMouseEvents(!on);
    });
    // The playing app's own volume, as the mixer shows it.
    ipcMain.handle('desk-volume', () => {
      // A page heard through the extension: its own loudness, as its slider shows it; not told yet, the browser's own
      // loudness in the mixer.
      const page = this.nowPlaying.track?.viaExtension ? require('./extension').extension.volume() : null;
      return page ?? require('./players').appVolume(this.nowPlaying.track?.app);
    });
    ipcMain.handle('desk-play-album', (_e, card) => this.playAlbum(card));
    // An album opened from its card: its songs, then one of them played on the album (AlbumSongs.swift).
    ipcMain.handle('desk-album-songs', (_e, card) => this.albumSongs(card));
    ipcMain.handle('desk-album-play', (_e, asked) => this.playInAlbum(asked));
    ipcMain.handle('desk-search', (_e, term) => this.search(term));
    ipcMain.handle('desk-search-play', (_e, item) => this.playSearched(item));
    // A song of search's results right-clicked: Play Next or Add to Queue where the song playing plays (QueueMenu.swift).
    ipcMain.on('desk-queue-menu', (_e, item) => require('./queuemenu').show(item, { queue: this.nowPlaying.queue, window: this.window,
      notify: (said) => this.send('desk-notice', said) }));
    ipcMain.on('desk-keys', (_e, on) => this.takeKeys(on));
    ipcMain.on('desk-open-artist', (_e, item) => this.artists?.open(item, metrics(settings.get().desktop.size, this.fit()).s));
    ipcMain.on('desk-close-artist', () => this.artists?.close());
    // The playing song's words, timed word by word (paced evenly when the source has no timing).
    ipcMain.handle('desk-lyrics', async () => {
      const track = this.nowPlaying.track;
      if (!track) return null;
      const found = await findLyrics(track);
      return { songID: track.id, title: track.title, artist: track.artist, duration: track.duration,
        status: found.status, lyrics: found.lyrics ? paced(found.lyrics, track.duration) : null };
    });
    // A new player page: the lists shelf, if open, shown in it again.
    ipcMain.on('desk-ready', () => require('./main-state').panel?.publishShelf());
    ipcMain.handle('desk-hello', () => ({ now: this.nowPlaying.snapshot(), history: this.nowPlaying.history.songs,
      shelf: { artist: this.shelf.artist, albums: this.shelf.albums, playingIndex: this.shelf.playingIndex },
      style: { ...settings.get(), fit: this.fit() } }));
    if (nowPlaying.track) this.shelf.follow(nowPlaying.track);

    // Where the user listens, chosen from the source button at the bar's left end.
    ipcMain.on('desk-choose', (_e, choice) => {
      // The one chosen already: nothing changes.
      if ((choice || null) === (settings.get().listenChoice || null)) return;
      settings.set({ listenChoice: choice || null });
      nowPlaying.choiceChanged();
    });
    // A song on its way waits in its own panel in the middle, the cards gone, until it plays or can't.
    nowPlaying.on('asked', (asked) => this.wait(asked));
    nowPlaying.on('asked-failed', (id) => this.failWaiting(id));
    nowPlaying.on('track', (track) => this.arrived(track));
    ipcMain.handle('desk-starting', () => this.startingNow());
  }

  // ---- a song on its way (StartingPanel.swift) ----

  /** `asked`: { title, artist, picture, any } — `any` for an album or an artist, ended by whichever song comes first. */
  wait(asked) {
    clearTimeout(this.startingTimer);
    this.starting = { ...asked, mark: this.nowPlaying.mark(), failed: false, since: Date.now(), from: this.nowPlaying.track?.id || '' };
    this.send('desk-starting', this.startingNow());
    // Already playing (picked again): nothing to wait for.
    if (!asked.any && this.nowPlaying.track && matches(this.nowPlaying.track, asked.title)) this.endWaiting(asked.id);
    this.startingTimer = setTimeout(() => this.failWaiting(asked.id), 14000);
  }

  startingNow() {
    const s = this.starting;
    return s ? { id: s.id, title: s.title, artist: s.artist, picture: s.picture || null, mark: s.mark, failed: s.failed, album: Boolean(s.album) } : null;
  }

  /** The song asked for has come — or, for an album, any new song: the panel goes, seen a moment at least. */
  arrived(track) {
    const s = this.starting;
    if (!s || !track || s.failed) return;
    if (s.any ? track.id === s.from : !matches(track, s.title)) return;
    this.endWaiting(s.id);
  }

  endWaiting(id) {
    const left = 900 - (Date.now() - (this.starting?.since || 0));
    setTimeout(() => {
      if (this.starting?.id !== id) return;
      clearTimeout(this.startingTimer);
      this.starting = null;
      this.send('desk-starting', null);
    }, Math.max(left, 0));
  }

  /** It couldn't start: the panel says so, then goes. */
  failWaiting(id) {
    if (!this.starting || this.starting.id !== id || this.starting.failed) return;
    clearTimeout(this.startingTimer);
    this.starting.failed = true;
    this.send('desk-starting', this.startingNow());
    setTimeout(() => { if (this.starting?.id === id) { this.starting = null; this.send('desk-starting', null); } }, 1800);
  }

  send(channel, value) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value); }

  control(action, value) {
    const np = this.nowPlaying;
    switch (action) {
      // Nothing holds the song any more — the browser closed, Spotify quit (a friend pressed Play with no browser open,
      // 2026-10-09): it is started afresh where it was played, the app or the browser opened for it.
      case 'toggle':
        if (np.track && !np.playing && !np.held) this.playSong(np.track);
        // Nothing followed yet, a site chosen: its tab plays on, or Continue Playing's first song starts.
        else if (!np.track && np.chosenSite) np.web.startSite();
        else np.togglePlayback();
        break;
      case 'like': np.likes.toggle(); break;
      case 'next': np.skipForward(); break;
      case 'previous': np.skipBack(); break;
      case 'repeat': np.cycleRepeat(); break;
      case 'clear': require('./cleardesk').clearDesk.toggle(); break;
      case 'seek': np.seek(value); break;
      case 'hide': settings.set({ desktop: { isOn: false } }); this.apply(); this.onHide?.(); break;
      case 'mini': settings.set({ desktop: { mini: Boolean(value) } }); this.styleChanged(); break;
      case 'lyricsCard': settings.set({ desktop: { hidesLyricsCard: Boolean(value) } }); this.styleChanged(); break;
      case 'open': this.openPlayer(); break;
      case 'volume':
        if (np.track?.viaExtension && require('./extension').extension.followed) require('./extension').extension.setVolume(Number(value));
        else require('./players').appVolume(np.track?.app, Number(value));
        break;
      case 'settings': this.openSettings?.(); break;
      case 'more': {
        const menu = Menu.buildFromTemplate([
          { label: this.openTitle(), click: () => this.openPlayer(), enabled: Boolean(np.track) },
          { label: 'Hide Desktop Player', click: () => this.control('hide') },
          { type: 'separator' },
          { label: 'Settings…', click: () => this.openSettings?.() },
        ]);
        popup(menu, this.window);
        break;
      }
      default: break;
    }
  }

  // ---- search ----

  /** The site listened on, searched itself (YouTube Music's catalog for YouTube too); anywhere else Apple's catalog,
   *  searched as Apple Music's own page does: no key, no account. Its pictures come through iBaila's own folder
   *  (covers.js), so a result shown again has its picture at once. */
  async search(term) {
    const site = this.nowPlaying.web.site;
    const found = site ? await require('./webmusic').search(term, site).catch(() => null) : await applemusic.search(term);
    if (!found) return null;
    const covers = require('./covers');
    const shape = (item) => ({ id: item.id, kind: item.kind, title: item.title, artist: item.artist, album: item.album, duration: item.duration,
      link: item.link || null, art: covers.local(applemusic.artworkURL(item.artwork, 300)) });
    return { top: found.top.map(shape), artists: found.artists.map(shape), albums: found.albums.map(shape), songs: found.songs.map(shape) };
  }

  /** A result picked: on the web, its own page opened; else played in Spotify, found there by its name — the song or
   *  album by its title and first artist, an artist by name — and its own Play button pressed. */
  async playSearched(item) {
    if (!item) return false;
    const id = this.nowPlaying.ask({ title: item.title, artist: item.artist, picture: item.art, any: item.kind !== 'song', album: item.kind === 'album' });
    const started = await this.startSearched(item);
    if (!started) this.nowPlaying.askFailed(id);
    return started;
  }

  async startSearched(item) {
    const bare = (text) => String(text || '').replace(/\s*[([].*?[)\]]/g, '').trim() || String(text || '');
    const lead = String(item.artist || '').split(/,| & | feat\. | ft\. | x | with /i)[0].trim();
    console.log('[search] play', item.kind, item.title, '-', item.artist);
    if (item.link || this.nowPlaying.web.site) return this.nowPlaying.web.play(item);
    // In Apple Music: found through its own search, played from its own pages.
    // The title whole: "Lucid Dreams (feat. Lil Uzi Vert) [Remix]" is another row than "Lucid Dreams".
    if (this.nowPlaying.inAppleMusic) return playInAppleMusic(item.kind === 'song' ? 'track' : item.kind, item.title, item.kind === 'artist' ? '' : lead);
    if (item.kind === 'artist') return playInSpotify('artist', item.title, '');
    return playInSpotify(item.kind === 'album' ? 'album' : 'track', bare(item.title), lead);
  }

  /** The player's measurements now, for windows placed over it. */
  metricsNow() { return metrics(settings.get().desktop.size, this.fit()); }

  /** While search is open the player takes the keys, and gives them back when it closes: it never takes them otherwise. */
  takeKeys(on) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.setFocusable(Boolean(on));
    if (on) this.window.focus();
  }

  /** An album from the cards, in the app the user listens in. Spotify is asked through its own search; Windows'
   *  Apple Music app can't be told yet. */
  async playAlbum(card) {
    if (!card || card.isLoose) return false;
    const id = this.nowPlaying.ask({ title: card.title, artist: card.link ? card.line : this.shelf.artist, picture: card.art,
      any: !card.link, album: !card.link });
    const started = await this.startAlbum(card);
    if (!started) this.nowPlaying.askFailed(id);
    return started;
  }

  async startAlbum(card) {
    // Where the user listens: the app chosen, else the one playing.
    const choice = this.nowPlaying.choice;
    const source = choice === 'spotify' ? 'spotify' : choice === 'appleMusic' ? 'music' : this.nowPlaying.track?.source;
    console.log('[desk] play album', card?.title, '| loose:', card?.isLoose, '| listening in:', source);
    if (!card || card.isLoose) return false;
    // A song standing in for albums plays by its page; an album is found on the site listened on.
    if (card.link || this.nowPlaying.web.site) {
      return this.nowPlaying.web.play(card.link ? { kind: 'song', title: card.title, artist: card.line, link: card.link }
        : { kind: 'album', title: card.title, artist: this.shelf.artist });
    }
    if (source === 'spotify') return playInSpotify('album', card.title, this.shelf.artist);
    if (this.nowPlaying.inAppleMusic) return playInAppleMusic('album', card.title, this.shelf.artist);
    return false;
  }

  // ---- an album opened ----

  /** An album's songs in their order, from its Apple Music page; one known only by its name, through Apple's search.
   *  Kept for the albums opened lately, so one opened again lists at once. */
  async albumSongs(card) {
    if (!card) return [];
    this.openedSongs = this.openedSongs || new Map();
    if (this.openedSongs.has(card.key)) return this.openedSongs.get(card.key);
    let songs = [];
    if (!card.isLoose) songs = await applemusic.albumSongs(card.key).catch(() => []);
    else {
      // Known only by its name: Apple's song search, the songs filed under it.
      try {
        const term = encodeURIComponent(`${card.title} ${this.shelf.artist}`);
        const response = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=50&country=${applemusic.STOREFRONT}`, { signal: AbortSignal.timeout(8000) });
        const name = require('./names').plainTitle(card.title);
        songs = ((await response.json()).results || []).filter((r) => require('./names').plainTitle(r.collectionName || '').startsWith(name))
          .sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0))
          .map((r) => ({ id: String(r.trackId), title: r.trackName, artist: r.artistName || '', album: r.collectionName || '',
            duration: (r.trackTimeMillis || 0) / 1000, art: (r.artworkUrl100 || '').replace('100x100', '300x300') || null }));
      } catch { songs = []; }
    }
    if (songs.length) {
      if (this.openedSongs.size >= 24) this.openedSongs.delete(this.openedSongs.keys().next().value);
      this.openedSongs.set(card.key, songs);
    }
    return songs;
  }

  /** A song of an album opened from its card, played on its album wherever the user listens, so the album goes on
   *  after it (NowPlaying.playInAlbum): YouTube Music and SoundCloud by the song's address in the album's list, Spotify's
   *  Web Player in the album itself, Spotify's app by the song's address (it plays it on its album page). Not found
   *  there as part of the album, the song plays on its own. */
  async playInAlbum({ songs, index, album, artist }) {
    const song = songs?.[index];
    if (!song) return false;
    // The row picked turns while it's on its way: the album stays open, no panel comes in its place.
    return this.startInAlbum(song, index, album, artist).catch((error) => { console.log('[album] failed:', error.message); return false; });
  }

  async startInAlbum(song, index, album, artist) {
    const np = this.nowPlaying;
    const webmusic = require('./webmusic');
    const lead = require('./names').lead(song.artist || artist);
    const site = np.web.site;
    console.log('[album] play', song.title, 'of', album, '| on', site || np.track?.source || np.choice || 'apple');
    if (site === 'youTubeMusic' || site === 'youTube') {
      const link = await webmusic.youTubeSongInAlbum(song.title, album, artist);
      if (link) return np.web.play({ kind: 'song', title: song.title, artist: song.artist, link });
    } else if (site === 'soundCloud') {
      const link = await webmusic.soundCloudSongInAlbum(song.title, album, artist);
      if (link) return np.web.play({ kind: 'song', title: song.title, artist: song.artist, link });
    } else if (site === 'spotifyWeb') {
      if (await np.web.playInSpotifyAlbum(song, album, artist)) return true;
    }
    if (site) return np.web.play({ kind: 'song', title: song.title, artist: song.artist });
    if (np.inAppleMusic) return playInAppleMusic('track', song.title, lead);
    // Spotify's app: the song found in the album itself, by its address — Spotify plays it on its album's page, the
    // album going on after it; else found by its name.
    const spotify = require('./spotifyweb');
    const albumID = await spotify.albumURI(album, artist).catch(() => null);
    if (albumID) {
      const { plainTitle } = require('./names');
      const found = (await spotify.albumSongs(albumID)).find((s) => plainTitle(s.title) === plainTitle(song.title));
      if (found) return playSpotifyURI(found.uri, song.title);
    }
    return playInSpotify('track', require('./webmusic').bare(song.title), lead);
  }

  /** A song from the list: one played in Spotify plays again by its Spotify address. */
  async playSong(song) {
    if (!song) return false;
    const id = this.nowPlaying.ask({ title: song.title, artist: song.artist,
      picture: song.artworkFile ? `ibaila://app/artwork/${song.artworkFile}` : null });
    const started = await this.startSong(song);
    if (!started) this.nowPlaying.askFailed(id);
    return started;
  }

  async startSong(song) {
    console.log('[desk] play song', song?.title, '|', song?.playKey);
    // A song heard on the web plays there again — Spotify's Web Player's too, by its Spotify ID, never in the app: by
    // the page it was opened from, else found again.
    if (song?.source === 'web') {
      const web = this.nowPlaying.web;
      const id = song.playKey?.startsWith('spotify:track:') ? song.playKey.split(':').pop() : null;
      const link = song.link || (id && song.site === 'spotifyWeb' ? `https://open.spotify.com/track/${id}` : null)
        || web.pages.get(require('./names').simple(song.title)) || null;
      return web.play({ kind: 'song', title: song.title, artist: song.artist, link });
    }
    if (song?.playKey?.startsWith('spotify:track:')) return playSpotifyURI(song.playKey, song.title);
    // One of the user's own songs: iBaila plays it again, in its folder's list if that is the one playing.
    if (song?.playKey?.startsWith('file:')) {
      return Boolean(require('./main-state').files?.playAgain({ id: song.playKey.slice(5), title: song.title, artist: song.artist,
        album: song.album, artworkFile: song.artworkFile || null }));
    }
    if (song?.source === 'spotify') return playInSpotify('track', song.title, song.artist);
    if (song?.source === 'music') return playInAppleMusic('track', song.title, require('./names').lead(song.artist));
    // A song heard on the web plays there again, by its page when it was opened from iBaila.
    if (song?.source === 'web' || this.nowPlaying.web.site) return this.nowPlaying.web.play({ kind: 'song', title: song.title, artist: song.artist, link: song.link || null });
    return false;
  }

  openTitle() {
    const source = this.nowPlaying.track?.source;
    return source === 'spotify' ? 'Open Spotify' : source === 'music' ? 'Open Apple Music' : 'Open Player';
  }

  /** Brings the app that plays forward. */
  openPlayer() {
    const track = this.nowPlaying.track;
    if (!track) return;
    if (track.source === 'spotify') { shell.openExternal('spotify:'); return; }
    if (process.platform === 'win32' && track.app.includes('!')) {
      // A Store app (Apple Music) is opened by its app ID.
      require('child_process').spawn('explorer.exe', [`shell:AppsFolder\\${track.app}`], { detached: true, stdio: 'ignore' }).unref();
    }
  }

  /** Shows, hides or resizes the player to match its settings. */
  apply() {
    const style = settings.get();
    if (!style.desktop.isOn || !style.isEnabled) { this.hide(); return; }
    const fit = this.fit();
    const m = metrics(style.desktop.size, fit);
    if (!this.window || this.window.isDestroyed()) { if (!this.opening) this.show(m); return; }
    // At a display scale like 125% Windows reports a size a pixel or two off: the window is resized only when it really
    // differs, and placed by the place kept in the settings, not by where Windows says it stands — centered on that,
    // the player crept down a pixel with every change of size (a friend's PC, 2026-10-09).
    const [w, h] = this.window.getSize();
    if (Math.abs(w - m.width) > 3 || Math.abs(h - m.height) > 3) {
      const area = this.workArea();
      const place = style.desktop.place || DEFAULT_PLACE;
      this.window.setBounds(this.clamped({ x: Math.round(area.x + area.width * place[0] - m.width / 2),
        y: Math.round(area.y + area.height * (place[1]) - m.height / 2), width: m.width, height: m.height }, area));
    }
    this.styleChanged();
  }

  styleChanged() { this.send('desk-style', { ...settings.get(), fit: this.fit() }); }

  /** How much the player shrinks on the display it's on (fit.js). */
  fit() { return fitAt(this.window && !this.window.isDestroyed() ? this.window.getBounds() : null); }

  show(m) {
    const frame = this.frameFor(m);
    this.opening = openShared('ibaila://app/desktop/desktop.html', {
      ...TOOL,
      ...frame, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false, focusable: false, alwaysOnTop: false,
      backgroundColor: '#00000000', title: 'iBaila',
      webPreferences: { preload: this.preload, backgroundThrottling: false, contextIsolation: true },
    }, (win) => {
      this.opening = null;
      this.window = win;
      require('./cleardesk').clearDesk.adopt(win);
      // Clear until the pointer is over the player itself (desktop.js's solidAt); feel() tells it where the pointer is.
      win.setIgnoreMouseEvents(true);
      this.seeThrough = true;
      this.feel();
      // IBAILA_SHOT draws the player unseen, for a picture of it, and shows nothing on the screen.
      if (!process.env.IBAILA_SHOT) win.once('ready-to-show', () => { win.showInactive(); });
      // The settings may have changed while it was on its way.
      this.apply();
    });
  }

  hide() {
    // The lists' shelf goes with the player.
    const panel = require('./main-state').panel;
    if (panel?.shelfOpen) panel.shelfOpen = false;
    this.opening?.();
    this.opening = null;
    clearTimeout(this.feeling);
    this.feeling = null;
    this.pointerAt = undefined;
    if (!this.window || this.window.isDestroyed()) return;
    const win = this.window;
    this.window = null;
    win.destroy();
  }

  // ---- the pointer, for the clear window ----
  // A see-through window hears nothing, and Windows' own word of the pointer moving over it (setIgnoreMouseEvents'
  // forward) never came on a friend's PC: the player stayed see-through and nothing on it took a click (2026-10-09).
  // That word came through a hook every mouse move on the computer passed through, games' too. Instead the pointer is
  // looked at here — 25 times a second near the player, 10 away from it — and the page is told where it is only while
  // the window lets clicks through and the pointer moves over it, or leaves it.
  feel() {
    if (this.feeling) return;
    const tick = () => {
      const win = this.window;
      if (!win || win.isDestroyed()) { this.feeling = null; return; }
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const dx = Math.max(b.x - p.x, p.x - (b.x + b.width - 1), 0);
      const dy = Math.max(b.y - p.y, p.y - (b.y + b.height - 1), 0);
      const inside = dx === 0 && dy === 0;
      const at = inside ? `${p.x - b.x},${p.y - b.y}` : null;
      if (at !== this.pointerAt) {
        this.pointerAt = at;
        // Taking clicks, the page hears the pointer itself; it's only told when the pointer is gone.
        if (this.seeThrough || !inside) this.send('desk-pointer', inside ? { x: p.x - b.x, y: p.y - b.y } : null);
      }
      this.feeling = setTimeout(tick, dx < 160 && dy < 160 ? 40 : 100);
    };
    this.feeling = setTimeout(tick, 40);
  }

  // ---- place ----

  workArea() {
    const b = this.window && !this.window.isDestroyed() ? this.window.getBounds() : null;
    const display = b ? screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) : screen.getPrimaryDisplay();
    return display.workArea;
  }

  frameFor(m) {
    const area = screen.getPrimaryDisplay().workArea;
    const place = settings.get().desktop.place || DEFAULT_PLACE;
    return this.clamped({ x: Math.round(area.x + area.width * place[0] - m.width / 2), y: Math.round(area.y + area.height * place[1] - m.height / 2),
      width: m.width, height: m.height }, area);
  }

  /** Kept on the screen — all but the clear margin round the cards and the bar, which may hang over its edge: held
   *  whole, a player let go low on the screen jumped back up by that margin. */
  clamped(frame, area = this.workArea()) {
    const e = Math.round(metrics(settings.get().desktop.size, fitAt(frame)).edge);
    return { ...frame,
      x: Math.round(Math.min(Math.max(frame.x, area.x - e), Math.max(area.x + area.width - frame.width + e, area.x - e))),
      y: Math.round(Math.min(Math.max(frame.y, area.y - e), Math.max(area.y + area.height - frame.height + e, area.y - e))) };
  }

  /** Empty space moves the player: the pointer is followed until it lets go, then the place is kept. */
  dragPhase(phase) {
    if (!this.window || settings.get().desktop.locked) return;
    if (phase === 'start') {
      this.drag?.end();
      this.drag = follow(this.window, () => this.dropped());
    } else if (this.drag) {
      this.drag.end();
    }
  }

  /** Let go: the place is kept as fractions of the display's usable area. */
  dropped() {
    this.drag = null;
    if (!this.window || this.window.isDestroyed()) return;
    const area = this.workArea();
    // At its own size, whatever Windows did to it on the way (drag.js).
    const m = metrics(settings.get().desktop.size, this.fit());
    const b = this.clamped({ ...this.window.getBounds(), width: m.width, height: m.height }, area);
    this.window.setBounds(b);
    settings.set({ desktop: { place: [(b.x + b.width / 2 - area.x) / area.width, (b.y + b.height / 2 - area.y) / area.height] } });
  }

}

module.exports = { DesktopPlayer, metrics, leadArtist };
