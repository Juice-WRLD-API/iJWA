// The see-through playlist on the desktop (PlaylistPanelController in PlaylistPanel.swift): a header with the
// list's covers and name, then its songs, the whole of it turned away in 3D like the lists in a story. It lists
// Continue Playing — for someone in Spotify, songs like the one playing, each by its Spotify ID so Spotify can
// play it, or the songs played there lately; on YouTube Music or SoundCloud, what the site plays next — or one of
// the folders of their own songs the user made playlists, which iBaila plays itself — or the Queue, what plays next
// where they listen (playqueue.js). It stays where the user leaves it.
const { screen, ipcMain, Menu, clipboard, shell, dialog } = require('electron');
const settings = require('./settings');
const { fitAt } = require('./fit');
const { TOOL, openShared } = require('./windows');
const { follow, popup } = require('./drag');
const artwork = require('./artwork');
const covers = require('./covers');
const wallpaper = require('./wallpaper');
const { SpotifyList, plain } = require('./spotifyweb');
const { playSpotifyURI, playInSpotify } = require('./players');
const { WebList } = require('./weblist');
const { CatalogList } = require('./cataloglist');
const { NAMES } = require('./nowplaying');
const { WebPlaylists } = require('./webplaylists');
const { simple, same } = require('./names');
const { NOTICES, videoOf } = require('./playqueue');

const LISTED_SITES = new Set(['youTubeMusic', 'soundCloud', 'spotifyWeb']);
/** A site's name as a site: Spotify's Web Player is "Spotify" there. */
const SITE_NAMES = { youTubeMusic: 'YouTube Music', soundCloud: 'SoundCloud', spotifyWeb: 'Spotify' };
const LIKED = new Set(['LM', 'likes', 'spotify:collection:tracks']);
const shared = require('./main-state');

/** The panel's measurements at the user's size, songs shown and tilt (PlaylistMetrics). */
function metrics(style, fit = 1) {
  const s = (0.8 + 0.5 * style.size) * fit;
  const width = 300 * s, headerHeight = 66 * s, gap = 8 * s, rowHeight = 50 * s;
  const listHeight = style.rows * rowHeight;
  const stage = { width, height: headerHeight + gap + listHeight };
  const margin = 24;
  return { s, width, headerHeight, gap, rowHeight, listHeight, stage, margin,
    window: { width: Math.ceil(stage.width + 2 * margin), height: Math.ceil(stage.height + 2 * margin) } };
}

class PlaylistPanel {
  window = null;
  mode = 'continuePlaying';
  suggestedFor = null;
  drag = null;
  starting = null;   // the song clicked, from then until it plays: { id, title }
  notice = null;     // a word in place of the subtitle for a moment: { text, until }

  constructor({ nowPlaying, preload }) {
    this.nowPlaying = nowPlaying;
    this.preload = preload;
    this.spotify = new SpotifyList(() => this.publish(), () => this.spotifySongs());
    // On the web: the site's own next songs, offered to the player's cards too when the artist's albums can't be told.
    this.web = new WebList(() => { this.publish(); nowPlaying.emit('web-list', this.web.songs); });
    // In Apple Music: songs like the one playing from Apple's own artist pages, or the songs played there lately.
    this.catalog = new CatalogList(() => this.publish(), () => this.musicSongs());
    // The user's own lists on the site they listen on (WebPlaylists.swift).
    this.lists = new WebPlaylists(() => { this.publish(); this.publishShelf(); });
    this.lists.inSpotifyApp = () => this.inSpotifyApp;
    // The folders of the user's own songs: the one shown last is shown again.
    this.folders = shared.folders;
    this.folders?.on('change', () => this.publish());
    if (this.folders?.current) { this.mode = 'folder'; this.folders.read(this.folders.currentId); }
    else if (require('./settings').get().playlistMode === 'webPlaylist' && this.lists.current) this.mode = 'webPlaylist';
    else if (require('./settings').get().playlistMode === 'queue') this.mode = 'queue';
    // The Queue: read when shown, and again for every other song, or another place it plays from.
    this.queue = nowPlaying.queue;
    this.queue.on('change', () => this.publish());
    if (this.mode === 'queue') this.queue.refresh(true);
    ipcMain.on('panel-drop', (_e, paths) => this.addFolders(Array.isArray(paths) ? paths : []));
    nowPlaying.on('state', () => { this.publish(); this.followSite(); if (this.mode === 'queue') this.queue.refresh(); });
    wallpaper.on('change', () => this.publish());
    nowPlaying.on('spotify-ids', () => this.carryOn(false));
    nowPlaying.on('track', () => setTimeout(() => this.carryOn(false), 300));
    nowPlaying.on('playing', () => this.carryOn(false));

    ipcMain.handle('panel-hello', () => this.model());
    ipcMain.on('panel-play', (_e, index) => this.play(index));
    // A playlist chosen, played from its first song, so the list goes on after it; its song playing — or paused —
    // paused or resumed instead.
    ipcMain.on('panel-play-list', () => {
      if (this.model().playing != null) this.nowPlaying.togglePlayback();
      else this.play(0);
    });
    ipcMain.on('panel-refresh', () => this.refresh());
    ipcMain.on('panel-header', () => this.openLists());
    // The shelf of lists in the player's middle (PlaylistShelf): a pick, a folder's own menu, closed.
    ipcMain.on('lists-pick', (_e, id) => { this.shelfOpen = false; this.publishShelf(); this.pickFromShelf(id); });
    ipcMain.on('lists-menu', (_e, id) => this.shelfMenu(id));
    ipcMain.on('lists-close', () => { this.shelfOpen = false; this.publishShelf(); });
    ipcMain.on('panel-song-menu', (_e, index) => this.songMenu(index));
    ipcMain.on('panel-drag', (_e, phase) => this.dragPhase(phase));
    this.carryOn(true);
  }

  get style() { return settings.get().playlist; }
  fit() { return fitAt(this.window && !this.window.isDestroyed() ? this.window.getBounds() : null); }
  get inSpotify() { return this.mode === 'continuePlaying' && !this.onWeb && !this.inMusic; }
  /** Continue Playing for someone listening on YouTube Music or SoundCloud; Spotify's Web Player's is Spotify's. */
  get onWeb() { return this.mode === 'continuePlaying' && Boolean(this.nowPlaying.web.site) && this.nowPlaying.web.site !== 'spotifyWeb'; }
  /** Listening on Spotify's Web Player: its songs, by their Spotify IDs, play there. */
  get onSpotifyWeb() { return this.nowPlaying.web.site === 'spotifyWeb'; }
  /** The music site listened on, whose own lists the shelf offers; in Spotify's app, its Web Player's — the same
   *  account's, read in the browser where it's signed in (his point, Mac, 2026-10-10). */
  get listSite() {
    const site = this.nowPlaying.web.site;
    if (LISTED_SITES.has(site)) return site;
    const np = this.nowPlaying;
    if (np.choice === 'spotify' || (!np.choice && np.track?.source === 'spotify')) return 'spotifyWeb';
    return null;
  }
  /** Spotify's app listened in. */
  get inSpotifyApp() { const np = this.nowPlaying; return np.choice === 'spotify' || (!np.choice && np.track?.source === 'spotify'); }
  /** Continue Playing for someone listening in Apple Music. */
  get inMusic() { return this.mode === 'continuePlaying' && !this.onWeb && this.nowPlaying.inAppleMusic; }

  send(channel, value) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value); }

  // ---- what it lists ----

  /** In Continue Playing, a song playing from outside the list brings songs like it; songs played from the list
   *  carry on as they are. With nothing playing, it lists the songs played in Spotify lately. */
  carryOn(again) {
    if (this.mode !== 'continuePlaying') return;
    if (this.onWeb) { this.carryOnOnWeb(again); return; }
    if (this.inMusic) { this.carryOnInMusic(again); return; }
    const track = this.nowPlaying.track;
    const list = this.spotify;
    // A Spotify song: its app's, or its Web Player's, known by its Spotify ID.
    const spotifySong = track && (track.source === 'spotify' || (track.source === 'web' && String(track.playKey || '').startsWith('spotify:track:')));
    if (!spotifySong || !this.nowPlaying.playing) {
      if (again || list.madeFor == null) { this.suggestedFor = null; list.recall(this.spotifySongs()); }
      return;
    }
    if (!again && this.suggestedFor === track.id) return;
    this.suggestedFor = track.id;
    const listed = list.songs.some((s) => s.id === track.playKey || same(track.title, track.artist, s));
    if (listed && !again) return;
    console.log('[panel] songs like', track.title);
    list.suggest(track);
  }

  /** On YouTube Music or SoundCloud: what the site plays next, made again when a song from outside the list starts.
   *  Paused or between songs, the list stays. */
  carryOnOnWeb(again) {
    const track = this.nowPlaying.track;
    if (!track || track.source !== 'web') return;
    if (!again && this.suggestedFor === track.id) return;
    this.suggestedFor = track.id;
    if (this.web.rowOf(track) >= 0 && !again) return;
    this.web.suggest(track);
  }

  /** In Apple Music: a song playing brings songs like it, unless it is one of the list's; with nothing playing, the
   *  songs played there lately. */
  carryOnInMusic(again) {
    const track = this.nowPlaying.track;
    const list = this.catalog;
    if (!track || track.source !== 'music' || !this.nowPlaying.playing) {
      if (again || list.madeFor == null) { this.suggestedFor = null; list.recall(); }
      return;
    }
    if (!again && this.suggestedFor === track.id) return;
    this.suggestedFor = track.id;
    const listed = list.songs.some((s) => same(track.title, track.artist, s));
    if (listed && !again && !list.isRecent) return;
    list.suggest(track);
  }

  /** The songs played in Apple Music, newest first, one version each. */
  musicSongs() {
    const versions = new Set();
    return this.nowPlaying.history.songs
      .filter((s) => s.source === 'music' && s.lastPlayed && s.artist)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .filter((s) => { const key = `${plain(s.title)}|${s.artist.toLowerCase()}`; if (versions.has(key)) return false; versions.add(key); return true; })
      .map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album || '', cover: s.artworkFile ? artwork.url(s.artworkFile) : null }));
  }

  /** The songs played in Spotify, newest first, one version each: the ones iBaila can play there again. */
  spotifySongs() {
    const versions = new Set();
    return this.nowPlaying.history.songs
      .filter((s) => s.source === 'spotify' && s.lastPlayed)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .filter((s) => { const key = `${plain(s.title)}|${s.artist.toLowerCase()}`; if (versions.has(key)) return false; versions.add(key); return true; });
  }

  /** The Spotify song the refresh finds songs like: the one playing, else the one the list is like, else the last played. */
  get seed() {
    const track = this.nowPlaying.track;
    // A Spotify song: its app's, or its Web Player's, known by its Spotify ID.
    const spotifySong = track && (track.source === 'spotify' || (track.source === 'web' && String(track.playKey || '').startsWith('spotify:track:')));
    if (spotifySong && this.nowPlaying.playing) return track;
    if (this.spotify.seed) return this.spotify.seed;
    const last = this.spotifySongs()[0];
    return last ? { ...last, id: last.id } : null;
  }

  refresh() {
    if (this.mode === 'queue') { this.queue.refresh(true); return; }
    if (this.mode === 'webPlaylist') { this.lists.reload(); return; }
    if (this.mode !== 'continuePlaying') return;
    if (this.onWeb) {
      const track = this.nowPlaying.track;
      const seed = track?.source === 'web' ? track : this.web.seed;
      if (seed) this.web.refresh(seed);
      return;
    }
    if (this.inMusic) {
      const seed = this.musicSeed;
      if (seed) this.catalog.refresh(seed);
      return;
    }
    const seed = this.seed;
    if (seed) this.spotify.refresh(seed);
  }

  /** What every list's model shares: the panel's style, and the wallpaper for its glass to frost. */
  frame() {
    const display = this.window && !this.window.isDestroyed() ? screen.getDisplayMatching(this.window.getBounds()).bounds : screen.getPrimaryDisplay().bounds;
    return { style: { ...this.style, fit: this.fit() }, frost: wallpaper.url(), display, frostAmount: settings.get().desktop.frost };
  }

  noticeNow() { return this.notice && this.notice.until > Date.now() ? this.notice.text : null; }

  /** A folder of the user's own songs, played by iBaila itself. */
  folderModel() {
    const folder = this.folders?.current;
    const track = this.nowPlaying.track;
    const songs = (folder?.songs || []).map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album,
      cover: s.artworkFile ? artwork.url(s.artworkFile) : null }));
    const progress = this.folders?.progress;
    const subtitle = this.noticeNow() || (this.folders?.isMissing ? 'This folder can’t be found'
      : progress ? `Reading songs… ${progress.done} of ${progress.total}`
      : songs.length ? `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}` : 'No songs in this folder');
    const at = track?.source === 'files' ? songs.findIndex((s) => `file:${s.id}` === track.playKey) : -1;
    const playingArt = this.nowPlaying.snapshot().artwork;
    return { ...this.frame(), title: folder?.name || 'Folder', subtitle, songs, playing: at >= 0 ? at : null, starting: false,
      inPlace: true, canPlay: songs.length > 0, listPlaying: at >= 0 && Boolean(this.nowPlaying.playing),
      isAlive: at >= 0 && Boolean(this.nowPlaying.playing), artwork: at >= 0 ? playingArt || songs[at].cover : null,
      canRefresh: false, isRefreshing: false };
  }

  /** The Apple Music song the refresh finds songs like: the one playing, else the one the list is like, else the last
   *  one played there. */
  get musicSeed() {
    const track = this.nowPlaying.track;
    if (track?.source === 'music' && this.nowPlaying.playing) return track;
    if (this.catalog.seed) return this.catalog.seed;
    const last = this.nowPlaying.history.songs.filter((s) => s.source === 'music' && s.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
    return last ? { ...last } : null;
  }

  /** Songs like the one playing in Apple Music, or the songs played there lately. */
  musicModel() {
    const track = this.nowPlaying.track;
    if (this.starting && track?.source === 'music' && this.nowPlaying.playing && plain(track.title) === plain(this.starting.title)) this.starting = null;
    const list = this.catalog;
    const playingArt = this.nowPlaying.snapshot().artwork;
    const songs = list.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album,
      cover: (s.cover && (s.cover.startsWith('ibaila:') ? s.cover : covers.local(s.cover))) || (track && plain(s.title) === plain(track.title) ? playingArt : null) }));
    const subtitle = this.noticeNow() || (list.isLoading && !songs.length ? 'Finding songs…'
      : list.isRecent ? (songs.length ? 'Recently played in Apple Music' : 'Songs you play in Apple Music come here')
      : songs.length ? `Songs like ${list.seedTitle}` : 'Play a song in Apple Music');
    const asked = this.starting ? songs.findIndex((s) => s.id === this.starting.id) : -1;
    const row = track?.source === 'music' ? songs.findIndex((s) => same(track.title, track.artist, s)) : -1;
    const at = asked >= 0 ? asked : row >= 0 ? row : null;
    return { ...this.frame(), title: 'Continue Playing', subtitle, songs, playing: at, starting: asked >= 0,
      isAlive: asked < 0 && Boolean(this.nowPlaying.playing),
      artwork: asked >= 0 ? songs[asked].cover : playingArt || (at != null ? songs[at].cover : null),
      canRefresh: Boolean(this.musicSeed), isRefreshing: list.isLoading };
  }

  /** What the site plays next, on YouTube Music or SoundCloud. */
  webModel() {
    const track = this.nowPlaying.track;
    if (this.starting && track?.source === 'web' && this.nowPlaying.playing && plain(track.title) === plain(this.starting.title)) this.starting = null;
    const list = this.web;
    const playingArt = this.nowPlaying.snapshot().artwork;
    const songs = list.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album,
      cover: covers.local(s.cover) || (track && plain(s.title) === plain(track.title) ? playingArt : null) }));
    const site = NAMES[list.site] || 'the web';
    const subtitle = this.noticeNow() || (!songs.length ? (list.isLoading ? 'Finding songs…' : 'Play a song on YouTube Music or SoundCloud')
      : !list.seedTitle ? `Up next on ${site}` : `Songs like ${list.seedTitle}`);
    const asked = this.starting ? songs.findIndex((s) => s.id === this.starting.id) : -1;
    const row = track?.source === 'web' ? list.rowOf(track) : -1;
    const at = asked >= 0 ? asked : row >= 0 ? row : null;
    const seed = track?.source === 'web' ? track : list.seed;
    return { ...this.frame(), title: 'Continue Playing', subtitle, songs, playing: at, starting: asked >= 0,
      isAlive: asked < 0 && Boolean(this.nowPlaying.playing),
      artwork: asked >= 0 ? songs[asked].cover : playingArt || (at != null ? songs[at].cover : null),
      canRefresh: Boolean(seed), isRefreshing: list.isLoading };
  }

  /** What plays next where the user listens (PlayQueue): the song playing among it, where it stands. */
  queueModel() {
    const queue = this.queue;
    const playingArt = this.nowPlaying.snapshot().artwork;
    // A song of the user's own carries its own picture, as in its folder's list.
    const songs = queue.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album,
      cover: s.artworkFile ? artwork.url(s.artworkFile) : covers.local(s.artwork) || null }));
    const subtitle = this.noticeNow() || (queue.isLoading && !songs.length ? 'Reading the queue…' : queue.note);
    const at = queue.songs.findIndex((s) => s.isCurrent);
    return { ...this.frame(), title: 'Queue', subtitle, songs, playing: at >= 0 ? at : null, starting: false,
      inPlace: true, canPlay: false, listPlaying: false,
      isAlive: at >= 0 && Boolean(this.nowPlaying.playing), artwork: at >= 0 ? playingArt || songs[at].cover : null,
      canRefresh: true, isRefreshing: queue.isLoading };
  }

  model() {
    if (this.mode === 'queue') return this.queueModel();
    if (this.mode === 'folder') return this.folderModel();
    if (this.mode === 'webPlaylist') return this.listModel();
    if (this.onWeb) return this.webModel();
    if (this.inMusic) return this.musicModel();
    const track = this.nowPlaying.track;
    // The song clicked plays now: it is no longer on its way.
    if (this.starting && track && this.nowPlaying.playing && (track.playKey === this.starting.id || plain(track.title) === plain(this.starting.title))) this.starting = null;
    const list = this.spotify;
    const playingArt = this.nowPlaying.snapshot().artwork;
    const songs = list.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album,
      cover: s.artworkFile ? artwork.url(s.artworkFile) : covers.local(s.cover) || this.savedCover(s.id)
        || (track && plain(s.title) === plain(track.title) ? playingArt : null) }));
    const subtitle = this.notice && this.notice.until > Date.now() ? this.notice.text
      : list.isLoading ? 'Finding songs…'
      : list.isRecent ? (songs.length ? 'Recently played in Spotify' : 'Songs you play in Spotify come here')
      : (songs.length ? `Songs like ${list.seedTitle}` : 'Play a song in Spotify');
    const playing = track ? songs.findIndex((s) => s.id === track.playKey || s.id === `local:${track.id}`) : -1;
    const byName = playing >= 0 ? playing : track ? songs.findIndex((s) => same(track.title, track.artist, s)) : -1;
    // A song clicked stands at the top as if playing already, until Spotify starts it.
    const asked = this.starting ? songs.findIndex((s) => s.id === this.starting.id) : -1;
    const at = asked >= 0 ? asked : byName >= 0 ? byName : null;
    const display = this.window && !this.window.isDestroyed() ? screen.getDisplayMatching(this.window.getBounds()).bounds : screen.getPrimaryDisplay().bounds;
    return {
      style: { ...this.style, fit: this.fit() }, title: 'Continue Playing', subtitle, songs,
      playing: at,
      starting: asked >= 0,
      isAlive: asked < 0 && Boolean(this.nowPlaying.playing),
      // The colors come from the song's own artwork, or from its cover in the list until that arrives.
      artwork: asked >= 0 ? songs[asked].cover : playingArt || (at != null ? songs[at].cover : null),
      // The wallpaper, for the glass of the song playing to frost, and the display it lies on.
      frost: wallpaper.url(), display, frostAmount: settings.get().desktop.frost,
      canRefresh: this.mode === 'continuePlaying' && Boolean(this.seed),
      isRefreshing: list.isLoading,
    };
  }

  /** A song played in Spotify keeps the cover saved when it played. */
  savedCover(playKey) {
    const song = this.nowPlaying.history.songs.find((s) => s.playKey === playKey && s.artworkFile);
    return song ? artwork.url(song.artworkFile) : null;
  }

  publish() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.send('panel-model', this.model()), 30);
    // An open shelf follows too: the site, the list shown, the folders.
    if (this.shelfOpen) this.publishShelf();
  }

  // ---- playing ----

  play(index) {
    // Played where it is in the queue: what follows stays as it was.
    if (this.mode === 'queue') { this.queue.play(index); return; }
    if (this.mode === 'folder') { this.playFile(index); return; }
    if (this.mode === 'webPlaylist') { this.playInList(index); return; }
    if (this.onWeb) { this.playOnWeb(index); return; }
    if (this.inMusic) { this.playInMusic(index); return; }
    const song = this.spotify.songs[index];
    if (!song) return;
    console.log('[panel] play', song.title, '|', song.id);
    const track = this.nowPlaying.track;
    // The song playing pauses or resumes, as its card does in the player.
    if (track && (song.id === track.playKey || same(track.title, track.artist, song))) { this.nowPlaying.togglePlayback(); return; }
    // It climbs to the top at once, saying it is starting, while Spotify is asked: by its Spotify ID, or one known
    // only by name through Spotify's own search.
    const asked = { id: song.id, title: song.title };
    this.starting = asked;
    const waiting = this.nowPlaying.ask({ title: song.title, artist: song.artist, picture: song.art || null });
    this.notice = null;
    this.publish();
    // On Spotify's Web Player, its page by the song's ID; in Spotify's app, the app.
    const webPage = this.onSpotifyWeb && song.id.startsWith('spotify:track:') ? `https://open.spotify.com/track/${song.id.split(':').pop()}` : null;
    const run = webPage ? this.nowPlaying.web.play({ kind: 'song', title: song.title, artist: song.artist, link: webPage })
      : song.id.startsWith('spotify:track:') ? playSpotifyURI(song.id, song.title) : playInSpotify('track', song.title, song.artist);
    run.then((ok) => {
      if (this.starting !== asked) return;
      if (!ok) {
        this.nowPlaying.askFailed(waiting);
        // Spotify couldn't: the list goes back as it was, and says so for a moment.
        this.starting = null;
        this.notice = { text: 'Spotify couldn’t start it', until: Date.now() + 3500 };
        this.publish();
        setTimeout(() => this.publish(), 3600);
        return;
      }
      // Pressed: Spotify says it plays a moment later; should it never, the list goes back as it was.
      setTimeout(() => { if (this.starting === asked) { this.starting = null; this.publish(); } }, 6000);
    });
  }

  // ---- the user's own lists on the web ----

  /** One of the user's lists: its songs, kept or read. */
  listModel() {
    const lists = this.lists;
    const track = this.nowPlaying.track;
    const site = SITE_NAMES[lists.site] || 'the web';
    const songs = lists.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album, cover: covers.local(s.artwork) || null }));
    if (this.starting && track && this.nowPlaying.playing && plain(track.title) === plain(this.starting.title)) this.starting = null;
    const subtitle = this.noticeNow() || (!lists.current ? `from ${site}, in the shelf`
      : !songs.length && lists.isLoading ? 'Loading…'
      : !songs.length && lists.unreachable ? `Open ${site} in your browser`
      : `${songs.length} songs on ${site}`);
    const asked = this.starting ? songs.findIndex((s) => s.id === this.starting.id) : -1;
    const row = track ? songs.findIndex((s) => s.id === track.playKey || same(track.title, track.artist, s)) : -1;
    const at = asked >= 0 ? asked : row >= 0 ? row : null;
    const playingArt = this.nowPlaying.snapshot().artwork;
    return { ...this.frame(), title: lists.current?.name || 'Choose a playlist', subtitle, songs, playing: at, starting: asked >= 0,
      inPlace: true, canPlay: songs.length > 0, listPlaying: at != null && Boolean(this.nowPlaying.playing),
      isAlive: asked < 0 && Boolean(this.nowPlaying.playing), artwork: asked >= 0 ? songs[asked].cover : playingArt || (at != null ? songs[at].cover : null),
      canRefresh: Boolean(lists.current), isRefreshing: lists.isLoading };
  }

  /** A song of one of the user's lists, played in that list so the list goes on after it: on YouTube Music and
   *  SoundCloud by its page in the list; on Spotify's Web Player by the page's own player; in Spotify's app, the app
   *  plays it on its album. */
  playInList(index) {
    const lists = this.lists;
    const song = lists.songs[index];
    const list = lists.current;
    if (!song || !list) return;
    const track = this.nowPlaying.track;
    if (track && (song.id === track.playKey || same(track.title, track.artist, song))) { this.nowPlaying.togglePlayback(); return; }
    const asked = { id: song.id, title: song.title };
    this.starting = asked;
    this.notice = null;
    const waiting = this.nowPlaying.ask({ title: song.title, artist: song.artist, picture: song.artwork || null });
    this.publish();
    const web = this.nowPlaying.web;
    const run = lists.site !== 'spotifyWeb' ? web.play({ kind: 'song', title: song.title, artist: song.artist, link: song.link })
      : this.inSpotifyApp ? playSpotifyURI(song.id, song.title, list.id)
      : web.playInSpotifyList(song.id, index, list.id).then((ok) => ok || web.play({ kind: 'song', title: song.title, artist: song.artist, link: song.link }));
    run.then((ok) => {
      if (this.starting !== asked) return;
      if (!ok) {
        this.nowPlaying.askFailed(waiting);
        this.starting = null;
        this.notice = { text: 'Couldn’t start it', until: Date.now() + 3500 };
        this.publish();
        setTimeout(() => this.publish(), 3600);
        return;
      }
      setTimeout(() => { if (this.starting === asked) { this.starting = null; this.publish(); } }, 8000);
    });
  }

  /** Another source chosen: a list of the site left behind gives way to Continue Playing. */
  followSite() {
    const site = this.listSite;
    if (this.mode !== 'webPlaylist' || !this.lists.site || site === this.lists.site) return;
    if (site || this.nowPlaying.choice) this.chooseContinuePlaying();
  }

  // ---- the shelf (PlaylistShelf): the lists in the player's middle, where search's results show ----

  /** The title clicked: the user's lists open in the player, where its cards are; the menu stays for a player that's
   *  hidden or made small. A second click closes them. */
  openLists() {
    const desk = settings.get().desktop;
    const shown = Boolean(desk?.isOn && !desk.mini && shared.desktop?.window && !shared.desktop.window.isDestroyed());
    if (!shown) { this.shelfOpen = false; this.openMenu(); return; }
    if (this.shelfOpen) { this.shelfOpen = false; this.publishShelf(); return; }
    const site = this.listSite;
    if (site) { this.lists.show(site); this.lists.refresh(); }
    this.shelfOpen = true;
    this.publishShelf();
  }

  publishShelf() {
    const desktop = shared.desktop;
    if (!desktop) return;
    clearTimeout(this.shelfPending);
    this.shelfPending = setTimeout(() => desktop.send('lists', this.shelfOpen ? this.shelfContent() : null), 30);
  }

  /** What the shelf holds: Continue Playing and the lists of where the user listens, then their folders. */
  shelfContent() {
    const songs = (n) => (n === 1 ? '1 song' : `${n} songs`);
    const carry = { id: 'continue', title: 'Continue Playing', line: 'Songs like the one playing', art: null, symbol: 'infinity' };
    const upNext = { id: 'queue', title: 'Queue', line: 'What plays next', art: null, symbol: 'listNumber' };
    const sections = [];
    const site = this.listSite;
    if (site) {
      const lists = this.lists;
      const entries = lists.lists.map((l) => ({ id: `web:${l.id}`, title: l.name,
        line: l.count != null ? songs(l.count) : l.owner || (LIKED.has(l.id) ? 'Liked songs' : 'Playlist'),
        art: l.artwork ? covers.local(l.artwork) || l.artwork : null, symbol: LIKED.has(l.id) ? 'heart' : 'list' }));
      const page = this.inSpotifyApp ? 'open.spotify.com' : SITE_NAMES[site];
      const note = entries.length ? null : lists.isReading ? 'Loading your playlists…'
        : lists.signedOut ? `Sign in at ${page} in your browser, and your playlists show up here.`
        : lists.unreachable ? `Open ${page} in your browser, and your playlists show up here.`
        : `No playlists on ${SITE_NAMES[site]} yet.`;
      sections.push({ title: SITE_NAMES[site], entries: [carry, upNext, ...entries], note });
    } else {
      sections.push({ title: NAMES[this.nowPlaying.choice] || 'Your Music', entries: [carry, upNext], note: null });
    }
    const folders = (this.folders?.folders || []).map((f) => ({ id: `folder:${f.id}`, title: f.name, line: f.songs ? songs(f.songs.length) : 'Folder', art: null, symbol: 'folder' }));
    sections.push({ title: 'Folders', entries: [...folders, { id: 'addFolder', title: 'Add Folder', line: 'A folder of songs', art: null, symbol: 'plus' }], note: null });
    const chosen = this.mode === 'continuePlaying' ? 'continue' : this.mode === 'queue' ? 'queue' : this.mode === 'folder' ? `folder:${this.folders?.current?.id}` : `web:${this.lists.current?.id}`;
    return { sections, chosen };
  }

  pickFromShelf(id) {
    if (id === 'continue') { this.chooseContinuePlaying(); return; }
    if (id === 'queue') { this.chooseQueue(); return; }
    if (id === 'addFolder') { this.addFolder(); return; }
    if (id.startsWith('web:')) {
      const list = this.lists.lists.find((l) => l.id === id.slice(4));
      if (!list) return;
      this.setMode('webPlaylist');
      this.lists.choose(list);
    } else if (id.startsWith('folder:')) {
      this.chooseFolder(id.slice(7));
    }
  }

  /** A folder's own menu on the shelf: taking it off the list. */
  shelfMenu(id) {
    if (!id?.startsWith('folder:')) return;
    const folder = (this.folders?.folders || []).find((f) => f.id === id.slice(7));
    if (!folder) return;
    popup(Menu.buildFromTemplate([{ label: `Remove “${folder.name}”`, toolTip: 'Takes the folder off this list. The folder and its songs stay where they are.',
      click: () => { const shown = this.mode === 'folder' && this.folders.current?.id === folder.id; this.folders.remove(folder.id); if (shown) this.chooseContinuePlaying(); this.publishShelf(); } }]),
    shared.desktop?.window);
  }

  setMode(mode) {
    this.mode = mode;
    require('./settings').set({ playlistMode: mode });
    if (mode !== 'folder') this.folders?.leave();
    this.publish();
  }

  /** Continue Playing, the site's own lists and the folders made playlists; a folder added from Windows' own Open
   *  window. The site's lists kept show at once, read again meanwhile — waited for a moment only when none are kept. */
  async openMenu() {
    const site = this.listSite;
    if (site) {
      this.lists.show(site);
      const reading = this.lists.refresh();
      if (!this.lists.lists.length) await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    this.showMenu();
  }

  showMenu() {
    const folders = this.folders?.folders || [];
    const current = this.mode === 'folder' ? this.folders?.current : null;
    // On a music site, its own lists too, under its name, or a word on why there are none.
    const site = this.listSite;
    const lists = site ? this.lists.lists : [];
    const why = !site || lists.length ? null : this.lists.signedOut ? `Sign in at ${this.inSpotifyApp ? 'open.spotify.com' : SITE_NAMES[site]} in your browser`
      : this.lists.unreachable ? `Open ${this.inSpotifyApp ? 'open.spotify.com' : SITE_NAMES[site]} in your browser` : 'No playlists found';
    const menu = Menu.buildFromTemplate([
      { label: 'Continue Playing', type: 'checkbox', checked: this.mode === 'continuePlaying', click: () => this.chooseContinuePlaying() },
      { label: 'Queue', type: 'checkbox', checked: this.mode === 'queue', click: () => this.chooseQueue() },
      { type: 'separator' },
      ...(site ? [{ label: SITE_NAMES[site], enabled: false }] : []),
      ...(why ? [{ label: why, enabled: false }] : []),
      ...lists.map((l) => ({ label: l.name, type: 'checkbox', checked: this.mode === 'webPlaylist' && this.lists.current?.id === l.id,
        click: () => this.pickFromShelf(`web:${l.id}`) })),
      ...(site ? [{ type: 'separator' }] : []),
      ...folders.map((folder) => ({ label: folder.name, type: 'checkbox', checked: current?.id === folder.id, click: () => this.chooseFolder(folder.id) })),
      { label: 'Add Folder…', click: () => this.addFolder() },
      ...(current ? [{ label: `Remove “${current.name}”`, toolTip: 'Takes the folder off this list. The folder and its songs stay where they are.',
        click: () => { this.folders.remove(current.id); this.chooseContinuePlaying(); } }] : []),
      { type: 'separator' },
      { label: 'Hide Playlist', click: () => { settings.set({ playlist: { isOn: false } }); this.apply(); } },
    ]);
    popup(menu, this.window);
  }

  chooseContinuePlaying() {
    this.mode = 'continuePlaying';
    require('./settings').set({ playlistMode: 'continuePlaying' });
    this.folders?.leave();
    this.carryOn(true);
    this.publish();
  }

  /** What plays next where the user listens, read afresh. */
  chooseQueue() {
    this.setMode('queue');
    this.queue.refresh(true);
  }

  chooseFolder(id) {
    this.mode = 'folder';
    require('./settings').set({ playlistMode: 'folder' });
    this.folders.choose(id);
    this.publish();
  }

  /** Folders to make playlists, chosen in Windows' own Open window. */
  async addFolder() {
    const answer = await dialog.showOpenDialog({ title: 'Choose a folder of songs', buttonLabel: 'Add',
      message: 'Choose a folder of songs. It becomes a playlist; the songs stay where they are.',
      properties: ['openDirectory', 'multiSelections'] });
    if (!answer.canceled) this.addFolders(answer.filePaths);
  }

  /** Makes folders playlists — chosen, or dropped on the panel — and shows the last. */
  addFolders(paths) {
    if (!paths.length || !this.folders) return;
    if (this.folders.add(paths)) { this.mode = 'folder'; this.publish(); }
  }

  /** A right click on a song: play it, open it where it is, or copy its link — and, in the Queue, take it out of it;
   *  elsewhere, line it up where the song playing plays. */
  songMenu(index) {
    if (this.mode === 'queue') {
      const song = this.queue.songs[index];
      if (!song) return;
      // By the song itself, should the queue be read again while the menu is open.
      const row = () => this.queue.songs.findIndex((s) => s.id === song.id);
      popup(Menu.buildFromTemplate([
        { label: 'Play', click: () => { const at = row(); if (at >= 0) this.play(at); } },
        ...(this.queue.canRemove(index) ? [{ type: 'separator' },
          { label: 'Remove from Queue', click: () => { const at = row(); if (at >= 0) this.queue.remove(at); } }] : []),
      ]), this.window);
      return;
    }
    if (this.mode === 'webPlaylist') {
      const song = this.lists.songs[index];
      if (!song) return;
      // By the song itself, should the list be read again while the menu is open.
      const playIt = () => { const at = this.lists.songs.findIndex((s) => s.id === song.id); if (at >= 0) this.play(at); };
      popup(Menu.buildFromTemplate([
        { label: 'Play', click: playIt },
        { label: `Open in ${SITE_NAMES[this.lists.site] || 'Browser'}`, enabled: Boolean(song.link), click: () => shell.openExternal(song.link) },
        { label: 'Copy Link', enabled: Boolean(song.link), click: () => clipboard.writeText(song.link) },
        ...this.lineUpEntries(index),
      ]), this.window);
      return;
    }
    if (this.mode === 'folder') {
      const song = this.folders?.current?.songs[index];
      if (!song) return;
      popup(Menu.buildFromTemplate([
        { label: 'Play', click: () => this.play(index) },
        { label: 'Show in File Explorer', click: () => shell.showItemInFolder(song.id) },
        ...this.lineUpEntries(index),
      ]), this.window);
      return;
    }
    if (this.inMusic) {
      const song = this.catalog.songs[index];
      if (!song) return;
      const link = /^\d+$/.test(song.id) ? `https://music.apple.com/song/${song.id}` : null;
      popup(Menu.buildFromTemplate([
        { label: 'Play', click: () => this.play(index) },
        { label: 'Copy Link', enabled: Boolean(link), click: () => clipboard.writeText(link) },
        ...this.lineUpEntries(index),
      ]), this.window);
      return;
    }
    if (this.onWeb) {
      const song = this.web.songs[index];
      if (!song) return;
      popup(Menu.buildFromTemplate([
        { label: 'Play', click: () => this.play(index) },
        { label: `Open in ${NAMES[this.web.site] || 'Browser'}`, enabled: Boolean(song.link), click: () => shell.openExternal(song.link) },
        { label: 'Copy Link', enabled: Boolean(song.link), click: () => clipboard.writeText(song.link) },
        ...this.lineUpEntries(index),
      ]), this.window);
      return;
    }
    const song = this.spotify.songs[index];
    if (!song) return;
    const id = song.id.split(':').pop();
    popup(Menu.buildFromTemplate([
      { label: 'Play', click: () => this.play(index) },
      { label: 'Open in Spotify', click: () => shell.openExternal(`spotify:track:${id}`) },
      { label: 'Copy Link', click: () => clipboard.writeText(`https://open.spotify.com/track/${id}`) },
      ...this.lineUpEntries(index),
    ]), this.window);
  }

  /** Play Next and Add to Queue for row `index`, under a line, when songs can be lined up where the song playing
   *  plays and the row says what song it is. */
  lineUpEntries(index) {
    const song = this.queue.canAdd ? this.candidate(index) : null;
    if (!song) return [];
    return [{ type: 'separator' },
      { label: 'Play Next', click: () => this.lineUp(song, true) },
      { label: 'Add to Queue', click: () => this.lineUp(song, false) }];
  }

  /** A song lined up where the song playing plays; a word says whether it went in. */
  async lineUp(song, next) {
    const done = await this.queue.add(song, next);
    const said = done ? NOTICES.queued(next) : NOTICES.notQueued;
    this.notice = { text: said.title, until: Date.now() + 3400 };
    this.publish();
    setTimeout(() => this.publish(), 3500);
  }

  /** Row `index` of the list shown, as a song to line up, with whatever IDs its list knows it by. */
  candidate(index) {
    if (this.mode === 'queue') return null;
    if (this.mode === 'webPlaylist') {
      const song = this.lists.songs[index];
      if (!song) return null;
      const video = song.id.length === 11 && !song.id.includes(':') ? song.id : videoOf(song.link);
      return { title: song.title, artist: song.artist, album: song.album,
        spotifyURI: song.id.startsWith('spotify:track:') ? song.id : null, youTubeID: video };
    }
    if (this.mode === 'folder') {
      const song = this.folders?.current?.songs[index];
      return song ? { title: song.title, artist: song.artist, album: song.album, file: song } : null;
    }
    if (this.inMusic) {
      const song = this.catalog.songs[index];
      return song ? { title: song.title, artist: song.artist, album: song.album } : null;
    }
    if (this.onWeb) {
      const song = this.web.songs[index];
      return song ? { title: song.title, artist: song.artist, album: song.album, youTubeID: videoOf(song.link) } : null;
    }
    const song = this.spotify.songs[index];
    return song ? { title: song.title, artist: song.artist, album: song.album,
      spotifyURI: song.id.startsWith('spotify:track:') ? song.id : null } : null;
  }

  /** A song of the folder shown: iBaila plays it, the folder's songs after it; the song playing pauses or resumes. */
  playFile(index) {
    const folder = this.folders?.current;
    const song = folder?.songs[index];
    if (!song) return;
    const track = this.nowPlaying.track;
    if (track?.source === 'files' && track.playKey === `file:${song.id}`) { this.nowPlaying.togglePlayback(); return; }
    shared.files?.play(folder.songs, index);
  }

  /** A song of the Apple Music list: played in Apple Music, found there through its own search. */
  playInMusic(index) {
    const song = this.catalog.songs[index];
    if (!song) return;
    const track = this.nowPlaying.track;
    if (track?.source === 'music' && plain(song.title) === plain(track.title)) { this.nowPlaying.togglePlayback(); return; }
    const asked = { id: song.id, title: song.title };
    this.starting = asked;
    this.notice = null;
    const waiting = this.nowPlaying.ask({ title: song.title, artist: song.artist, picture: song.cover || null });
    this.publish();
    require('./players').playInAppleMusic('track', song.title, require('./names').lead(song.artist)).then((ok) => {
      if (this.starting !== asked) return;
      if (!ok) {
        this.nowPlaying.askFailed(waiting);
        this.starting = null;
        this.notice = { text: 'Apple Music couldn’t start it', until: Date.now() + 3500 };
        this.publish();
        setTimeout(() => this.publish(), 3600);
        return;
      }
      setTimeout(() => { if (this.starting === asked) { this.starting = null; this.publish(); } }, 12000);
    });
  }

  /** A song of the site's list: its page opened in the browser, the list after it there. */
  playOnWeb(index) {
    const song = this.web.songs[index];
    if (!song) return;
    const track = this.nowPlaying.track;
    if (track?.source === 'web' && plain(song.title) === plain(track.title)) { this.nowPlaying.togglePlayback(); return; }
    const asked = { id: song.id, title: song.title };
    this.starting = asked;
    this.notice = null;
    const waiting = this.nowPlaying.ask({ title: song.title, artist: song.artist, picture: song.art || null });
    this.publish();
    this.nowPlaying.web.play({ kind: 'song', title: song.title, artist: song.artist, link: song.link }).then((ok) => {
      if (this.starting !== asked) return;
      if (!ok) {
        this.nowPlaying.askFailed(waiting);
        this.starting = null;
        this.notice = { text: 'Couldn’t start it', until: Date.now() + 3500 };
        this.publish();
        setTimeout(() => this.publish(), 3600);
        return;
      }
      setTimeout(() => { if (this.starting === asked) { this.starting = null; this.publish(); } }, 12000);
    });
  }

  // ---- the window ----

  apply() {
    const all = settings.get();
    if (!this.style.isOn || !all.isEnabled) { this.hide(); return; }
    const m = metrics(this.style, this.fit());
    if (!this.window || this.window.isDestroyed()) { if (!this.opening) this.show(m); return; }
    const b = this.window.getBounds();
    // A pixel or two off is Windows rounding at a display scale like 125%; a real change of size is centred on the
    // place kept in the settings, not on where Windows says the list stands, which would creep a pixel each time.
    if (Math.abs(b.width - m.window.width) > 3 || Math.abs(b.height - m.window.height) > 3) {
      const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).bounds;
      const place = this.style.place || [this.style.side === 'right' ? 0.86 : 0.14, 0.5];
      this.window.setBounds(this.clamped({ x: Math.round(area.x + area.width * place[0] - m.window.width / 2),
        y: Math.round(area.y + area.height * place[1] - m.window.height / 2), ...m.window }, area));
    }
    this.publish();
  }

  show(m) {
    this.opening = openShared('ibaila://app/panel/panel.html', {
      ...TOOL,
      ...this.frameFor(m), frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false, focusable: false, alwaysOnTop: false,
      backgroundColor: '#00000000', title: 'iBaila',
      webPreferences: { preload: this.preload, backgroundThrottling: false, contextIsolation: true },
    }, (win) => {
      this.opening = null;
      this.window = win;
      require('./cleardesk').clearDesk.adopt(win);
      if (!process.env.IBAILA_SHOT) win.once('ready-to-show', () => win.showInactive());
      this.apply();
    });
  }

  hide() {
    this.opening?.();
    this.opening = null;
    if (!this.window || this.window.isDestroyed()) return;
    this.window.destroy();
    this.window = null;
  }

  frameFor(m) {
    const area = screen.getPrimaryDisplay().bounds;
    const place = this.style.place || [this.style.side === 'right' ? 0.86 : 0.14, 0.5];
    return this.clamped({ x: Math.round(area.x + area.width * place[0] - m.window.width / 2), y: Math.round(area.y + area.height * place[1] - m.window.height / 2), ...m.window }, area);
  }

  /** Keeps the list itself whole on the screen: the clear margin around it may hang over the edge. */
  clamped(frame, area) {
    if (!area) {
      const b = this.window.getBounds();
      area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).bounds;
    }
    const margin = 24;
    const a = { x: area.x - margin, y: area.y - margin, width: area.width + 2 * margin, height: area.height + 2 * margin };
    return { ...frame,
      x: Math.round(Math.min(Math.max(frame.x, a.x), Math.max(a.x + a.width - frame.width, a.x))),
      y: Math.round(Math.min(Math.max(frame.y, a.y), Math.max(a.y + a.height - frame.height, a.y))) };
  }

  dragPhase(phase) {
    if (!this.window || this.style.locked) return;
    if (phase === 'start') {
      this.drag?.end();
      this.drag = follow(this.window, () => this.dropped());
    } else if (this.drag) {
      this.drag.end();
    }
  }

  dropped() {
    this.drag = null;
    if (!this.window || this.window.isDestroyed()) return;
    const b = this.clamped(this.window.getBounds());
    this.window.setBounds(b);
    const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).bounds;
    settings.set({ playlist: { place: [(b.x + b.width / 2 - area.x) / area.width, (b.y + b.height / 2 - area.y) / area.height] } });
  }

}

module.exports = { PlaylistPanel, metrics };
