// Brings the desktop to life with the music (LiveWallpaperController in LiveWallpaper.swift). While a song plays, each
// display shows the song's clip behind its icons and windows — the music video, the album's moving cover or the
// artist's video, from Apple Music. Everything else is the user's own video, if they chose one, or the Windows
// wallpaper: a song with no clip, the moments while a new song's clip loads, and the music paused — the clip holds
// still and dissolves into what lies beneath, and comes back out of it.
const { app, screen, ipcMain, dialog, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const readline = require('readline');
const net = require('net');
const os = require('os');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');
const clips = require('./clips');
const wallpaper = require('./wallpaper');

const videoFolder = () => { const f = path.join(require('electron').app.getPath('userData'), 'Desktop Video'); fs.mkdirSync(f, { recursive: true }); return f; };

class LiveWallpaper extends EventEmitter {
  host = null;           // the wallpaper's own process (wallhost.js), while there is something to show
  status = { state: 'off', fraction: 0 };
  playback = null;       // the song's clip: { id, name, url, kind, key }
  base = null;           // the user's own video: { id, url, kind: 'own' }
  songID = null;
  finding = 0;           // counts finds, so an old one knows it was overtaken
  away = false;

  constructor({ nowPlaying, preload }) {
    super();
    this.nowPlaying = nowPlaying;
    this.preload = preload;
    this.index = new clips.ClipIndex();
    nowPlaying.on('track', () => this.refresh());
    nowPlaying.on('playing', () => this.refresh());
    ipcMain.handle('wall-status', () => this.statusNow());
    ipcMain.handle('wall-storage', () => ({ bytes: clips.size() }));
    ipcMain.handle('wall-clear', () => { clips.clear(new Set(this.playback ? [this.playback.name] : [])); return { bytes: clips.size() }; });
    // Asleep or locked, nobody sees it: it holds still.
    for (const name of ['lock-screen', 'suspend']) powerMonitor.on(name, () => { this.away = true; this.push(); });
    for (const name of ['unlock-screen', 'resume']) powerMonitor.on(name, () => { this.away = false; this.push(); });
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(name, () => this.displaysChanged());
    this.refresh();
  }

  get style() { return settings.get().wallpaper; }

  statusNow() { return { isOn: Boolean(this.style.isOn && settings.get().isEnabled), ...this.status }; }
  setStatus(state, fraction = 0) {
    if (this.status.state === state && Math.abs(this.status.fraction - fraction) < 0.02 && !(fraction >= 1 && this.status.fraction < 1)) return;
    this.status = { state, fraction };
    this.emit('status', this.statusNow());
  }

  // ---- following the music ----

  /** Settings, the song or its playing changed. */
  refresh() {
    const all = settings.get();
    const isOn = Boolean(all.isEnabled && this.style.isOn);
    this.setBase(all.isEnabled && this.style.videoIsOn ? this.style.video : null);
    const track = this.nowPlaying.track;
    if (!isOn || !track) {
      // Between two songs the track is gone for a moment: leave only if it stays gone.
      this.leave(isOn ? 3000 : 0);
      if (!isOn) this.setStatus('off'); else if (!track) this.setStatus('idle');
      this.push();
      return;
    }
    clearTimeout(this.leaving); this.leaving = null;
    if (track.id !== this.songID) { this.songID = track.id; this.songChanged(track); }
    else if (this.status.state === 'off') this.setStatus(this.playback ? 'ready' : 'idle');
    this.push();
  }

  /** A new song. When its clip is the one already on — the next song of an album with a moving cover — it plays on;
   *  otherwise the desktop goes back to what lies beneath until the new song's clip is ready. */
  songChanged(track) {
    const key = clips.keyOf(track.title, track.artist);
    const known = this.index.entry(key);
    if (this.playback && known?.clip && known.clip.source === this.playback.source) { this.finding++; this.setStatus('ready'); return; }
    this.playback = null;
    if (known && !known.clip) { this.finding++; this.setStatus('missing'); return; }
    this.setStatus('finding');
    this.find(track, key, known?.clip || null);
  }

  /** Finds the song's clip — saved, remembered or searched for — and shows it. A song skipped within a moment isn't
   *  looked up at all. */
  async find(track, key, known) {
    const turn = ++this.finding;
    await new Promise((r) => setTimeout(r, 400));
    const current = () => turn === this.finding && this.nowPlaying.track?.id === track.id;
    if (!current()) return;
    const pixels = this.neededPixels();
    const progress = (fraction) => { if (current()) this.setStatus('fetching', Math.min(fraction, 1)); };
    let found = null;
    if (known) {
      const name = await clips.fileFor(known, pixels, this.keeping(), progress);
      if (name) found = { clip: known, name };
      else this.index.forget(key);
    }
    const skipping = new Set();
    while (!found && current()) {
      const answer = await clips.findClip(track.title, track.artist, track.album, skipping);
      if (!current()) return;
      if (answer.found) {
        const name = await clips.fileFor(answer.found, pixels, this.keeping(), progress);
        if (name) { found = { clip: answer.found, name }; this.index.set(key, answer.found); break; }
        skipping.add(answer.found.kind);
      } else {
        if (answer.none) this.index.set(key, null);
        break;
      }
    }
    if (!current()) return;
    if (!found) { console.log('[wallpaper] no clip for', track.title); this.setStatus('missing'); return; }
    console.log('[wallpaper]', found.clip.kind, 'for', track.title, ':', found.name);
    this.playback = { id: found.name, name: found.name, url: `ijwa://app/clip/${found.name}`, kind: found.clip.kind, source: found.clip.source };
    this.setStatus('ready');
    this.push();
  }

  keeping() { return new Set([this.playback?.name].filter(Boolean)); }

  /** Hands the desktop back for good — to the user's own video, or to the Windows wallpaper — when the music stopped or
   *  the live wallpaper was switched off. */
  leave(after) {
    if (!this.playback && !this.songID) return;
    if (this.leaving) return;
    this.leaving = setTimeout(() => {
      this.leaving = null;
      this.finding++;
      this.songID = null;
      this.playback = null;
      this.push();
    }, after);
  }

  // ---- the user's own video ----

  setBase(name) {
    if ((this.base?.name ?? null) === (name ?? null)) return;
    const file = name && path.join(videoFolder(), name);
    this.base = file && fs.existsSync(file) ? { id: name, name, url: `ijwa://app/desktop-video/${name.split(/[\\/]/).map(encodeURIComponent).join('/')}`, kind: 'own' } : null;
  }

  /** Asks for a video and puts it on the desktop: copied into iJWA's folder, so it plays on when the original is moved
   *  or deleted. One at a time: choosing another replaces it. */
  async chooseVideo(parent) {
    const { canceled, filePaths } = await dialog.showOpenDialog(parent && !parent.isDestroyed() ? parent : undefined, {
      title: 'Choose a video for your desktop', properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }],
    });
    if (canceled || !filePaths[0]) return null;
    const id = crypto.randomBytes(4).toString('hex');
    const place = path.join(videoFolder(), id);
    fs.mkdirSync(place, { recursive: true });
    await fs.promises.copyFile(filePaths[0], path.join(place, path.basename(filePaths[0])));
    for (const old of fs.readdirSync(videoFolder())) if (old !== id) fs.rmSync(path.join(videoFolder(), old), { recursive: true, force: true });
    const name = `${id}/${path.basename(filePaths[0])}`;
    settings.set({ wallpaper: { video: name, videoIsOn: true } });
    this.emit('settings');
    this.refresh();
    return name;
  }

  // ---- the windows, in a process of their own ----

  /** What a display's page shows now. */
  stateFor(display) {
    const playing = Boolean(this.nowPlaying.playing);
    const seen = !this.away;
    return {
      beneath: wallpaper.fullURL(),
      top: this.playback, topVisible: playing && Boolean(this.playback),
      base: this.base,
      darkness: this.style.darkness,
      running: { top: seen && playing, base: seen && !(playing && this.playback) },
    };
  }

  /** Something to show: a window on every display, filled; nothing: the pictures fade, and their process goes. */
  push() {
    const wanted = Boolean((this.playback && this.nowPlaying.playing) || this.base || (this.playback && this.songID));
    clearTimeout(this.closing);
    if (!wanted) {
      if (!this.host) return;
      this.tell({ type: 'show', displays: this.displays(), states: Object.fromEntries(this.displays().map((d) => [d.id, this.stateFor(d)])) });
      // Once the picture has dissolved, the Windows wallpaper shows on its own again.
      this.closing = setTimeout(() => { this.stopHost(); wallpaper.setLive(null); }, 1400);
      return;
    }
    if (process.env.IJWA_SHOT && !process.env.IJWA_SHOT_WALL) return;
    this.startHost();
    const displays = this.displays();
    this.tell({ type: 'show', displays, states: Object.fromEntries(displays.map((d) => [d.id, this.stateFor(d)])) });
  }

  /** The displays iJWA lives on (the settings' Displays). */
  displays() {
    const hidden = new Set(settings.get().hiddenDisplays || []);
    return screen.getAllDisplays().filter((d) => !hidden.has(d.label)).map((d) => ({ id: d.id, bounds: d.bounds,
      pixels: process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds }));
  }

  /** The same app started again to hold only the wallpaper, told what to show over a named pipe. */
  startHost() {
    if (this.host) return;
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\ijwa-wallpaper-${process.pid}-${Date.now()}` : path.join(os.tmpdir(), `ijwa-wallpaper-${process.pid}-${Date.now()}.sock`);
    const host = { child: null, server: null, socket: null, queue: [] };
    this.host = host;
    host.server = net.createServer((socket) => {
      if (host.socket) { socket.destroy(); return; }
      host.socket = socket;
      socket.on('error', () => {});
      for (const line of host.queue) socket.write(line);
      host.queue = [];
      readline.createInterface({ input: socket }).on('line', (line) => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.type === 'still') wallpaper.setLive(message.data ? Buffer.from(message.data.split(',')[1], 'base64') : null);
        if (message.type === 'log') console.log(message.text);
      });
    });
    host.server.on('error', (error) => console.log('[wallpaper] pipe:', error.message));
    host.server.listen(pipe, () => {
      if (this.host !== host) { host.server.close(); return; }
      const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--ijwa-wallpaper', `--ijwa-pipe=${pipe}`];
      const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
      host.child = child;
      child.on('exit', (code) => {
        host.server.close();
        if (this.host !== host) return;
        this.host = null;
        console.log('[wallpaper] its process ended', code);
        // Gone while it had something to show (it crashed): it starts again in a moment.
        setTimeout(() => this.push(), 3000);
      });
    });
    this.tell({ type: 'config', clips: clips.folder(), videos: videoFolder(), beneath: wallpaper.fullFile(),
      preload: this.preload, layer: require('./unpacked').unpacked(path.join(__dirname, 'desktop-layer.ps1')) });
  }

  stopHost() {
    const host = this.host;
    this.host = null;
    if (!host) return;
    try { host.socket?.end(); } catch { /* gone */ }
    host.server?.close();
    setTimeout(() => { try { host.child?.kill(); } catch { /* gone */ } }, 3000);
  }

  tell(message) {
    const host = this.host;
    if (!host) return;
    const line = JSON.stringify(message) + '\n';
    if (host.socket) { try { host.socket.write(line); } catch { /* starting again */ } }
    else if (message.type === 'config') host.queue.unshift(line);
    else host.queue = [...host.queue.filter((l) => !l.includes('"type":"show"')), line];
  }

  displaysChanged() { this.push(); }

  /** The biggest display's size in pixels: clips are fetched no bigger than that. */
  neededPixels() {
    // Optimized mode: never more than an HD screen's worth, whatever the displays.
    const optimize = require('./settings').get().energy?.optimize;
    return screen.getAllDisplays().reduce((size, d) => {
      const scale = optimize ? Math.min(1, 1920 / Math.max(d.size.width * d.scaleFactor, 1)) : 1;
      const w = d.size.width * d.scaleFactor * scale, h = d.size.height * d.scaleFactor * scale;
      return w * h > size.width * size.height ? { width: w, height: h } : size;
    }, { width: 0, height: 0 });
  }
}

module.exports = { LiveWallpaper, videoFolder };
