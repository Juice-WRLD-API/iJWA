// iJWA's browser extension (~/IJWAEXT, the same one as the Mac's), in Chrome, Edge, Opera and the browsers made from
// Chrome (BrowserExtension.swift). It finds iJWA at a port of this computer only, and does what iJWA asks with the
// browser's YouTube Music, SoundCloud and Spotify Web Player tabs: lists them, sends one to a page, opens one, has a page
// play, pause, skip, start or set its loudness — inside the browser, so nothing comes forward and no keys are typed —
// and reads the user's own lists there. Each page tells what it plays itself. A browser without it is worked as before
// (browser.js, web-agent.ps1).
//
// The port speaks WebSocket, written out here (a handshake and frames): nothing to install for so little.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/** The extension's IDs: the one it has while being made (its manifest's key); the store's joins it once there. */
const IDS = new Set(['gigknfcahepjbpbbenehclomobbhnoih']);
/** Where iJWA waits, the second should another app hold the first; the extension tries both. A test's copy of the
 *  extension is met elsewhere (IJWA_EXTENSION_PORT), never by the iJWA in use. */
const PORTS = process.env.IJWA_EXTENSION_PORT ? [Number(process.env.IJWA_EXTENSION_PORT)] : [47823, 47824];
/** Windows' names for a browser's media session ("Chrome", "MSEdge", …) by the extension's for it. */
const SESSION_NAMES = { chrome: /chrome/i, edge: /msedge|edge/i, opera: /opera/i, brave: /brave/i, vivaldi: /vivaldi/i };

const log = (...words) => console.log('[extension]', ...words);

class BrowserExtension extends EventEmitter {
  links = new Map();      // browser → the sockets that said hello, the latest last
  waiting = new Map();    // question id → { resolve, timer }
  serial = 0;
  followed = null;        // { browser, tab, site }: the tab whose song is followed
  states = new Map();     // "browser|tab" → its last word
  loudness = null;
  latest = null;          // the version iJWA brings, told to the extension
  heardTitle = '';
  lastAd = '';
  dropTimer = null;

  /** The copy the browser loads, kept up to date, then the port. */
  start() {
    this.keepCopy();
    this.listen(0);
    // A word every 20 seconds keeps the extension awake: a browser puts one to sleep after 30 quiet ones.
    setInterval(() => { for (const sockets of this.links.values()) for (const s of sockets) send(s, { ping: 1 }); }, 20000).unref?.();
  }

  // ---- the copy the browser loads ----

  /** Where the browser loads the extension from, when added by hand (not from the store): a folder iJWA keeps and
   *  writes again whenever this iJWA brings another version of it, so updating iJWA updates the extension too. */
  static get folder() {
    if (process.env.IJWA_EXTENSION_FOLDER) return process.env.IJWA_EXTENSION_FOLDER;
    return path.join(require('electron').app.getPath('userData'), 'Browser Extension');
  }

  /** The copy the installer brings (scripts/bundle-extension.js), beside app.asar with the other resources. */
  static get bundled() {
    return require('./unpacked').unpacked(path.join(__dirname, '../../resources/BrowserExtension'));
  }

  keepCopy() {
    const version = (folder) => { try { return JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')).version; } catch { return null; } };
    const mine = version(BrowserExtension.bundled);
    if (!mine) return;
    this.latest = mine;
    const target = BrowserExtension.folder;
    if (version(target) === mine) return;
    // File by file, over what is there — the folder itself never gone, which a browser holding it would take for the
    // extension removed. Its manifest last: a copy cut short still reads as the old version, and is made again.
    const copy = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      const entries = fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name === 'manifest.json') - (b.name === 'manifest.json'));
      for (const entry of entries) {
        const source = path.join(from, entry.name), destination = path.join(to, entry.name);
        if (entry.isDirectory()) copy(source, destination);
        else fs.writeFileSync(destination, fs.readFileSync(source));
      }
    };
    try { copy(BrowserExtension.bundled, target); log('kept for the browser:', mine); } catch (error) { log('copy failed:', error.message); }
  }

  // ---- the port ----

  listen(index) {
    if (index >= PORTS.length) return;
    const server = http.createServer((request, response) => { response.writeHead(426); response.end(); });
    server.on('upgrade', (request, socket) => this.accept(request, socket));
    server.on('error', (error) => { log(`port ${PORTS[index]} failed:`, error.code); this.listen(index + 1); });
    server.listen(PORTS[index], '127.0.0.1', () => log('waiting for the extension at', PORTS[index]));
    this.server = server;
  }

  /** Only iJWA's own extension: a page — or another extension — asking for the port is turned away. */
  accept(request, socket) {
    const origin = request.headers.origin || '';
    const key = request.headers['sec-websocket-key'];
    if (![...IDS].some((id) => origin === `chrome-extension://${id}`) || !key) {
      log('turned away:', origin);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let parts = [];
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Nothing it says is ever this big: a long list's songs are a few hundred kilobytes.
      if (buffer.length > 16 * 1024 * 1024) { socket.destroy(); return; }
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 8) { writeFrame(socket, 8, frame.payload.subarray(0, 2)); socket.end(); return; }
        if (frame.opcode === 9) { writeFrame(socket, 10, frame.payload); continue; }
        if (frame.opcode === 10) continue;
        parts.push(frame.payload);
        if (!frame.fin) continue;
        const text = Buffer.concat(parts).toString('utf8');
        parts = [];
        this.heard(text, socket);
      }
    });
    socket.on('close', () => this.dropped(socket));
    // A browser gone without a word: the socket half-closed is closed, so its link goes at once.
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
  }

  heard(text, socket) {
    let message; try { message = JSON.parse(text); } catch { return; }
    if (message.hello?.browser) {
      const name = message.hello.browser;
      const list = (this.links.get(name) || []).filter((s) => s !== socket);
      list.push(socket);
      this.links.set(name, list);
      socket.browser = name;
      if (this.latest) send(socket, { latest: this.latest });
      log(`in ${name} (${message.hello.version || '?'})`);
      this.emit('links');
    } else if (message.id != null) {
      const waiting = this.waiting.get(message.id);
      if (waiting) { this.waiting.delete(message.id); clearTimeout(waiting.timer); waiting.resolve(message); }
    } else if (message.event === 'state' && message.tab != null && socket.browser) {
      this.heardState(message, socket.browser);
    } else if (message.event === 'gone' && message.tab != null && socket.browser) {
      this.states.delete(`${socket.browser}|${message.tab}`);
      // Its tab closed, or sent elsewhere: its song goes at once.
      if (this.followed && this.followed.browser === socket.browser && this.followed.tab === message.tab) {
        clearTimeout(this.dropTimer);
        this.followed = null;
        this.emit('playing', null);
      }
    }
  }

  /** What a page plays, as it tells it: the tab playing is followed, else the one followed goes on being; an ad is let
   *  be. Told on as `playing`, its picture fetched once per address. */
  heardState(state, browser) {
    this.states.set(`${browser}|${state.tab}`, state);
    if (!state.title) return;
    if (state.ad) {
      if (this.lastAd !== state.title) { this.lastAd = state.title; log('an ad, let be'); }
      return;
    }
    this.lastBrowser = browser;
    const followed = this.followed;
    const isFollowed = followed && followed.browser === browser && followed.tab === state.tab;
    if (!state.playing && followed && !isFollowed) return;
    // A page of a site not followed (another than the one chosen) never takes the following over: play, pause and
    // the rest would reach its tab instead of the song shown.
    if (!isFollowed && this.accepts && !this.accepts(state.site)) return;
    clearTimeout(this.dropTimer);
    this.followed = { browser, tab: state.tab, site: state.site || '' };
    if (this.heardTitle !== state.title) {
      this.heardTitle = state.title;
      log(`heard from ${browser}: ${state.title}${state.playing ? '' : ' (paused)'}`);
    }
    this.loudness = typeof state.volume === 'number' ? state.volume : null;
    this.emit('playing', { ...state, browser });
  }

  lostFollowed() {
    clearTimeout(this.dropTimer);
    // A moment's grace: an extension reloading says nothing for a breath. Back by then, its pages say again what they
    // play (the extension asks them as it comes back): the song stays.
    const browser = this.followed?.browser;
    this.dropTimer = setTimeout(() => {
      if (browser && this.links.get(browser)?.length) return;
      this.followed = null;
      this.emit('playing', null);
    }, 6000);
  }

  dropped(socket) {
    const name = socket.browser;
    if (!name) return;
    const list = (this.links.get(name) || []).filter((s) => s !== socket);
    if (list.length) this.links.set(name, list); else this.links.delete(name);
    log(`the extension in ${name} went`);
    this.emit('links');
    if (!list.length && this.followed?.browser === name) this.lostFollowed();
  }

  // ---- asked of a browser ----

  /** The browsers it's in now, by the names they give ("chrome", "edge", "opera", …). */
  browsers() { return [...this.links.keys()]; }

  /** The extension's name for the browser behind Windows' name for its media session (or a process name). */
  static nameOf(app) {
    const text = String(app || '');
    return Object.keys(SESSION_NAMES).find((name) => SESSION_NAMES[name].test(text)) || null;
  }

  /** Whether the browser `app` (Windows' name for it, or the extension's) has the extension, and it's there now. */
  reaches(app) {
    const name = this.links.has(app) ? app : BrowserExtension.nameOf(app);
    return Boolean(name && this.links.get(name)?.length);
  }

  /** The browser to ask: the one named, else the one whose song is followed, else the one last heard, else the
   *  computer's own browser, else any that has it. */
  pick(app) {
    const named = app && (this.links.has(app) ? app : BrowserExtension.nameOf(app));
    if (named && this.links.get(named)?.length) return named;
    for (const name of [this.followed?.browser, this.lastBrowser, BrowserExtension.defaultBrowser()]) {
      if (name && this.links.get(name)?.length) return name;
    }
    return this.browsers()[0] || null;
  }

  /** The computer's own browser, by the extension's name for it, read once from Windows' choice for web addresses. */
  static defaultBrowser() {
    if (BrowserExtension.knownDefault !== undefined) return BrowserExtension.knownDefault;
    BrowserExtension.knownDefault = null;
    if (process.platform !== 'win32') return null;
    try {
      const out = require('child_process').execFileSync('reg', ['query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const id = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] || '';
      BrowserExtension.knownDefault = /^MSEdge/i.test(id) ? 'edge' : /^Opera/i.test(id) ? 'opera' : /^Brave/i.test(id) ? 'brave'
        : /^Vivaldi/i.test(id) ? 'vivaldi' : /^Chrome/i.test(id) ? 'chrome' : null;
    } catch { /* not known */ }
    return BrowserExtension.knownDefault;
  }

  ask(browser, message, ms = 4000) {
    const socket = (this.links.get(browser) || []).at(-1);
    if (!socket) return Promise.resolve(null);
    const id = ++this.serial;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, ms);
      this.waiting.set(id, { resolve, timer });
      send(socket, { ...message, id });
    });
  }

  /** Its music tabs, the one playing first. */
  async tabs(browser) {
    const answer = await this.ask(browser, { do: 'tabs' });
    return answer?.tabs || null;
  }

  /** A page asked to do something (page.js): its answer, or null when it couldn't be asked. */
  async tell(browser, tab, site, action, arg = null, ms = 4000) {
    const answer = await this.ask(browser, { do: 'tell', tab, site, action, ...(arg == null ? {} : { arg }) }, ms);
    return answer?.ok ? String(answer.answer ?? '') : null;
  }

  /** A page opened in the tab given, else a new one shown in the window last used; `behind`, a tab behind the one
   *  shown. Its tab, or null. */
  async open(browser, url, { tab = null, behind = false } = {}) {
    const answer = await this.ask(browser, { do: 'open', url, ...(tab != null ? { tab } : {}), ...(behind ? { background: true } : {}) });
    return answer?.ok ? (answer.tab ?? tab) : null;
  }

  /** What each music page says it plays. */
  async songs(browser) {
    const answer = await this.ask(browser, { do: 'songs' }, 6000);
    return answer?.songs || null;
  }

  /** The user's lists on the site of the tab, read in it: null when they couldn't be read. */
  async library(browser, tab, site) {
    const answer = await this.ask(browser, { do: 'library', tab, site }, 20000);
    if (!answer || answer.error || !Array.isArray(answer.lists)) { log(`lists on ${site} not read:`, answer?.error || 'no answer'); return null; }
    return { signedIn: Boolean(answer.signedIn), lists: answer.lists };
  }

  /** A list's songs. */
  async list(browser, tab, site, id) {
    const answer = await this.ask(browser, { do: 'list', tab, site, list: id }, 30000);
    if (!answer || answer.error || !Array.isArray(answer.songs)) { log(`list ${id} not read:`, answer?.error || 'no answer'); return null; }
    return { name: answer.name || '', songs: answer.songs };
  }

  /** The song playing in a page — or the one `id` names (a Spotify address) — liked or not on the user's account there,
   *  as the page's own heart has it: `on` true or false sets it, none only asks. null when the page couldn't say. */
  async like(browser, tab, site, { id = null, on = null } = {}) {
    const message = { do: 'like', tab, site };
    if (typeof on === 'boolean') message.on = on;
    if (id) message.song = id;
    const answer = await this.ask(browser, message, 15000);
    if (!answer || answer.error) { log(`like on ${site} not ${typeof on === 'boolean' ? 'set' : 'read'}:`, answer?.error || 'no answer'); return null; }
    return typeof answer.liked === 'boolean' ? answer.liked : null;
  }

  /** The sound of the song the page followed plays, 16 kHz mono 16-bit samples, fetched and decoded in the page
   *  (audio.js) and taken in pieces under the socket's 16 MB: { samples: Buffer } or { why } when it couldn't be had. */
  async audio(place = this.followed) {
    if (!place) return { why: 'no page plays' };
    const base = { do: 'audio', tab: place.tab, site: place.site };
    const ready = await this.ask(place.browser, { ...base, what: 'prepare' }, 90000);
    if (!ready) return { why: "the page didn't answer" };
    const count = ready.samples;
    if (!(count > 0)) return { why: ready.error || 'no sound' };
    const pieces = [];
    const piece = 1500000;
    for (let from = 0; from < count; from += piece) {
      const answer = await this.ask(place.browser, { ...base, what: 'chunk', from, count: piece }, 30000);
      if (!answer || typeof answer.data !== 'string') {
        await this.ask(place.browser, { ...base, what: 'clear' });
        return { why: 'a piece was lost' };
      }
      pieces.push(Buffer.from(answer.data, 'base64'));
    }
    await this.ask(place.browser, { ...base, what: 'clear' });
    log(`sound of the song from ${place.site}: ${(count / 16000).toFixed(1)} s`);
    return { samples: Buffer.concat(pieces) };
  }

  // ---- the page's queue (BrowserExtension.queue, playInQueue, removeFromQueue, addToQueue; queue.js, 2026-10-12) ----
  // A queue's song goes as "item": the extension's answer carries the ask's "id", which is the question's serial.

  /** What the page followed plays next, read in it — each { id, title, artist, album, duration, artwork, current (the
   *  one playing), queued (lined up by the user) }: null when it couldn't be read. */
  async queue() {
    const place = this.followed;
    if (!place) return null;
    const answer = await this.ask(place.browser, { do: 'queue', tab: place.tab, site: place.site, what: 'read' }, 8000);
    if (!answer) return null;
    if (answer.error || !Array.isArray(answer.songs)) { log(`queue on ${place.site} not read:`, answer.error || 'no songs'); return null; }
    return answer.songs.filter((song) => song?.id && typeof song.id === 'string' && song.title && typeof song.title === 'string')
      .map((song) => ({ id: song.id, title: song.title, artist: song.artist || '', album: song.album || '', duration: Number(song.duration) || 0,
        artwork: song.artwork || '', current: Boolean(song.current), queued: Boolean(song.queued) }));
  }

  /** The song `id` of the page's queue played there, as a click on it in the page would: whether it was. */
  async playInQueue(id) {
    const place = this.followed;
    if (!place) return false;
    const answer = await this.ask(place.browser, { do: 'queue', tab: place.tab, site: place.site, what: 'play', item: id }, 8000);
    return answer?.played === true;
  }

  /** The song `id` taken out of the page's queue: whether it was. */
  async removeFromQueue(id) {
    const place = this.followed;
    const answer = place ? await this.ask(place.browser, { do: 'queue', tab: place.tab, site: place.site, what: 'remove', item: id }, 8000) : null;
    if (!answer) { log(`remove from the queue on ${this.followed?.site || 'no page'}: no answer`); return false; }
    log(`remove ${id} from the queue on ${place.site}:`, answer.done ?? answer.error ?? '?', answer.why || '');
    return answer.done === true;
  }

  /** A song added to the page's queue — `song` its ID there (a Spotify URI, a YouTube video ID) — to play next or
   *  after what's lined up: whether it was. */
  async addToQueue(song, next) {
    const place = this.followed;
    if (!place) return false;
    const answer = await this.ask(place.browser, { do: 'queue', tab: place.tab, site: place.site, what: 'add', song, next }, 8000);
    return answer?.done === true;
  }

  /** The page that last said it plays `title` on one of `sites`, followed or not — a song played on a site other than
   *  the one chosen is known from Windows' media session, its page never followed (the test PC, 2026-10-12: Plottin on
   *  SoundCloud, YouTube Music chosen, its words never timed): { browser, tab, site }, or null. */
  pagePlaying(title, sites) {
    const names = require('./names');
    let found = null;
    for (const [key, state] of this.states) {
      if (!state.title || !sites.includes(state.site)) continue;
      if (!(names.plainTitle(state.title) === names.plainTitle(title) || String(state.title).includes(title))) continue;
      const browser = key.slice(0, key.lastIndexOf('|'));
      if (!this.links.get(browser)?.length) continue;
      if (!found || state.playing) found = { browser, tab: state.tab, site: state.site };
    }
    return found;
  }

  /** How loud the page followed plays, 0…1, as it last said. */
  volume() { return this.followed ? this.loudness : null; }

  /** The page followed made that loud, by its own setting. */
  setVolume(value) {
    const followed = this.followed;
    if (!followed) return;
    const level = Math.min(Math.max(value, 0), 1);
    this.loudness = level;
    this.ask(followed.browser, { do: 'tell', tab: followed.tab, site: followed.site, action: 'volume', arg: level });
  }
}

// ---- WebSocket frames ----

/** One whole frame at the buffer's start, unmasked: { fin, opcode, payload, length }, or null until it has all come. */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f, masked = (buffer[1] & 0x80) !== 0;
  let size = buffer[1] & 0x7f, at = 2;
  if (size === 126) { if (buffer.length < 4) return null; size = buffer.readUInt16BE(2); at = 4; }
  else if (size === 127) { if (buffer.length < 10) return null; size = Number(buffer.readBigUInt64BE(2)); at = 10; }
  const mask = masked ? buffer.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buffer.length < at + size) return null;
  const payload = Buffer.from(buffer.subarray(at, at + size));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, length: at + size };
}

function writeFrame(socket, opcode, payload) {
  const size = payload.length;
  const head = size < 126 ? Buffer.from([0x80 | opcode, size])
    : size < 65536 ? Buffer.from([0x80 | opcode, 126, size >> 8, size & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(size), 2); return h; })();
  if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
}

function send(socket, message) { writeFrame(socket, 1, Buffer.from(JSON.stringify(message), 'utf8')); }

const shared = new BrowserExtension();
module.exports = { extension: shared, BrowserExtension };
