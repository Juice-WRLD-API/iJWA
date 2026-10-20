// Continue Playing for someone listening on YouTube Music or SoundCloud (WebList.swift): what the site itself plays
// next — the song's radio on YouTube Music, the track's station on SoundCloud — each song by its own page there, so a
// row picked plays in the browser with the rest after it. Made again when a song from outside the list starts; the
// refresh asks for songs like the one playing.
const webmusic = require('./webmusic');
const { artworkURL } = require('./applemusic');
const { simple, matches } = require('./names');

class WebList {
  songs = [];         // { id, title, artist, album, duration, cover, link }
  site = null;
  seedTitle = '';     // the song the list is like, for its line; empty for a list of the site's own
  isLoading = false;
  madeFor = null;     // the song the list was made for
  seed = null;

  constructor(onChange) { this.onChange = onChange; }

  /** What plays after `track`, unless the list is for it already. */
  suggest(track) {
    if (this.madeFor === track.id && this.songs.length) return;
    this.build(track, false);
  }

  /** Songs like `track` rather than the list it plays in. */
  refresh(track) { this.build(track, true); }

  async build(track, fresh) {
    const key = track.id;
    this.madeFor = key;
    this.isLoading = true;
    this.onChange();
    const found = await webmusic.upNext({ title: track.title, artist: track.artist, site: track.site, fresh }).catch(() => null);
    if (this.madeFor !== key) return;
    this.isLoading = false;
    if (found?.songs?.length) {
      this.songs = found.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album || '', duration: s.duration || 0,
        cover: artworkURL(s.artwork, 120), art: artworkURL(s.artwork, 600), link: s.link || null }));
      this.site = found.site;
      // A list of the site's own making (an album, a playlist) is named by the site; a radio, by its song.
      const ownList = !matches(this.songs[0], track.title);
      this.seedTitle = fresh || !ownList ? track.title : '';
      this.seed = track;
    }
    this.onChange();
  }

  /** The row of the song playing, by its words either way round. */
  rowOf(track) {
    if (!track) return -1;
    const shown = [track.title, `${track.artist} ${track.title}`, `${track.title} ${track.artist}`].map(simple);
    if (!shown[0]) return -1;
    return this.songs.findIndex((s) => shown.includes(simple(s.title)));
  }
}

module.exports = { WebList };
