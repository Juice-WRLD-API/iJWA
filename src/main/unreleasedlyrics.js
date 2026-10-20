// Read the lyrics already loaded by Unreleased, including offline/local tracks.
// This pipe shares only current-song lyrics; it never carries account credentials.
const net = require('node:net');
const { createHash } = require('node:crypto');
const { homedir } = require('node:os');

function pipeName(app = '') {
  const user = createHash('sha256').update(homedir().toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\unreleased-ijwa-lyrics-${user}${/unreleased\.dev/i.test(app) ? '-dev' : ''}`;
}

const name = (text) => String(text || '').normalize('NFC').trim().toLowerCase();
function matches(track, snapshot) {
  const playing = snapshot?.track;
  return Boolean(playing && typeof playing.id === 'string' && typeof playing.title === 'string' && typeof playing.artist === 'string'
    && name(playing.title) === name(track.title)
    && name(playing.artist) === name(track.artist)
    && (!(track.duration > 0 && playing.duration > 0) || Math.abs(track.duration - playing.duration) <= 3));
}

/** Wait for this song's lyrics to finish loading; an older/absent app falls back immediately. */
function readLyrics(track, { endpoint, timeoutMs = 8000 } = {}) {
  if (track.source !== 'unreleased' || (!endpoint && process.platform !== 'win32')) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buffer = '', settled = false;
    const socket = net.createConnection(endpoint || pipeName(track.app));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return finish(null);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(null); }
        if (message?.version !== 1) return finish(null);
        const snapshot = message.snapshot;
        if (!matches(track, snapshot)) continue;
        const plainLyrics = typeof snapshot.plainLyrics === 'string' ? snapshot.plainLyrics : '';
        const syncedLyrics = typeof snapshot.syncedLyrics === 'string' ? snapshot.syncedLyrics : '';
        // Empty placeholders can arrive before local tags or the API have loaded.
        if (snapshot.pending || (!plainLyrics.trim() && !syncedLyrics.trim())) continue;
        // Unreleased also recognizes LRC stored in a local file's plain-lyrics tag.
        const raw = syncedLyrics || plainLyrics;
        const timed = /\[\d{1,2}:\d{2}[.:]\d{2,3}\]/.test(raw);
        finish({ plainLyrics: timed ? plainLyrics : raw,
          syncedLyrics: timed ? raw.replace(/\[(\d{1,2}:\d{2}):(\d{2,3})\]/g, '[$1.$2]') : '',
          offset: Number.isFinite(snapshot.offset) ? Math.max(-60, Math.min(60, snapshot.offset)) : 0 });
        return;
      }
    });
  });
}

module.exports = { readLyrics, pipeName, matches };
