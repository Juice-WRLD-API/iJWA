// What plays next where the user listens — the panel's Queue (PlayQueue.swift; his ask, 2026-10-12, from a customer who
// wanted "the queue on the side instead of going to Spotify and changing it"): the song playing first, then what
// follows, read from wherever it plays, and any of it played from there with a click.
//
// - Spotify's app: its own queue — the songs lined up, then what it carries on with — through the PlayerAPI its queue
//   page uses (spotifyinside.js).
// - Spotify's Web Player, YouTube Music and SoundCloud: the queue their page keeps, read by the browser extension.
// - iJWA's own player (the user's folders): its own queue (fileplayer.js).
// - Windows' Apple Music app: it shares nothing of what it plays next, so there is none to show. (The Mac's Music app
//   gives the rest of the album or playlist it plays from, and the Mac's own catalog player its queue: neither is here.)
const { EventEmitter } = require('events');
const spotify = require('./spotifyinside');
const { extension } = require('./extension');
const shared = require('./main-state');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (...words) => console.log('[queue]', ...words);

/** A site's name as a site (WebMusic.Site.name): Spotify's Web Player is "Spotify" there. */
const SITE_NAMES = { youTubeMusic: 'YouTube Music', soundCloud: 'SoundCloud', youTube: 'YouTube', spotifyWeb: 'Spotify' };

/** What is said once a song was lined up, or couldn't be (Notice.queued, Notice.notQueued). */
const NOTICES = {
  queued: (next) => ({ title: next ? 'Plays next' : 'Added to the queue', detail: '' }),
  notQueued: { title: 'Couldn’t add it to the queue', detail: 'It wasn’t found where this song plays.' },
};

/** A YouTube video's ID, from a link to it ("…watch?v=…"). */
function videoOf(link) {
  try { return new URL(link).searchParams.get('v') || null; } catch { return null; }
}

class PlayQueue extends EventEmitter {
  /** Each { id — where it plays from, the way its player names it: what a click on it plays — title, artist, album,
   *  duration, artwork (its picture's address), artworkFile (its cover saved already, by iJWA), isCurrent, isQueued
   *  (lined up by the user, not what the player carries on with) }. */
  songs = [];
  isLoading = false;
  /** The second line under the list's name: where the queue is read, or why there is none. */
  note = 'Play a song to see what’s next';
  /** The song the queue was last read for, and the reading under way (a newer one, or a change, leaves it be). */
  readFor = null;
  reading = 0;

  constructor(nowPlaying) {
    super();
    this.nowPlaying = nowPlaying;
    // Whether Spotify plays, so reading its queue never starts it again mid-song.
    spotify.useHelper(nowPlaying);
  }

  changed() { this.emit('change'); }

  /** The song playing, as the queue is read for it: where it plays, and which. */
  key() {
    const track = this.nowPlaying.track;
    return track ? `${track.source}:${track.id}` : null;
  }

  /** iJWA's own player, when it is what plays. */
  get files() { return shared.files; }

  /** Read again for the song playing, if it wasn't already, or always when `again`. */
  refresh(again = false) {
    const key = this.key();
    if (!again && key === this.readFor) return;
    this.readFor = key;
    const run = ++this.reading;
    this.isLoading = true;
    this.changed();
    (async () => {
      // A song just started: its player says what follows a moment after.
      if (!again) await sleep(600);
      if (run !== this.reading) return;
      const { songs, note } = await this.read();
      if (run !== this.reading) return;
      this.songs = songs;
      this.note = note;
      this.isLoading = false;
      this.changed();
    })();
  }

  /** Plays song `index` of the queue where it is: whether its player took it. */
  async play(index) {
    const song = this.songs[index];
    const track = this.nowPlaying.track;
    if (!song || !track) return false;
    let played = false;
    if (track.source === 'spotify') played = await spotify.skipTo(song.id);
    else if (track.source === 'web') played = await extension.playInQueue(song.id);
    else if (track.source === 'files') played = Boolean(this.files?.skip(song.id));
    // Apple Music's app: it shares no queue to play from.
    // What follows has changed: read again once the song has.
    if (played) this.settle();
    return played;
  }

  // ---- changing it ----

  /** Whether songs can be added where the song playing plays: Apple Music's app and SoundCloud take none from outside.
   *  A song to add is { title, artist, album, spotifyURI, youTubeID, file }, with whatever IDs it is known by where it
   *  came from; any it lacks is found by name. */
  get canAdd() {
    const source = this.nowPlaying.track?.source;
    if (source === 'spotify' || source === 'files') return true;
    if (source === 'web') return ['spotifyWeb', 'youTubeMusic'].includes(extension.followed?.site || '');
    return false;
  }

  /** Whether song `index` can be taken out: not the one playing, and not from Apple Music's app. */
  canRemove(index) {
    const song = this.songs[index];
    if (!song || song.isCurrent) return false;
    return this.nowPlaying.track?.source !== 'music';
  }

  /** Takes song `index` out of the queue: whether it was. */
  async remove(index) {
    const track = this.nowPlaying.track;
    if (!this.canRemove(index) || !track) {
      log(`remove from the queue: row ${index} can't be taken out`);
      return false;
    }
    const id = this.songs[index].id;
    let done = false;
    if (track.source === 'spotify') done = await spotify.remove(id);
    else if (track.source === 'web') done = await extension.removeFromQueue(id);
    else if (track.source === 'files') done = Boolean(this.files?.remove(id));
    // Gone at once from the list; read again until its player has it gone too.
    if (done) {
      this.songs = this.songs.filter((s) => s.id !== id);
      this.changed();
      await this.confirm((songs) => !songs.some((s) => s.id === id));
    }
    return done;
  }

  /** Adds `song` to the queue where the song playing plays, next or after the songs lined up: whether it went in. */
  async add(song, next) {
    const track = this.nowPlaying.track;
    if (!track || !song) return false;
    let done = false;
    if (track.source === 'spotify') {
      const uri = song.spotifyURI || await spotify.search('track', song.title, song.artist);
      done = uri ? await spotify.add(uri, next) : false;
    } else if (track.source === 'web' && extension.followed?.site === 'spotifyWeb') {
      const uri = song.spotifyURI || await require('./spotifyweb').songURI(song.title, song.artist, song.album).catch(() => null);
      done = uri ? await extension.addToQueue(uri, next) : false;
    } else if (track.source === 'web') {
      let video = song.youTubeID;
      if (!video) {
        const link = await require('./webmusic').youTubeSong(song.title, song.artist).catch(() => null);
        if (link) video = videoOf(link);
      }
      done = video ? await extension.addToQueue(video, next) : false;
    } else if (track.source === 'files') {
      done = song.file ? Boolean(this.files?.add(song.file, next)) : false;
    }
    // Read again until its player has it lined up.
    if (done) {
      const same = (s) => s.title.toLowerCase() === String(song.title).toLowerCase();
      const before = this.songs.filter(same).length;
      await this.confirm((songs) => songs.filter(same).length > before);
    }
    return done;
  }

  /** Reads the queue again until `shows` holds for it — a player takes a change and shows it a moment later, and read
   *  before then, a song taken out came back (his test on the Mac, 2026-10-12) — four seconds at most; then shows it as
   *  it is. */
  async confirm(shows) {
    this.reading++;
    let found = null;
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      const read = await this.read();
      found = read;
      if (shows(read.songs)) break;
    }
    if (found) {
      this.songs = found.songs;
      this.note = found.note;
    }
    // A reading it cut short is done with too.
    this.isLoading = false;
    this.changed();
    this.readFor = this.key();
  }

  /** Read again once the player has taken the change. */
  settle() {
    this.readFor = null;
    setTimeout(() => this.refresh(), 900);
  }

  async read() {
    const track = this.nowPlaying.track;
    if (!track) return { songs: [], note: 'Play a song to see what’s next' };
    if (track.source === 'spotify') {
      const found = await spotify.queue();
      if (!found) return { songs: [], note: 'Pick a song in iJWA to see Spotify’s queue' };
      return { songs: found.map(PlayQueue.song), note: found.length > 1 ? 'Up next in Spotify' : 'Nothing up next in Spotify' };
    }
    if (track.source === 'web') {
      const site = extension.followed?.site;
      const name = SITE_NAMES[site || ''] || 'the browser';
      if (!['spotifyWeb', 'youTubeMusic', 'soundCloud'].includes(site || '')) return { songs: [], note: `${name} shares no queue` };
      const found = await extension.queue();
      if (!found?.length) return { songs: [], note: `Couldn’t read the queue on ${name}` };
      return { songs: found.map(PlayQueue.song), note: `Up next on ${name}` };
    }
    if (track.source === 'files') {
      const files = this.files;
      const playing = files?.song ? [files.song] : [];
      const songs = [...playing, ...(files ? files.coming(60) : [])].map((song, index) => ({ id: song.id, title: song.title,
        artist: song.artist || '', album: song.album || '', duration: song.duration || 0, artwork: null, artworkFile: song.artworkFile || null,
        isCurrent: index === 0 && playing.length > 0, isQueued: false }));
      return { songs, note: 'Up next in this folder' };
    }
    // Apple Music's app, and any other: what plays next isn't shared with other apps.
    return { songs: [], note: `${track.source === 'music' ? 'Apple Music' : track.app || 'This app'} shares no queue` };
  }

  /** A song of Spotify's queue, or a page's. */
  static song(found) {
    return { id: found.id, title: found.title, artist: found.artist, album: found.album, duration: found.duration,
      artwork: found.artwork || null, artworkFile: null, isCurrent: found.current, isQueued: found.queued };
  }
}

module.exports = { PlayQueue, NOTICES, videoOf };
