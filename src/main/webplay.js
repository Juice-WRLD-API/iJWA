// Songs picked in iJWA, played on the web where the user listens (NowPlaying.playOnWeb): found on that site —
// YouTube Music, SoundCloud, YouTube — and opened in the browser, kept behind, the site's old tab closing; a page that
// doesn't start by itself (SoundCloud's) has its own Play pressed. The back button goes back through the songs heard
// there, as a player's does: the site's own goes back only within its list.
const webmusic = require('./webmusic');
const browser = require('./browser');
const { simple, matches } = require('./names');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MUSIC = new Set(['youTubeMusic', 'soundCloud', 'spotifyWeb']);

class WebPlay {
  pages = new Map();   // a song's words → its page, as it was asked for
  before = [];         // the songs heard on the web before the one playing, the last one last
  goingBack = false;

  constructor(nowPlaying) { this.nowPlaying = nowPlaying; }

  /** The site the user listens on, for search to search and picks to play on: the one chosen, else the browser's
   *  playing; null when they listen elsewhere. */
  get site() {
    const np = this.nowPlaying;
    if (np.chosenSite) return np.chosenSite;
    if (!np.choice && np.track?.source === 'web') return np.track.site || null;
    return null;
  }

  /** Something to play: `{ kind: 'song'|'album'|'artist', title, artist, link }` — by its own page when it has one,
   *  else found by name on the site listened on. */
  async play(item) {
    const site = this.site || 'youTubeMusic';
    const title = item.kind === 'song' ? item.title : null;
    if (item.link) {
      const at = webmusic.siteAtAddress(item.link) || site;
      // Where the user chose to listen comes first: something of another site — a list or results kept from before the
      // source changed — is looked for there by its name. Found nowhere there, it plays on its own site, chosen then.
      const np = this.nowPlaying;
      const chosen = np.chosenSite;
      if (chosen && MUSIC.has(at) && at !== chosen && item.title) {
        const there = await this.find(item, chosen).catch(() => null);
        if (there) return this.open(there, chosen, title);
        np.pickSite(at);
      } else if (np.choice && !chosen && MUSIC.has(at)) {
        // A web song picked while an app is chosen (a list kept from before): its site becomes the choice, so it plays
        // there and is followed.
        np.pickSite(at);
      }
      // Listening on YouTube itself: YouTube Music's song plays there, by the same ID.
      const onYouTube = at === 'youTubeMusic' && site === 'youTube' ? webmusic.onYouTube(item.link) : null;
      return this.open(onYouTube || item.link, onYouTube ? 'youTube' : at, title);
    }
    const found = await this.find(item, site).catch(() => null);
    if (!found) { console.log('[web] not found on', site, item.kind, item.title); return false; }
    return this.open(site === 'youTube' ? webmusic.onYouTube(found) || found : found, site, title);
  }

  /** A song, album or artist found on a site by its name: its address there. */
  async find(item, site) {
    if (site === 'spotifyWeb') return this.findOnSpotify(item);
    const onSoundCloud = site === 'soundCloud';
    const find = {
      artist: () => (onSoundCloud ? webmusic.soundCloudArtist(item.title) : webmusic.youTubeArtist(item.title)),
      album: () => (onSoundCloud ? webmusic.soundCloudAlbum(item.title, item.artist) : webmusic.youTubeAlbum(item.title, item.artist)),
      song: () => (onSoundCloud ? webmusic.soundCloudTrack(item.title, item.artist) : webmusic.youTubeSong(item.title, item.artist)),
    }[item.kind] || (() => null);
    return find();
  }

  /** On Spotify's Web Player, found the way Spotify's app finds it (NowPlaying.find): its Spotify ID by name through the
   *  open music encyclopedia, made the page's address; else Spotify's own search in the tab (searchSpotifyPage). */
  async findOnSpotify(item) {
    const spotify = require('./spotifyweb');
    const uri = await (item.kind === 'album' ? spotify.albumURI(item.title, item.artist)
      : item.kind === 'artist' ? spotify.artistURI(item.title)
        : spotify.songURI(item.title, item.artist, item.album || '')).catch(() => null);
    if (uri) { const [, kind, id] = uri.split(':'); return `https://open.spotify.com/${kind}/${id}`; }
    return this.searchSpotify(item);
  }

  /** Spotify's own search, in the Web Player's tab — the music tab taken there, else a new tab, shown as a page starts
   *  only once its tab has been — signed in or not: the address of the result bearing the name. */
  async searchSpotify(item) {
    const { extension } = require('./extension');
    const name = extension.pick(this.nowPlaying.track?.viaExtension ? this.nowPlaying.track.app : null);
    if (!name) return null;
    const tabs = (await extension.tabs(name)) || [];
    let tab = tabs.find((t) => t.site === 'spotifyWeb')?.id ?? null;
    if (tab == null) {
      const other = tabs.find((t) => MUSIC.has(t.site));
      if (other && (await extension.tell(name, other.id, other.site, 'go', 'https://open.spotify.com/')) != null) tab = other.id;
      else tab = await extension.open(name, 'https://open.spotify.com/');
      if (tab == null) return null;
      await sleep(4000);
    }
    const kind = item.kind === 'album' ? 'album' : item.kind === 'artist' ? 'artist' : 'track';
    const answer = await extension.tell(name, tab, 'spotifyWeb', 'find', { kind, title: item.title, artist: item.artist || '' }, 12000);
    console.log("[web] Spotify's own search for", item.title, '→', answer ?? 'no answer');
    return answer?.startsWith('https://') ? answer : null;
  }

  /** A song of an album on Spotify's Web Player, played in the album: the album found by Spotify's own search, the song
   *  in its list by its title, and the page's own player asked to play it there (page.js 'playIn'). */
  async playInSpotifyAlbum(song, album, artist) {
    const page = await this.findOnSpotify({ kind: 'album', title: album, artist }).catch(() => null);
    const id = page?.match(/\/album\/([A-Za-z0-9]+)/)?.[1];
    if (!id) return false;
    const list = `spotify:album:${id}`;
    const songs = await require('./spotifyweb').albumSongs(list);
    const { whole, simple } = require('./names');
    const at = songs.findIndex((s) => whole(s.title) === whole(song.title));
    const index = at >= 0 ? at : songs.findIndex((s) => simple(s.title) === simple(song.title));
    if (index < 0) return false;
    return this.playInSpotifyList(songs[index].uri, index, list);
  }

  /** A song played in one of Spotify's lists — an album, a playlist, the songs liked — in the Web Player's tab, by the
   *  page's own player, the list going on after it (NowPlaying.playInSpotifyList). */
  async playInSpotifyList(track, index, list) {
    const { extension } = require('./extension');
    const name = extension.pick(this.nowPlaying.track?.viaExtension ? this.nowPlaying.track.app : null);
    if (!name) return false;
    const tabs = (await extension.tabs(name)) || [];
    let tab = tabs.find((t) => t.site === 'spotifyWeb') || tabs.find((t) => MUSIC.has(t.site));
    for (const other of tabs) if (other.id !== tab?.id) extension.tell(name, other.id, other.site, 'pause');
    const parts = list.split(':');
    const page = ['playlist', 'album'].includes(parts[1]) ? `https://open.spotify.com/${parts[1]}/${parts[2]}` : 'https://open.spotify.com/collection/tracks';
    if (!tab) {
      const made = await extension.open(name, page);
      if (made == null) return false;
      tab = { id: made, site: 'spotifyWeb' };
    } else if (tab.site !== 'spotifyWeb') {
      await extension.tell(name, tab.id, tab.site, 'go', page);
    }
    this.opened = { site: 'spotifyWeb', at: Date.now() };
    // A page just opened has no player yet: asked again a moment later.
    for (const wait of [0, 2000, 2000, 3000, 3000]) {
      if (wait) await sleep(wait);
      const answer = await extension.tell(name, tab.id, 'spotifyWeb', 'playIn', { list, track, index: String(index) }, 15000);
      console.log('[web] played in its list:', answer ?? 'no answer');
      if (answer == null || answer.startsWith('wait') || answer === 'none no player') continue;
      const played = answer.startsWith('played') || answer.startsWith('pressed');
      if (played) this.letLoad(name, tab.id, 'spotifyWeb', null);
      return played;
    }
    return false;
  }

  /** Play with nothing followed and a site chosen (NowPlaying.startOnWeb): its tab plays on, else Continue Playing's
   *  first song starts. */
  async startSite() {
    const np = this.nowPlaying;
    const site = np.chosenSite;
    if (!site) return false;
    const { extension } = require('./extension');
    const name = extension.pick();
    const tab = name ? ((await extension.tabs(name)) || []).find((t) => t.site === site) : null;
    // Done unless the page had nothing to press (SoundCloud answers what it pressed: "pressed:…", "playing:…").
    const answer = tab ? await extension.tell(name, tab.id, site, 'play') : null;
    if (answer != null && !answer.startsWith('none') && !answer.startsWith('wait')) return true;
    const first = require('./main-state').panel?.web?.songs?.[0];
    if (!first) return false;
    return this.play({ kind: 'song', title: first.title, artist: first.artist, link: first.link || null });
  }

  /** Takes the browser there, and should the page not start by itself, presses its Play. */
  async open(url, site, title) {
    const np = this.nowPlaying;
    if (title) this.pages.set(simple(title), url);
    const track = np.track;
    const fromWeb = track?.source === 'web';
    // What plays in the browser for a while now is this site's.
    this.opened = { site, at: Date.now() };
    // With iJWA's extension: in the page itself, one tab for every site, nothing typed and nothing coming forward
    // (the page's own leaving asks no "Leave site?").
    if (MUSIC.has(site)) {
      const told = await this.openInPage(url, site, title, track?.id);
      if (told != null) return told;
    }
    // YouTube Music asks "Leave site?" when its tab goes while it plays: paused first, it goes quietly.
    if (fromWeb && np.playing && !track.viaExtension) { np.send(`pause-app ${track.app}`); await sleep(350); }
    const opened = await browser.open(url, { site, app: fromWeb ? track.app : '', playing: fromWeb ? track.title : np.lastBrowserTitle || '', title: title || '' });
    // Pressed while the browser showed the page, it is given a moment to start; then, as for any page, looked at, and
    // pressed if it still doesn't play.
    if (opened) this.startIfStill(site, title, track?.id, opened.pressed ? 6000 : 2500);
    return Boolean(opened);
  }

  /** The page taken there through the extension (NowPlaying.playOnWeb): the site's tab, else another music site's —
   *  one tab for all of them (his call, 2026-10-09) — else a new tab; the other music tabs fall quiet. Started inside
   *  the page should it not start by itself. Whether it went; null when the extension can't be asked. */
  async openInPage(url, site, title, before) {
    const { extension } = require('./extension');
    const np = this.nowPlaying;
    const name = extension.pick(np.track?.viaExtension ? np.track.app : null);
    if (!name) return null;
    const tabs = await extension.tabs(name);
    if (!tabs) return null;
    const own = tabs.find((t) => t.site === site) || tabs.find((t) => MUSIC.has(t.site));
    for (const other of tabs) if (other.id !== own?.id) extension.tell(name, other.id, other.site, 'pause');
    let tab = null;
    // Sent on by the page it is in: another site's, when one tab serves both.
    if (own && (await extension.tell(name, own.id, own.site, 'go', url)) != null) tab = own.id;
    if (tab == null) tab = await extension.open(name, url);
    console.log('[web] open in the page', url, tab != null ? `(tab ${tab}${own ? `, was ${own.site}` : ', new'})` : 'failed');
    if (tab == null) return false;
    this.startInPage(name, tab, site, url, title, before);
    this.letLoad(name, tab, site, title);
    return true;
  }

  /** A page that never played holds its song back while it isn't seen — its window minimized, or covered by others:
   *  Chromium keeps a hidden page's media from loading (the test machine, 2026-10-10: stuck at 0:15 until Opera was
   *  shown). Should the song not run a moment after it was asked for and the page say it holds it back, its window is
   *  shown unseen a moment (web-agent.ps1 LetLoad); put back, it plays on. Its tab must be the one its window shows. */
  async letLoad(name, tab, site, title) {
    if (process.platform !== 'win32') return;
    const { extension } = require('./extension');
    const np = this.nowPlaying;
    for (const wait of [2500, 3500, 4000]) {
      await sleep(wait);
      if (np.playing && np.pageRate > 0 && np.track?.source === 'web' && (!title || matches(np.track, title))) return;
      if ((await extension.tell(name, tab, site, 'held')) !== 'held') continue;
      const held = ((await extension.tabs(name)) || []).find((t) => t.id === tab);
      if (!held?.active) return;
      // SoundCloud skips on when minimized the moment it starts: given longer.
      await browser.letLoad(name, held.title, site === 'soundCloud' ? 4500 : 2500);
    }
  }

  /** A page changing its own address takes a moment: looked at often, started only once it is there and if it
   *  doesn't play by itself. */
  async startInPage(name, tab, site, url, title, before) {
    const { extension } = require('./extension');
    let path = '';
    try { path = new URL(url).pathname; } catch { /* not an address */ }
    for (const wait of [2000, 1500, 1500, 2000, 2500]) {
      await sleep(wait);
      const np = this.nowPlaying;
      const started = np.playing && np.track?.source === 'web' && (title ? matches(np.track, title) : np.track.id !== before);
      if (started) return;
      const answer = await extension.tell(name, tab, site, 'start', path);
      console.log('[web] start', site, answer ?? 'no answer');
    }
  }

  /** Looked at a few times, pressed only while the song isn't playing (its page's own button says Play, not Pause): a
   *  page changing takes a moment. */
  async startIfStill(site, title, before, first = 2500) {
    for (const wait of [first, 3000, 3500]) {
      await sleep(wait);
      const np = this.nowPlaying;
      const started = np.playing && np.track?.source === 'web' && (title ? matches(np.track, title) : np.track.id !== before);
      if (started) return;
      await browser.press(site, 'play');
    }
  }

  // ---- the songs heard before ----

  /** A new song on the web: the one before it is remembered for the back button — unless going back brought it. */
  arrived(previous, track) {
    if (!previous || previous.source !== 'web' || track.source !== 'web' || previous.id === track.id) return;
    if (this.goingBack) { this.goingBack = false; return; }
    this.before.push(previous);
    if (this.before.length > 50) this.before.shift();
  }

  /** Back: the song heard before, by the page it was asked by, else found again; with none, the site's own back —
   *  SoundCloud's own button, as its page doesn't answer Windows' media keys for it. Answers whether it went. */
  back() {
    const np = this.nowPlaying;
    const previous = this.before.pop();
    if (!previous) {
      // The page's own back: inside the tab through the extension (nowplaying's skipBack), else SoundCloud's button.
      if (np.track?.site === 'soundCloud' && !np.track.viaExtension) { browser.press('soundCloud', 'previous'); return true; }
      return false;
    }
    this.goingBack = true;
    const song = np.history.songs.find((s) => s.id === previous.id);
    const asking = np.ask({ title: previous.title, artist: previous.artist, picture: song?.artworkFile ? `ijwa://app/artwork/${song.artworkFile}` : null });
    (async () => {
      // Its page by the words it was asked by — "Classy - Juice WRLD" is shown as Classy, by Juice WRLD.
      const page = [previous.title, `${previous.title} ${previous.artist}`, `${previous.artist} ${previous.title}`]
        .map((words) => this.pages.get(simple(words))).find(Boolean);
      const started = page ? await this.open(page, previous.site || this.site || 'youTubeMusic', previous.title)
        : await this.play({ kind: 'song', title: previous.title, artist: previous.artist });
      if (started) return;
      this.goingBack = false;
      np.askFailed(asking);
    })();
    return true;
  }

  /** Next: SoundCloud's own button; anywhere else, Windows' media key reaches the page. */
  next() {
    if (this.nowPlaying.track?.site !== 'soundCloud' || this.nowPlaying.track.viaExtension) return false;
    browser.press('soundCloud', 'next');
    return true;
  }
}

module.exports = { WebPlay };
