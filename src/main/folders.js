// The folders the user made playlists — chosen in the panel's menu, or dropped on the panel — and their songs
// (FolderLibrary.swift; his ask, 2026-09-26: unreleased songs, as files). Nothing is copied or moved: the songs play
// from where they are. Each song is read once, its names from its tags or else from its file's name, and kept with
// its folder, so a folder opens at once; opening it again reads only the files new or changed since.
const { app } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tags = require('./tags');
const artwork = require('./artwork');

const file = () => path.join(app.getPath('userData'), 'folders.json');
const pause = () => new Promise((resolve) => setImmediate(resolve));
// Explorer's order: "2 Song" before "10 Song".
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

class FolderLibrary extends EventEmitter {
  folders = [];        // { id, name, path, songs: [{ id: path, title, artist, album, modified, artworkFile }] }
  currentId = null;
  progress = null;     // while the folder shown is read: { done, total }
  isMissing = false;   // the folder shown isn't where it was: moved, renamed, or on a drive not plugged in
  reading = new Set();

  constructor() {
    super();
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      this.folders = Array.isArray(saved.folders) ? saved.folders : [];
      this.currentId = this.folders.some((f) => f.id === saved.current) ? saved.current : null;
    } catch { /* none yet */ }
  }

  get current() { return this.folders.find((f) => f.id === this.currentId) || null; }

  changed() { this.emit('change'); }

  /** Makes each folder a playlist and shows the last; one added before is shown again rather than added twice. */
  add(paths) {
    let shown = null;
    for (const folder of paths) {
      let stat; try { stat = fs.statSync(folder); } catch { continue; }
      const where = path.resolve(stat.isDirectory() ? folder : path.dirname(folder));
      const known = this.folders.find((f) => f.path.toLowerCase() === where.toLowerCase());
      if (known) { shown = known.id; continue; }
      const made = { id: crypto.randomUUID(), name: path.basename(where) || where, path: where, songs: [] };
      this.folders.push(made);
      shown = made.id;
    }
    if (shown) this.choose(shown);
    return shown;
  }

  /** Shows a folder, and reads it again for songs added or changed since. */
  choose(id) {
    if (!this.folders.some((f) => f.id === id)) return;
    this.currentId = id;
    this.isMissing = false;
    this.save();
    this.changed();
    this.read(id);
  }

  /** The folder shown no longer: Continue Playing is. */
  leave() { this.currentId = null; this.save(); this.changed(); }

  /** Takes a folder off the list; its songs stay where they are. */
  remove(id) {
    this.folders = this.folders.filter((f) => f.id !== id);
    if (this.currentId === id) this.currentId = null;
    this.save();
    this.changed();
  }

  /** Whether a file is one of the folders' songs: only those are played from disk. */
  knows(song) {
    const wanted = path.resolve(song).toLowerCase();
    return this.folders.some((f) => wanted.startsWith(f.path.toLowerCase() + path.sep) || f.songs.some((s) => s.id.toLowerCase() === wanted));
  }

  /** The song files in a folder and those inside it, a few levels down, in Explorer's order; null if it's gone. */
  songFiles(root) {
    const found = [];
    const walk = (dir, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { if (depth === 0) throw new Error('missing'); return; }
      entries.sort((a, b) => byName(a.name, b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
        else if (entry.isFile() && tags.isSong(entry.name)) {
          try { found.push({ path: full, modified: Math.round(fs.statSync(full).mtimeMs) }); } catch { /* gone meanwhile */ }
        }
      }
    };
    try { walk(root, 0); } catch { return null; }
    return found;
  }

  /** Reads the folder's songs not read before or changed since, a few at a time, letting the app breathe between;
   *  a folder read the first time fills in as it goes. */
  async read(id) {
    if (this.reading.has(id)) return;
    const folder = this.folders.find((f) => f.id === id);
    if (!folder) return;
    this.reading.add(id);
    try {
      const files = this.songFiles(folder.path);
      if (!files) { if (this.currentId === id) { this.isMissing = true; this.changed(); } return; }
      const known = new Map(folder.songs.map((s) => [s.id, s]));
      const fresh = files.filter((f) => known.get(f.path)?.modified !== f.modified);
      const found = new Map();
      for (let i = 0; i < fresh.length; i++) {
        const one = fresh[i];
        const named = tags.read(one.path, true);
        const song = { id: one.path, title: named.title, artist: named.artist, album: named.album, modified: one.modified, artworkFile: null };
        song.artworkFile = this.keepPicture(song, named.picture);
        found.set(one.path, song);
        if (i % 8 === 7 || i === fresh.length - 1) {
          if (this.currentId === id) this.progress = { done: i + 1, total: fresh.length };
          // A folder read the first time shows what it has so far.
          if (!folder.songs.length || i === fresh.length - 1) folder.songs = files.map((f) => found.get(f.path) || known.get(f.path)).filter(Boolean);
          this.changed();
          await pause();
        }
      }
      const songs = files.map((f) => found.get(f.path) || known.get(f.path)).filter(Boolean);
      const differs = fresh.length || songs.length !== folder.songs.length;
      folder.songs = songs;
      if (differs) this.save();
    } finally {
      this.reading.delete(id);
      if (this.currentId === id) this.progress = null;
      this.changed();
    }
  }

  /** A song's picture kept with the others (one per album); a song without one takes its folder's own
   *  ("cover.jpg", "folder.jpg"). */
  keepPicture(song, bytes) {
    const name = artwork.keyFor(song);
    if (artwork.has(name)) return name;
    if (!bytes) {
      const dir = path.dirname(song.id);
      for (const candidate of ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'Cover.jpg', 'Folder.jpg']) {
        try { bytes = fs.readFileSync(path.join(dir, candidate)); break; } catch { /* not this one */ }
      }
    }
    return bytes ? artwork.save(song, bytes) : null;
  }

  save() {
    try { fs.writeFileSync(file(), JSON.stringify({ folders: this.folders, current: this.currentId })); } catch { /* nowhere to write */ }
  }
}

module.exports = { FolderLibrary };
