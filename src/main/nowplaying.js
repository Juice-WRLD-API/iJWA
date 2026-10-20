// What is playing, everywhere in the app: the song, whether it plays, where in it, shuffle and repeat, and the
// way to control it. On Windows it comes from the system media session through a small PowerShell helper (no
// native module to build), which Spotify, Apple Music and browsers all report to. Anywhere else,
// `IBAILA_FAKE=1` runs a made-up player with real songs, for building the app on the Mac.
const { EventEmitter } = require('events');
const { nativeImage } = require('electron');
const artwork = require('./artwork');
const { plain } = require('./spotifyweb');
const { PlayHistory, songID } = require('./history');

/** Which app a session belongs to, from Windows' name for it. */
function sourceOf(app) {
  const name = (app || '').toLowerCase();
  if (name.includes('spotify')) return 'spotify';
  if (name.includes('applemusic') || name.includes('itunes')) return 'music';
  // iBaila's own player: its sound tells Windows too (its media session), and the app as Windows names it.
  if (name.includes('ibaila')) return 'files';
  // A browser — YouTube Music, SoundCloud — or YouTube Music's own desktop apps. Firefox names itself to Windows by
  // its app ID alone.
  if (/chrome|msedge|edge|firefox|brave|opera|vivaldi|arc|youtube-music|ytmdesktop|308046b0af4a39cb/.test(name)) return 'web';
  return 'other';
}

const now = () => performance.timeOrigin / 1000 + performance.now() / 1000;

/** The places one can choose to listen in (NowPlaying.Choice): only that one is followed, whatever else plays. */
// Plain YouTube was a choice too, until videos moved the light (his call, 2026-10-09: music only, YouTube Music): a
// choice of it kept from before reads as none.
// Spotify's Web Player is a place of its own, apart from Spotify's app (his call on the Mac, 2026-10-10).
const CHOICES = ['appleMusic', 'spotify', 'spotifyWeb', 'youTubeMusic', 'soundCloud'];
const SITES = { youTubeMusic: 'youTubeMusic', soundCloud: 'soundCloud', spotifyWeb: 'spotifyWeb' };
const NAMES = { appleMusic: 'Apple Music', spotify: 'Spotify', spotifyWeb: 'Spotify Web Player', youTube: 'YouTube', youTubeMusic: 'YouTube Music', soundCloud: 'SoundCloud',
  browser: 'your browser', files: 'iBaila' };

/** Whether a picture is an app's icon — Chrome's logo showed on the cover for a moment as a song started on the web
 *  (a friend's PC, 2026-10-09): an icon's corners are see-through, a cover's never are. */
function isIcon(bytes) {
  try {
    const image = nativeImage.createFromBuffer(bytes);
    const { width, height } = image.getSize();
    if (width < 4 || height < 4) return false;
    const pixels = image.toBitmap();
    const alpha = (x, y) => pixels[(y * width + x) * 4 + 3];
    return [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].filter(([x, y]) => alpha(x, y) < 200).length >= 3;
  } catch { return false; }
}

class NowPlaying extends EventEmitter {
  track = null;          // { id, title, artist, album, source, app, duration }
  playing = false;
  clock = null;          // { seconds, at, running }: where the song stood at `at` (seconds since 1970)
  shuffle = false;
  repeat = 'off';        // off | all | one
  can = {};
  artworkFile = null;
  artworkSongID = null;

  constructor() {
    super();
    this.history = new PlayHistory();
    // The heart in the bar: whether the song playing is liked where it plays (likes.js).
    this.likes = new (require('./likes').Likes)(this);
    this.web = new (require('./webplay').WebPlay)(this);
    // What plays next where the user listens, for the panel's Queue and search's Play Next (playqueue.js).
    this.queue = new (require('./playqueue').PlayQueue)(this);
  }

  start() {
    if (process.platform === 'win32') this.startWindows();
    else if (process.env.IBAILA_FAKE) this.startFake();
    // iBaila's browser extension: each music page tells what it plays itself (extension.js).
    if (process.platform === 'win32' || process.env.IBAILA_EXTENSION_PORT) {
      const { extension } = require('./extension');
      extension.on('playing', (page) => this.pageSaid(page));
      // Only a page of the site chosen (any music site, with none chosen) takes the following over.
      extension.accepts = (site) => (this.chosenSite ? site === this.chosenSite : Boolean(SITES[site]) || !this.choice);
      extension.start();
    }
  }

  /** A browser's music page told what it plays, through iBaila's extension (NowPlaying.pageSaid): followed instead of
   *  Windows' word for the browser, which names only one of its tabs — and with Opera, often none. Its picture is
   *  fetched by its address, once. */
  pageSaid(page) {
    if (!page) {
      // Its tab closed, or the browser: the song goes, as it does on the Mac.
      if (this.track?.viaExtension) { this.forget(); this.changed(); }
      return;
    }
    // YouTube Music's song itself, by the id the page told with it: the heart likes this one (likes.js).
    this.pageSong = page.song || '';
    // Where the song stood when the page looked, carried on to now — not while it loads (rate 0).
    const rate = typeof page.rate === 'number' ? page.rate : 1;
    // Whether the page's song runs, not only means to: 0 while it loads (WebPlayer.letLoad).
    this.pageRate = rate;
    const age = page.playing ? Math.max(0, (Date.now() - (page.at || Date.now())) / 1000) * rate : 0;
    const data = { app: page.browser, title: page.title, artist: page.artist, album: page.album, playing: page.playing,
      position: typeof page.position === 'number' ? page.position + age : undefined, duration: page.duration || 0,
      site: page.site, viaExtension: true, link: page.link || '' };
    // The page's own repeat, as its button says — not while a press of iBaila's is still on its way there.
    const repeat = { off: 'None', one: 'Track', all: 'List' }[page.repeat];
    if (repeat && !(this.repeatPressedAt && Date.now() - this.repeatPressedAt < 3000)) data.repeat = repeat;
    // Spotify's Web Player names the song's own page — signed in, only its album's: the song's ID found in the album's
    // list by its title (NowPlaying.pageSaid), for Continue Playing to find songs like it.
    const songPage = /\/track\/([A-Za-z0-9]+)/.exec(page.link || '');
    if (page.site === 'spotifyWeb' && songPage) data.playKey = `spotify:track:${songPage[1]}`;
    const albumPage = /\/album\/([A-Za-z0-9]+)/.exec(page.link || '');
    if (page.site === 'spotifyWeb' && !songPage && albumPage) {
      const key = `${albumPage[1]}|${plain(page.title)}`;
      this.spotifyKeys = this.spotifyKeys || new Map();
      if (this.spotifyKeys.has(key)) { if (this.spotifyKeys.get(key)) data.playKey = this.spotifyKeys.get(key); }
      else {
        this.spotifyKeys.set(key, '');
        require('./spotifyweb').albumSongs(`spotify:album:${albumPage[1]}`).then((songs) => {
          const found = songs.find((s) => plain(s.title) === plain(page.title));
          if (!found) return;
          this.spotifyKeys.set(key, found.uri);
          if (this.track?.viaExtension && plain(this.track.title) === plain(page.title) && this.track.playKey !== found.uri) {
            this.track = { ...this.track, playKey: found.uri };
            this.emit('spotify-ids', this.track);
            this.changed();
          }
        }).catch(() => {});
      }
    }
    const volume = typeof page.volume === 'number' ? page.volume : null;
    if (volume !== this.pageVolume) { this.pageVolume = volume; this.changed(); }
    // The page's picture is handed over once for its song — saved again at every word of the page, the cover was
    // rewritten every few seconds.
    const shownKey = `${page.title}|${page.artwork}`;
    this.pageArtwork = page.artwork;
    const known = this.pagePictures?.get(page.artwork);
    const handOver = known && this.pagePictureShown !== shownKey;
    if (handOver) this.pagePictureShown = shownKey;
    this.update(data, handOver ? known : null);
    if (!page.artwork || known || this.pagePictureAsked === page.artwork) return;
    this.pagePictureAsked = page.artwork;
    fetch(page.artwork, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.arrayBuffer() : null)).then((bytes) => {
      if (!bytes) { this.pagePictureAsked = null; return; }
      this.pagePictures = this.pagePictures || new Map();
      if (this.pagePictures.size > 20) this.pagePictures.delete(this.pagePictures.keys().next().value);
      this.pagePictures.set(page.artwork, Buffer.from(bytes));
      // Still the page's song: its picture shown now.
      if (this.track?.viaExtension && this.pageArtwork === page.artwork && this.pagePictureShown !== shownKey) {
        this.pagePictureShown = shownKey;
        this.update(data, Buffer.from(bytes));
      }
    }).catch(() => { this.pagePictureAsked = null; });
  }

  /** The page followed asked to do something, through the extension: whether it could be asked. */
  tellPage(action, arg) {
    const { extension } = require('./extension');
    const followed = extension.followed;
    if (!this.track?.viaExtension || !followed) return false;
    extension.tell(followed.browser, followed.tab, followed.site, action, arg).then((answer) => {
      console.log('[web]', followed.site, action, answer ?? 'no answer');
    });
    return true;
  }

  /** Everything the pages need, in one piece. */
  snapshot() {
    return {
      track: this.track, playing: this.playing, clock: this.clock, shuffle: this.shuffle, repeat: this.repeat, can: this.can,
      choice: this.choice, mark: this.mark(), searchIn: this.searchIn(), volume: this.track?.viaExtension ? this.pageVolume ?? null : null,
      artwork: this.artworkSongID && this.artworkSongID === this.track?.id ? artwork.url(this.artworkFile) : null,
      artworkSongID: this.artworkSongID,
      canLike: this.likes.canLike, liked: this.likes.liked,
    };
  }

  changed() { this.emit('state', this.snapshot()); }

  // ---- where one listens -------------------------------------------------------------------

  /** Where the user chose to listen, from the source button at the bar's left end; null follows whatever plays (in
   *  a browser, music only). */
  get choice() {
    const chosen = require('./settings').get().listenChoice;
    return CHOICES.includes(chosen) ? chosen : null;
  }

  /** The site a chosen place is, for a browser's songs. */
  get chosenSite() { return SITES[this.choice] || null; }

  /** Whether an app's songs are followed, as the user chose; iBaila's own player always is. */
  allows(source) {
    const choice = this.choice;
    if (!choice || source === 'files') return true;
    if (source === 'music') return choice === 'appleMusic';
    if (source === 'spotify') return choice === 'spotify';
    // A browser's page, when a site is chosen: Spotify's app chosen is its app alone, its Web Player a place apart.
    if (source === 'web') return Boolean(SITES[choice]);
    return false;
  }

  /** What the bar's left end shows: the place chosen, else where the song plays — the site of a browser's song
   *  when it is known. */
  mark() {
    const source = this.track?.source;
    if (source === 'files') return { kind: 'files', name: NAMES.files };
    const kind = this.choice || (source === 'spotify' ? 'spotify' : source === 'music' ? 'appleMusic'
      : source === 'web' ? this.webSite || 'browser' : null);
    return kind ? { kind, name: NAMES[kind] } : null;
  }

  /** Where search searches: the web site listened on, else Spotify's catalog through Apple's, else Apple Music's. */
  searchIn() {
    const site = this.web?.site;
    // Spotify's Web Player is searched as "Spotify", its name as a site.
    if (site) return { kind: site, name: site === 'spotifyWeb' ? 'Spotify' : NAMES[site] };
    if (this.choice === 'spotify' || (!this.choice && this.track?.source === 'spotify')) return { kind: 'spotify', name: NAMES.spotify };
    return { kind: 'appleMusic', name: NAMES.appleMusic };
  }

  /** A new choice: what plays elsewhere goes, the helper follows the app chosen, and the player says so. */
  choiceChanged() {
    // The song playing where the user listened before stops there (his ask, 2026-10-11; Mac NowPlaying.choiceChanged):
    // before, it went on in the old app while iBaila followed the new one. Pages of the old site: turnMusicTab.
    const before = this.track;
    if (before && this.playing && this.choice && before.source !== 'web' && (before.source === 'files' || !this.allows(before.source))) {
      if (before.source === 'files') require('./main-state').files?.pause();
      else if (before.app) this.send(`pause-app ${before.app}`);
    }
    if (this.track && !this.allows(this.track.source)) this.forget();
    // What the site chosen already plays, shown at once: its page's last word, held by the extension — a paused page
    // says nothing by itself until something changes.
    if (this.chosenSite && this.track?.site !== this.chosenSite) {
      const { extension } = require('./extension');
      const held = [...extension.states.entries()].filter(([, s]) => s.site === this.chosenSite && s.title && !s.ad)
        .sort(([, a], [, b]) => Number(b.playing) - Number(a.playing) || (b.at || 0) - (a.at || 0))[0];
      if (held) {
        const [key, state] = held;
        const browser = key.split('|')[0];
        extension.followed = { browser, tab: state.tab, site: state.site };
        setTimeout(() => this.pageSaid({ ...state, browser }), 0);
      }
    }
    // A browser's page is judged again: another site may now be the one followed.
    this.webJudged = null;
    const only = this.chosenSite;
    if (this.track?.source === 'web' && only && this.track.site !== only) this.forget();
    this.preferChosen();
    // The one music tab follows to the site chosen; the other sites' pages fall quiet. A song of another site picked,
    // which made its site the choice, takes the tab itself (pickingSite).
    if (this.choice && !this.pickingSite) this.turnMusicTab(this.chosenSite);
    this.contenders = [];
    this.emit('contenders', []);
    this.changed();
  }

  /** The music tab (one for every site, through iBaila's extension) sent to the home page of the site chosen, if
   *  none of its own is open; the other sites' pages fall quiet. */
  async turnMusicTab(site) {
    const { extension } = require('./extension');
    const name = extension.pick();
    if (!name) return;
    const pages = ((await extension.tabs(name)) || []).filter((t) => SITES[t.site]);
    if (site && !pages.some((t) => t.site === site) && pages.length) {
      const home = site === 'soundCloud' ? 'https://soundcloud.com/' : site === 'spotifyWeb' ? 'https://open.spotify.com/' : 'https://music.youtube.com/';
      await extension.tell(name, pages[0].id, pages[0].site, 'go', home);
      return;
    }
    for (const page of pages) if (page.site !== site) extension.tell(name, page.id, page.site, 'pause');
  }

  /** A song of another site picked: its site becomes the choice, without the tab being sent home first — the song
   *  takes it there itself. */
  pickSite(site) {
    const choice = Object.keys(SITES).find((c) => SITES[c] === site);
    if (!choice || choice === this.choice) return;
    this.pickingSite = true;
    require('./settings').set({ listenChoice: choice });
    this.choiceChanged();
    this.pickingSite = false;
  }

  /** Windows names one session "current" — whichever app last made a sound. With a place chosen, its own app's session
   *  is followed instead, whatever else plays. */
  preferChosen() {
    const pattern = { spotify: 'Spotify', appleMusic: 'AppleMusic|iTunes' }[this.choice]
      || (SITES[this.choice] ? 'chrome|msedge|firefox|brave|opera|vivaldi|arc' : '');
    this.send(`prefer ${pattern}`);
  }

  // ---- music in two places at once (SourceChooser.swift) ----
  // Windows keeps a session for every app that plays, so it is known exactly which play: two or more for a moment,
  // and nothing chosen, the user is asked which one to hear. The same apps together aren't asked about again.

  weigh(sessions) {
    if (this.choice) return;
    const playing = sessions.filter((one) => one.playing && one.title && sourceOf(one.app) !== 'files' && sourceOf(one.app) !== 'other');
    const key = playing.map((one) => one.app).sort().join('|');
    if (playing.length < 2) {
      this.contendersSince = 0;
      if (this.contenders?.length) { this.contenders = []; this.emit('contenders', []); }
      this.askedAbout = playing.length ? this.askedAbout : '';
      return;
    }
    if (key === this.askedAbout) return;
    this.contendersSince = this.contendersSince || Date.now();
    if (Date.now() - this.contendersSince < 1500) return;
    this.askedAbout = key;
    this.contenders = playing.map((one) => ({ app: one.app, source: sourceOf(one.app), title: one.title, artist: one.artist || '' }));
    this.emit('contenders', this.contenders);
  }

  /** The one picked plays on; the others pause. */
  keep(app) {
    for (const other of this.contenders || []) if (other.app !== app) this.send(`pause-app ${other.app}`);
    this.contenders = [];
    this.emit('contenders', []);
  }

  // ---- a browser's song (NowPlaying.webChanged) ----

  /** The site a browser's song plays on and its words as a song's, once known: { site, words }, `site` null for a
   *  page that isn't followed; undefined while the tabs are read, after which the reading is taken again. A song is
   *  judged once; one turned away is judged again after half a minute (its tab may not have said yet). */
  judgeWeb(data, picture) {
    const key = `${data.app}|${data.title}|${data.artist || data.albumArtist || ''}`;
    const known = this.webJudged;
    if (known?.key === key && (known.site || Date.now() - known.at < 30000)) return known;
    this.webHeld = { data, picture: picture || this.webHeld?.picture || null };
    if (this.webJudging === key) return undefined;
    this.webJudging = key;
    const only = this.chosenSite;
    const artist = data.artist || data.albumArtist || '';
    (async () => {
      const webmusic = require('./webmusic');
      // YouTube Music alone names an album; a page iBaila itself opened a moment ago is of the site it opened; off
      // Windows (building on the Mac) every page is the one chosen; else the browser's tabs say.
      const opened = this.web.opened && Date.now() - this.web.opened.at < 45000 ? this.web.opened.site : null;
      // A page heard through iBaila's extension names its site itself.
      let found = { site: data.site || (data.album ? 'youTubeMusic' : opened || (process.platform !== 'win32' ? only || 'youTubeMusic' : null)) };
      if (!found.site && process.platform === 'win32') found = await require('./browser').musicSite(data.title, only, artist);
      let site = found.site;
      // A YouTube video is never followed, whatever is chosen: music only.
      if (site && (site === 'youTube' || (only && site !== only))) site = null;
      let words = null;
      // Which half of "A - B" sings, asked of Apple's catalog before the song is shown.
      if (site === 'soundCloud') words = await webmusic.soundCloudWords(data.title, artist).catch(() => webmusic.tidySoundCloud(data.title, artist));
      if (this.webJudging !== key) return;
      this.webJudging = null;
      // The tabs couldn't be read just now: asked again in a few seconds, not turned away for half a minute.
      this.webJudged = { key, site, words, at: found.unknown ? Date.now() - 26000 : Date.now() };
      console.log('[web]', data.title, '|', site || (found.unknown ? 'not known yet' : 'not followed'));
      const held = this.webHeld;
      this.webHeld = null;
      if (held) this.update(held.data, held.picture);
    })();
    return undefined;
  }

  /** What was followed is no longer: nothing shows as playing. */
  forget() {
    this.track = null;
    this.playing = false;
    this.clock = null;
    this.artworkFile = null;
    this.artworkSongID = null;
    this.emit('playing', false);
    this.emit('track', null);
  }

  /** A song asked to play from anywhere — search, a card, the list, the playlist, an artist's page — for the player
   *  to show it on its way (StartingPanel.swift). `any`: an album or an artist, ended by whichever song comes first. */
  ask(info) {
    const asked = { ...info, id: `${Date.now()}:${Math.random().toString(36).slice(2)}` };
    // Something to play elsewhere: iBaila's own song falls quiet first.
    if (!info.files) require('./main-state').files?.pause();
    this.emit('asked', asked);
    return asked.id;
  }

  /** It couldn't be started. */
  askFailed(id) { this.emit('asked-failed', id); }

  // ---- controls -------------------------------------------------------------------------

  send(command) {
    if (this.fake) return this.fake.command(command);
    require('./agents').send('smtc', command);
  }
  /** Whether to say when the desktop comes in front or goes, for the light shown only on the desktop. */
  watchDesk(on) {
    if (on === this.watchingDesk) return;
    this.watchingDesk = on;
    this.send(on ? `watch-desk on ${process.pid}` : 'watch-desk off');
  }

  /** iBaila's desktop windows, top one first (their window handles), for the helper to keep just above the desktop. */
  keepAtDesktop(windows) {
    const handles = windows.filter((w) => w && !w.isDestroyed() && w.isVisible())
      .map((w) => { const b = w.getNativeWindowHandle(); return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0)); }).join(' ');
    if (handles === this.deskWindows) return;
    this.deskWindows = handles;
    this.send(`desk-windows ${handles}`);
  }

  /** Whether picks play in Windows' Apple Music app: it was chosen, or, nothing chosen, it is what plays. */
  get inAppleMusic() { return this.choice === 'appleMusic' || (!this.choice && this.track?.source === 'music'); }

  /** iBaila's own player, when it is what plays. */
  get filePlayer() { const files = require('./main-state').files; return this.track?.source === 'files' && files?.isActive ? files : null; }
  togglePlayback() {
    if (this.filePlayer) this.filePlayer.togglePlayback();
    else if (!this.tellPage(this.playing ? 'pause' : 'play')) this.send('toggle');
  }

  /** Whether the app the song played in still holds it: a browser closed, Spotify quit, and Play has nothing to
   *  resume — the song is started afresh there instead (desktop.js). Before Windows has listed its players, it does. */
  get held() {
    const track = this.track;
    if (!track) return false;
    if (track.source === 'files') return Boolean(this.filePlayer);
    // A page heard through the extension: held while its tab is.
    if (track.viaExtension) return Boolean(require('./extension').extension.followed);
    if (!this.sessions) return true;
    return this.sessions.some((one) => one.app === track.app);
  }
  skipForward() {
    if (this.filePlayer) { this.filePlayer.skipForward(); return; }
    if (this.tellPage('next')) return;
    if (this.track?.source === 'web' && this.web.next()) return;
    this.send('next');
  }
  skipBack() {
    // On the web, the song heard before; elsewhere, within the first few seconds the song before, later this one
    // again from its start, as players do.
    if (this.filePlayer) { this.filePlayer.skipBack(); return; }
    if (this.track?.source === 'web' && this.web.back()) return;
    // Nothing heard before on the web: the page's own back, inside the tab followed.
    if (this.tellPage('previous')) return;
    this.send('previous');
  }
  seek(fraction) {
    if (!this.track?.duration) return;
    const seconds = Math.max(0, Math.min(1, fraction)) * this.track.duration;
    this.clock = { seconds, at: now(), running: this.playing };
    this.soughtAt = now();
    this.changed();
    if (this.filePlayer) this.filePlayer.seek(seconds);
    else if (this.tellPage('seek', seconds)) { /* inside the page */ }
    // Apple Music takes no seeking from Windows' media controls: its own scrubber is moved.
    else if (this.track.source === 'music' && process.platform === 'win32') require('./players').seekInAppleMusic(seconds);
    else this.send(`seek ${seconds.toFixed(2)}`);
  }
  toggleShuffle() {
    if (this.filePlayer) this.filePlayer.setShuffle(!this.shuffle); else this.send(`shuffle ${this.shuffle ? 'off' : 'on'}`);
    this.shuffle = !this.shuffle;
    this.changed();
  }
  cycleRepeat() {
    const next = this.repeat === 'off' ? (this.track?.source === 'spotify' ? 'all' : 'one') : this.repeat === 'one' ? 'all' : 'off';
    // A page followed through the extension: its own repeat button, pressed until it says that one; what it says then
    // is shown — Windows' media controls never reach a page's repeat (2026-10-10: it did nothing on any site).
    const { extension } = require('./extension');
    const followed = extension.followed;
    if (this.track?.viaExtension && followed) {
      const before = this.repeat;
      const turn = this.repeatTurn = (this.repeatTurn || 0) + 1;
      this.repeatPressedAt = Date.now();
      this.repeat = next;
      this.changed();
      extension.tell(followed.browser, followed.tab, followed.site, 'repeat', next).then((answer) => {
        console.log('[web]', followed.site, 'repeat', next, answer ?? 'no answer');
        if (turn !== this.repeatTurn) return;
        const said = ['off', 'one', 'all'].includes(answer) ? answer : before;
        if (this.repeat !== said) { this.repeat = said; this.changed(); }
      });
      return;
    }
    // Apple Music's app: its own button, as Windows' media controls can't reach its repeat.
    if (this.track?.source === 'music' && process.platform === 'win32') {
      const before = this.repeat;
      const turn = this.repeatTurn = (this.repeatTurn || 0) + 1;
      this.repeat = next;
      this.changed();
      require('./players').repeatInAppleMusic(next).then((took) => {
        console.log('[apple] repeat', next, took ?? 'not set');
        if (turn !== this.repeatTurn) return;
        const said = took || before;
        if (this.repeat !== said) { this.repeat = said; this.changed(); }
      });
      return;
    }
    if (this.filePlayer) this.filePlayer.setRepeat(next); else this.send(`repeat ${{ off: 'None', one: 'Track', all: 'List' }[next]}`);
    this.repeat = next;
    this.changed();
  }

  // ---- Windows ----------------------------------------------------------------------------

  startWindows() {
    // smtc.ps1, in the helpers' PowerShell (agents.js).
    const helpers = require('./agents');
    const run = () => {
      if (this.stopped) return;
      helpers.send('smtc', 'start');
      this.preferChosen();
      // The helper keeps iBaila's desktop windows just above the desktop: told them again, now that it is new.
      this.deskWindows = '';
      if (this.watchingDesk) this.send(`watch-desk on ${process.pid}`);
    };
    helpers.listen('smtc', (line) => this.handle(line.trim()), () => setTimeout(run, 3000)); // it stopped: started again
    run();
  }

  handle(line) {
    let data; try { data = JSON.parse(line); } catch { return; }
    if (data.sessions) { this.sessions = data.sessions; this.weigh(data.sessions); return; }
    if ('energySaver' in data) { this.emit('energy-saver', Boolean(data.energySaver)); return; }
    if (data.deskError) { console.log('[desk] keeping the windows above the desktop failed:', data.deskError); return; }
    // A display filled by an app in front (a game, a video in full screen): the light steps aside there.
    // The window in front, while the desk is cleared (cleardesk.js).
    if ('front' in data) { this.emit('front', data.front); return; }
    // The desktop (or iBaila) in front or not, for the light shown only on the desktop.
    if ('desktopFront' in data) { this.emit('desktop-front', Boolean(data.desktopFront)); return; }
    if ('fullscreen' in data) { this.emit('fullscreen', Array.isArray(data.fullscreen) ? data.fullscreen : [data.fullscreen].filter(Boolean)); return; }
    // A browser with iBaila's extension: its pages say what they play themselves (pageSaid); Windows' word for it,
    // one tab's at most, is let be.
    if (sourceOf(data.app) === 'web' && require('./extension').extension.reaches(data.app)) return;
    // Nor does an empty word of Windows' pause a page's song: between songs a browser names nothing for a moment.
    if (this.track?.viaExtension && (data.none || !data.title)) return;
    this.update(data, data.thumb ? Buffer.from(data.thumb, 'base64') : null);
  }

  /** One reading of the player: what it plays, whether, where, and its picture when it sends one. */
  update(data, picture) {
    const at = now();
    if (global.ibailaTrace) global.ibailaTrace(data, this);
    if (data.none || !data.title) {
      if (this.playing) { this.playing = false; if (this.clock) this.clock = { seconds: this.clockSeconds(at), at, running: false }; this.emit('playing', false); this.changed(); }
      return;
    }
    const source = sourceOf(data.app);
    // iBaila's own songs are told by its player directly (fileplayer.js), not by Windows' word for them.
    if (source === 'files' && !data.fromFiles) return;
    const files = require('./main-state').files;
    if (source !== 'files' && this.track?.source === 'files' && files?.playing) {
      // Another app's word while iBaila's own song plays: a paused one is let be; one starting to play takes over, and
      // iBaila's own song falls quiet — one place plays.
      if (!data.playing) return;
      files.pause();
    }
    // Another app than the one chosen: unseen; what it showed until the choice, gone.
    if (!this.allows(source)) {
      if (this.track?.source === source) { this.forget(); this.changed(); }
      return;
    }
    // A browser plays all kinds of pages: a song there names its artist (YouTube Music, SoundCloud), and what doesn't
    // isn't followed.
    if (source === 'web' && !(data.artist || data.albumArtist)) {
      if (this.track?.source === 'web' && this.playing) { this.playing = false; if (this.clock) this.clock = { seconds: this.clockSeconds(at), at, running: false }; this.emit('playing', false); this.changed(); }
      return;
    }
    // Apple Music names no artist while it loads a song ("Bağlanıyor…", "Connecting…"): no song yet.
    if (source === 'music' && !(data.artist || data.albumArtist)) return;
    // A Spotify ad ("İndir ve dinle.", by "Spotify") isn't a song: the song before stays, paused, until music returns.
    if (source === 'spotify' && (/^spotify$/i.test((data.artist || '').trim()) || (!data.artist && /^(advertisement|spotify)$/i.test(data.title.trim())))) {
      if (this.playing) { this.playing = false; if (this.clock) this.clock = { seconds: this.clockSeconds(at), at, running: false }; this.emit('playing', false); this.changed(); }
      return;
    }
    let title = data.title, artist = data.artist || data.albumArtist || '';
    if (source === 'web') {
      // The browser's last word, followed or not: its tab is the one a page picked in iBaila goes to.
      this.lastBrowserTitle = data.title;
      // Which site's page plays, by the browser's tabs: a page that isn't music's — a YouTube video, unless YouTube
      // was chosen — isn't followed. Unknown yet, the song waits for the answer.
      const judged = this.judgeWeb(data, picture);
      if (judged === undefined) return;
      if (!judged.site) {
        if (this.track?.source === 'web' && this.playing) { this.playing = false; if (this.clock) this.clock = { seconds: this.clockSeconds(at), at, running: false }; this.emit('playing', false); this.changed(); }
        return;
      }
      this.webSite = judged.site;
      // Its words as a song's: a SoundCloud upload's "song - singer", a YouTube video's "singer - song (Official Video)".
      if (judged.words) ({ title, artist } = judged.words);
    } else this.webSite = null;
    const next = { title, artist, album: data.album || '', source, app: data.app || '', duration: data.duration || 0, site: this.webSite,
      ...(data.viaExtension ? { viaExtension: true } : {}) };
    // A song of the user's own plays again by its file.
    if (data.playKey) next.playKey = data.playKey;
    next.id = songID(next);
    const isNew = next.id !== this.track?.id;
    const playing = Boolean(data.playing);
    const wasPlaying = this.playing;
    let dirty = false;

    if (isNew) {
      this.web.arrived(this.track, next);
      this.track = next;
      this.clock = { seconds: data.position || 0, at, running: playing };
      this.playing = playing;
      const file = artwork.keyFor(next);
      const known = artwork.has(file) ? file : null;
      this.artworkFile = known;
      this.artworkSongID = known ? next.id : null;
      this.history.record(next, known, playing);
      // A song iBaila just started in Spotify by its ID: the ID is known without reading Spotify's window.
      const asked = this.expected;
      if (asked && now() - asked.at < 30 && plain(next.title) === asked.title) {
        this.expected = null;
        next.playKey = asked.uri;
        this.history.setPlayKey(next.id, asked.uri);
      }
      this.emit('track', next);
      if (source === 'spotify') this.readSpotifyIDs(next);
      // Every song from 0:15, past its intro, when the user asks for it — a song begun from its start, long enough.
      if (playing && require('./settings').get().general?.startLater && (data.position || 0) < 3 && next.duration > 40) {
        setTimeout(() => { if (this.track?.id === next.id && this.clockSeconds(now()) < 10) this.seek(15 / next.duration); }, 400);
      }
      dirty = true;
    } else if (next.duration && next.duration !== this.track.duration) {
      this.track = { ...this.track, duration: next.duration };
      dirty = true;
    }
    // The same song, now told by its page itself.
    if (!isNew && Boolean(data.viaExtension) !== Boolean(this.track.viaExtension)) {
      const { viaExtension, ...rest } = this.track;
      this.track = data.viaExtension ? { ...rest, viaExtension: true } : rest;
    }
    if (picture && global.ibailaKeepPicture) global.ibailaKeepPicture(next, picture);
    // A browser hands Windows its own icon as the picture until the page gives the song's: never taken as a cover.
    if (picture && isIcon(picture)) picture = null;
    // A YouTube video's picture is a frame of it: its song's square cover, found on YouTube Music, stays.
    if (picture && this.coverFromWeb !== next.id && this.takePicture(next, picture)) dirty = true;
    // A player that sends no picture, or a video's frame: the song's cover is looked up instead.
    if (isNew && (!this.artworkFile || next.site === 'youTube')) {
      clearTimeout(this.artTimer);
      this.artTimer = setTimeout(() => this.findArtwork(next, next.site === 'youTube'), next.playKey ? 300 : next.site ? 900 : 2500);
    }
    if (playing !== wasPlaying) {
      this.playing = playing;
      if (playing && !isNew) this.history.markPlayed(next.id);
      this.emit('playing', playing);
      dirty = true;
    }
    // The clock runs on its own between readings; it is set again only when it has drifted (a seek) or the
    // song stopped or started.
    if (typeof data.position === 'number' && !isNew) {
      const expected = this.clockSeconds(at);
      // Just after a seek the player may still say where it was: the slider isn't pulled back for that.
      const settling = this.soughtAt && at - this.soughtAt < 4;
      // A player that says it plays but whose place hasn't moved since its last word — a browser no longer telling
      // its place after a pause and a resume — is no correction: pulled back to that place every two seconds, the
      // lyrics stood still (a friend's PC, 2026-10-09). The clock runs on by itself.
      const heard = this.lastHeard;
      const stale = playing && heard?.playing && heard.id === this.track?.id && Math.abs(data.position - heard.position) < 0.25 && at - heard.at > 1.5;
      if ((Math.abs(expected - data.position) > 1.5 && !settling && !stale) || this.clock?.running !== playing) {
        this.clock = { seconds: data.position, at, running: playing };
        dirty = true;
      }
      this.lastHeard = { id: this.track?.id, playing, position: data.position, at };
    }
    const shuffle = data.shuffle ?? this.shuffle;
    const repeat = data.repeat ? ({ None: 'off', Track: 'one', List: 'all' }[data.repeat] || 'off') : this.repeat;
    if (shuffle !== this.shuffle || repeat !== this.repeat) { this.shuffle = shuffle; this.repeat = repeat; dirty = true; }
    if (data.can && JSON.stringify(data.can) !== JSON.stringify(this.can)) { this.can = data.can; dirty = true; }
    if (dirty) this.changed();
  }

  /** iBaila is starting a song in Spotify by its ID: when it plays, its ID is known at once. */
  expect(uri, title) { this.expected = { uri, title: plain(title), at: now() }; }

  /** A song started through Spotify's search turned out to have this ID: the song playing takes it, if it is that one,
   *  and the song about to play does when it comes. */
  learn(uri, title) {
    const track = this.track;
    if (track && !track.playKey && plain(track.title) === plain(title)) {
      this.history.setPlayKey(track.id, uri);
      this.track = { ...track, playKey: uri };
      this.emit('spotify-ids', this.track);
      this.changed();
    } else this.expect(uri, title);
  }

  /** Keeps a song's picture (bytes) as its artwork; answers whether it took. */
  takePicture(track, bytes) {
    const file = artwork.save(track, bytes);
    if (!file) return false;
    this.artworkFile = file;
    this.artworkSongID = track.id;
    this.history.setArtwork(track.id, file);
    this.emit('artwork', artwork.file(file));
    return true;
  }

  /** The cover of a song its player sent no picture for: Spotify's own by the song's ID, else the album's in the
   *  iTunes catalog. */
  async findArtwork(track, sharper = false) {
    if (this.track?.id !== track.id) return;
    // A picture there already is swapped only for a sharper one (Spotify sends Windows a small one), or a video's
    // frame for its song's cover.
    if (this.artworkSongID === track.id && !(sharper && (track.site === 'youTube' || artwork.widthOf(this.artworkFile) < 480))) return;
    const had = this.artworkSongID === track.id ? this.artworkFile : null;
    let link = null;
    const key = this.track.playKey;
    if (key?.startsWith('spotify:track:')) {
      // A cover known from the list already, at its biggest (Spotify names its 640-pixel copy so), else from Spotify.
      const known = require('./spotifyweb').knownCover(key);
      link = known?.includes('ab67616d00001e02') ? known.replace('ab67616d00001e02', 'ab67616d0000b273')
        : (await require('./spotifyweb').track(key))?.art || null;
    }
    // A browser's song: its own cover on the site it plays on.
    if (!link && track.source === 'web' && track.site) {
      link = await require('./webmusic').cover({ title: track.title, artist: track.artist, site: track.site }).catch(() => null);
      if (link && track.site === 'youTube') this.coverFromWeb = track.id;
    }
    if (!link && !had) {
      try {
        const term = encodeURIComponent(`${track.artist.split(/,|&/)[0]} ${(track.album || track.title).replace(/ - (Single|EP)$/, '')}`);
        const found = await (await fetch(`https://itunes.apple.com/search?term=${term}&entity=album&limit=1`, { signal: AbortSignal.timeout(8000) })).json();
        link = found.results?.[0]?.artworkUrl100?.replace('100x100bb', '512x512bb') || null;
      } catch { /* offline */ }
    }
    const still = () => this.track?.id === track.id && (this.artworkSongID !== track.id || this.artworkFile === had);
    if (!link || !still()) return;
    try {
      const bytes = Buffer.from(await (await fetch(link, { signal: AbortSignal.timeout(10000) })).arrayBuffer());
      if (still() && this.takePicture(this.track, bytes)) this.changed();
    } catch { /* offline */ }
  }

  /** Spotify tells Windows a song's name but not its ID, which is what plays it again: it is read from Spotify's
   *  own window a moment after the song starts, once Spotify shows it. */
  readSpotifyIDs(track) {
    clearTimeout(this.idTimer);
    this.idTimer = setTimeout(async () => {
      if (this.track?.id !== track.id) return;
      const known = this.history.songs.find((s) => s.id === track.id)?.playKey;
      let ids = this.fakeIDs?.[track.title] || null;
      if (!ids && !(known && known.startsWith('spotify:track:'))) ids = await require('./players').readSpotifyNow(track.title);
      if (this.track?.id !== track.id) return;
      const playKey = ids?.track ? `spotify:track:${ids.track}` : known || '';
      if (playKey) this.history.setPlayKey(track.id, playKey);
      this.track = { ...this.track, playKey, spotifyAlbum: ids?.album || null, spotifyArtists: ids?.artists || [] };
      this.emit('spotify-ids', this.track);
      this.changed();
      if (playKey) this.findArtwork(this.track, true);
    }, 1200);
  }

  clockSeconds(at) {
    if (!this.clock) return 0;
    return this.clock.running ? this.clock.seconds + (at - this.clock.at) : this.clock.seconds;
  }

  // ---- a made-up player, for building on the Mac ----------------------------------------------

  startFake() {
    this.fakeIDs = { ISSA: { track: '7medoAnENNaeVAHQbGcOMK', album: '5SLGlw14A9KHD5CK6ZNcKQ', artists: [{ name: 'Sido', id: '4Yttlv9ndGjCDCVLqM7ACq' }] } };
    const songs = [
      { title: 'ISSA', artist: 'Sido', album: 'ISSA - Single', duration: 145 },
      { title: 'Ghostface Killers (feat. Travis Scott)', artist: '21 Savage, Offset & Metro Boomin', album: 'Without Warning', duration: 268 },
      { title: 'No Heart', artist: '21 Savage & Metro Boomin', album: 'Savage Mode', duration: 229 },
      { title: 'Run Away', artist: 'Khaid & Gyakie', album: 'Run Away - Single', duration: 176 },
      { title: 'Empty', artist: 'Juice WRLD', album: 'Death Race for Love', duration: 247 },
    ];
    // IBAILA_FAKE_SONG picks the song to start with, IBAILA_FAKE_AT where in it.
    let index = Number(process.env.IBAILA_FAKE_SONG || 0), position = Number(process.env.IBAILA_FAKE_AT || 0), playing = true, last = now();
    const pictures = {};
    const fetchPicture = async (song) => {
      if (pictures[song.album]) return pictures[song.album];
      try {
        const term = encodeURIComponent(`${song.artist.split(/,|&/)[0]} ${song.album.replace(' - Single', '')}`);
        const found = await (await fetch(`https://itunes.apple.com/search?term=${term}&entity=album&limit=1`)).json();
        const link = found.results?.[0]?.artworkUrl100?.replace('100x100bb', '512x512bb');
        if (link) pictures[song.album] = Buffer.from(await (await fetch(link)).arrayBuffer());
      } catch { /* offline */ }
      return pictures[song.album];
    };
    const report = async (withPicture) => {
      const t = now();
      if (playing) position += t - last;
      last = t;
      const song = songs[index];
      if (position >= song.duration) { index = (index + 1) % songs.length; position = 0; return report(true); }
      this.update({ ...song, app: 'Spotify.exe', playing, position, shuffle: false, repeat: 'None',
        can: { next: true, previous: true, seek: true, shuffle: true, repeat: true } }, withPicture ? await fetchPicture(song) : null);
    };
    this.fake = {
      command: (text) => {
        const [name, value] = text.split(' ');
        if (name === 'toggle') { report(false); playing = !playing; }
        if (name === 'next') { index = (index + 1) % songs.length; position = 0; }
        if (name === 'previous') { if (position > 3) position = 0; else { index = (index + songs.length - 1) % songs.length; position = 0; } }
        if (name === 'seek') position = Number(value);
        report(name === 'next' || name === 'previous');
      },
    };
    setTimeout(() => report(true), 400);
    setInterval(() => report(false), 2000);
  }

  stop() { this.stopped = true; require('./agents').stop(); }
}

module.exports = { NowPlaying, sourceOf, CHOICES, NAMES };
