// The heart in the bar (Likes.swift): the song playing liked where it plays, and the like taken back. YouTube Music,
// SoundCloud and Spotify keep it on the user's account there, asked through iJWA's extension inside a page signed
// in — the song's own tab, or, for Spotify's app, a Web Player tab (opened behind the others when the heart is
// pressed and there is none). Apple Music's app and the user's own files: no heart, for now.
const { extension } = require('./extension');

const SITES = new Set(['youTubeMusic', 'soundCloud', 'spotifyWeb']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Likes {
  liked = false;
  canLike = false;
  turn = 0;

  constructor(nowPlaying) {
    this.np = nowPlaying;
    nowPlaying.on('track', () => this.read());
    // A song's place told after the song itself — Spotify's app gives its address a moment later, a page is followed
    // once it says what it plays — the heart comes then.
    nowPlaying.on('spotify-ids', () => { if (!this.canLike) this.read(); });
    nowPlaying.on('state', () => { if (!this.canLike && this.place()) this.read(); });
  }

  /** Where the song playing can be liked: its page, or Spotify's song by its address. */
  place() {
    const track = this.np.track;
    if (!track) return null;
    const followed = extension.followed;
    if (track.viaExtension && followed && SITES.has(followed.site)) return { kind: 'page', browser: followed.browser, tab: followed.tab, site: followed.site };
    if (track.source === 'spotify' && /^spotify:track:\w+$/.test(track.playKey || '') && extension.browsers().length) return { kind: 'spotify', uri: track.playKey };
    return null;
  }

  /** A new song: whether it's liked, read a moment later, once its page has it. */
  read() {
    const turn = ++this.turn;
    const place = this.place();
    const before = `${this.liked}|${this.canLike}`;
    this.liked = false;
    this.canLike = Boolean(place);
    if (`${this.liked}|${this.canLike}` !== before) this.np.changed();
    if (!place) return;
    // Asked again when the page couldn't say yet (it was still taking the new song in).
    const ask = async (wait, tries) => {
      await sleep(wait);
      if (turn !== this.turn) return;
      const answer = await this.at(place, null, false);
      if (turn !== this.turn) return;
      if (answer == null) { if (tries > 1) ask(2500, tries - 1); return; }
      if (answer === this.liked) return;
      this.liked = answer;
      this.np.changed();
    };
    ask(700, 3);
  }

  /** The heart pressed: liked at once, as the user sees it; taken back if the place says no. */
  async toggle() {
    const place = this.place();
    if (!place) return;
    const turn = ++this.turn;
    const want = !this.liked;
    this.liked = want;
    this.np.changed();
    const answer = await this.at(place, want, true);
    if (turn !== this.turn || answer === want) return;
    console.log('[likes] could not', want ? 'like' : 'unlike', this.np.track?.title);
    this.liked = !want;
    this.np.changed();
  }

  /** Asks (`on` null) or sets whether the song is liked at `place`. */
  async at(place, on, opening) {
    // YouTube Music's song by the id its page told with it: not whatever its player holds a moment later.
    if (place.kind === 'page') return extension.like(place.browser, place.tab, place.site, { on, id: place.site === 'youTubeMusic' ? this.np.pageSong || null : null });
    // Spotify's app: in a Web Player tab of the browser listened in; with none and the heart pressed, one opened behind.
    const name = extension.pick();
    if (!name) return null;
    let tab = ((await extension.tabs(name)) || []).find((t) => t.site === 'spotifyWeb')?.id ?? null;
    let opened = false;
    if (tab == null && opening) { tab = await extension.open(name, 'https://open.spotify.com/', { behind: true }); opened = tab != null; }
    if (tab == null) return null;
    let answer = await extension.like(name, tab, 'spotifyWeb', { id: place.uri, on });
    // A page just opened: asked again as it comes up.
    for (let i = 0; opened && answer == null && i < 6; i++) {
      await sleep(2000);
      answer = await extension.like(name, tab, 'spotifyWeb', { id: place.uri, on });
    }
    return answer;
  }
}

module.exports = { Likes };
