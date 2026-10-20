// The songs iJWA has seen, kept as a ring for the desktop player (PlayHistory.swift). A new song joins right
// after the one that was playing and a song played again keeps its place, so the player only ever turns the
// ring and never reshuffles it. Saved with its artwork, so the ring is still there after a restart. Past the
// limit, the song furthest round the ring from the one playing is let go.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const artwork = require('./artwork');

const LIMIT = 30;

/** A song is known by its app, title and artist. */
function songID(song) {
  return `${song.source}:${(song.title || '').trim().toLowerCase()}|${(song.artist || '').trim().toLowerCase()}`;
}

function merged(song, other) {
  return {
    ...song,
    playKey: song.playKey || other.playKey || '',
    duration: song.duration > 0 ? song.duration : other.duration || 0,
    album: song.album || other.album || '',
    artworkFile: song.artworkFile || other.artworkFile || null,
    lastPlayed: song.lastPlayed || other.lastPlayed || null,
    storeID: song.storeID || other.storeID || null,
  };
}

class PlayHistory {
  songs = [];
  currentID = null;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'history.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const unique = [];
      for (const song of saved.songs || []) {
        const index = unique.findIndex((s) => s.id === song.id);
        if (index >= 0) unique[index] = merged(song, unique[index]); else unique.push(song);
      }
      this.songs = unique;
      this.currentID = unique.some((s) => s.id === saved.current) ? saved.current : unique.at(-1)?.id ?? null;
      const kept = new Set(unique.map((s) => s.artworkFile).filter(Boolean));
      setTimeout(() => artwork.removeAll(kept), 5000);
    } catch { /* first run */ }
  }

  /** Turns the ring to the song playing, adding it after the one before when it is new. It counts as played
   *  only when `playing`: a song found paused hasn't been listened to. */
  record(track, artworkFile, playing) {
    let entry = { ...track, id: songID(track), artworkFile: artworkFile || null, lastPlayed: playing ? Date.now() : null };
    const index = this.songs.findIndex((s) => s.id === entry.id);
    if (index >= 0) {
      const earlier = this.songs[index];
      entry = merged(entry, earlier);
      this.songs[index] = entry;
      const old = earlier.artworkFile;
      if (old && old !== entry.artworkFile && !this.songs.some((s) => s.artworkFile === old)) artwork.remove(old);
    } else {
      const after = this.songs.findIndex((s) => s.id === this.currentID);
      this.songs.splice(after >= 0 ? after + 1 : this.songs.length, 0, entry);
    }
    this.currentID = entry.id;
    this.trim();
    this.save();
  }

  /** A song found paused has started playing: it counts as played from now. */
  markPlayed(id) {
    const song = this.songs.find((s) => s.id === id);
    if (!song) return;
    song.lastPlayed = Date.now();
    this.save();
  }

  /** Keeps the key an app gave for a song after it was recorded, so it can be played again. */
  setPlayKey(id, key) {
    const song = this.songs.find((s) => s.id === id);
    if (!key || !song || song.playKey === key) return;
    song.playKey = key;
    this.save();
  }

  setArtwork(id, file) {
    const song = this.songs.find((s) => s.id === id);
    if (!song || song.artworkFile === file) return;
    song.artworkFile = file;
    this.save();
  }

  trim() {
    while (this.songs.length > LIMIT) {
      const current = Math.max(this.songs.findIndex((s) => s.id === this.currentID), 0);
      const far = (current + Math.floor(this.songs.length / 2)) % this.songs.length;
      const [dropped] = this.songs.splice(far, 1);
      const name = dropped.artworkFile;
      if (name && !this.songs.some((s) => s.artworkFile === name)) artwork.remove(name);
    }
  }

  save() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      try { fs.writeFileSync(this.file, JSON.stringify({ songs: this.songs, current: this.currentID })); } catch { /* next time */ }
    }, 300);
  }
}

module.exports = { PlayHistory, songID, LIMIT };
