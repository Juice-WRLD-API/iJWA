const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { readLyrics, pipeName, matches } = require('../src/main/unreleasedlyrics');

const track = { source: 'unreleased', app: 'Unreleased', title: 'Test Song', artist: 'Test Artist', duration: 180 };
const snapshot = { track: { ...track, id: 'jw-1' }, plainLyrics: '', syncedLyrics: '[00:12:50]Hello\n[00:15.00]Again', offset: 0.5, pending: false };
const frame = (data) => JSON.stringify({ version: 1, snapshot: data }) + '\n';
let serial = 0;
async function fixture(t, connected) {
  const id = `ijwa-lyrics-test-${process.pid}-${++serial}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), id + '.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    connected(socket);
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  server.listen(endpoint);
  await once(server, 'listening');
  return endpoint;
}

test('receives split frames, waits for loading, and preserves plain text plus LRC timing', async (t) => {
  let peer;
  const endpoint = await fixture(t, socket => { peer = socket; socket.write(frame({ ...snapshot, pending: true })); });
  const result = readLyrics(track, { endpoint, timeoutMs: 500 });
  while (!peer) await new Promise(resolve => setImmediate(resolve));
  const payload = frame({ ...snapshot, plainLyrics: 'Hello\nAgain' });
  peer.write(payload.slice(0, 25));
  peer.write(payload.slice(25));
  assert.deepEqual(await result, { plainLyrics: 'Hello\nAgain', syncedLyrics: '[00:12.50]Hello\n[00:15.00]Again', offset: 0.5 });
});

test('never uses another song or another version with the same name', async (t) => {
  assert.equal(matches(track, { track: { id: 'jw-1', title: { toString: null }, artist: 'Test Artist' } }), false);
  assert.equal(matches(track, { ...snapshot, track: { ...snapshot.track, title: 'Different' } }), false);
  assert.equal(matches(track, { ...snapshot, track: { ...snapshot.track, duration: 195 } }), false);
  const endpoint = await fixture(t, socket => socket.write(frame({ ...snapshot, track: { ...snapshot.track, artist: 'Other Artist' } })));
  assert.equal(await readLyrics(track, { endpoint, timeoutMs: 30 }), null);
});

test('plain/offline lyrics work and an empty placeholder waits for the loaded lyrics', async (t) => {
  const endpoint = await fixture(t, socket => {
    socket.write(frame({ ...snapshot, plainLyrics: '', syncedLyrics: '' }));
    socket.write(frame({ ...snapshot, plainLyrics: 'Offline words', syncedLyrics: '' }));
  });
  assert.equal((await readLyrics(track, { endpoint })).plainLyrics, 'Offline words');
});

test('recognizes LRC in plain tags and untimed text in synced tags as Unreleased does', async (t) => {
  const timed = await fixture(t, socket => socket.write(frame({ ...snapshot, plainLyrics: '[00:01:50]Local words', syncedLyrics: '' })));
  assert.equal((await readLyrics(track, { endpoint: timed })).syncedLyrics, '[00:01.50]Local words');
  const plain = await fixture(t, socket => socket.write(frame({ ...snapshot, plainLyrics: '', syncedLyrics: 'Untimed words' })));
  assert.equal((await readLyrics(track, { endpoint: plain })).plainLyrics, 'Untimed words');
});

test('unavailable, disconnected, malformed and silent bridges fall back', async (t) => {
  const endpoint = await fixture(t, socket => socket.end('not json\n'));
  assert.equal(await readLyrics(track, { endpoint }), null);
  const closed = await fixture(t, socket => socket.end());
  assert.equal(await readLyrics(track, { endpoint: closed }), null);
  const silent = await fixture(t, () => {});
  assert.equal(await readLyrics(track, { endpoint: silent, timeoutMs: 30 }), null);
  assert.equal(await readLyrics(track, { endpoint: endpoint + '-missing' }), null);
  assert.equal(await readLyrics({ ...track, source: 'spotify' }, { endpoint }), null);
});

test('rejects unsupported protocols and oversized snapshots', async (t) => {
  const old = await fixture(t, socket => socket.end(JSON.stringify({ version: 2, snapshot }) + '\n'));
  assert.equal(await readLyrics(track, { endpoint: old }), null);
  const large = await fixture(t, socket => socket.end('x'.repeat(4 * 1024 * 1024 + 1)));
  assert.equal(await readLyrics(track, { endpoint: large }), null);
});

test('installed and development apps have separate per-user endpoints', () => {
  assert.notEqual(pipeName('Unreleased'), pipeName('Unreleased.Dev'));
  assert.equal(pipeName('com.juicewrldapi.player'), pipeName('Unreleased'));
});

function finder(shared, picked = false) {
  let onlineCalls = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/lyrics.js'), 'utf8'), {
    module, URLSearchParams, AbortSignal, setTimeout, require: id => {
      if (id === './unreleasedlyrics') return { readLyrics: async () => shared };
      if (id === './genius') return { picks: { url: () => picked }, find: async () => ({ status: 'picked' }) };
      if (id === './applelyrics') return { findAppleLyrics: async () => { onlineCalls++; return { status: 'none' }; } };
      if (id === './names') return { lead: text => text };
      throw new Error(id);
    }, fetch: async () => { onlineCalls++; return { status: 404 }; },
  });
  return { find: module.exports.findLyrics, calls: () => onlineCalls };
}

test('direct lyrics win before online lookup and offset shifts lines and words together', async () => {
  const lookup = finder({ plainLyrics: '', syncedLyrics: '[00:12.50]Hello\n[00:15.00]Again', offset: 0.5 });
  const result = await lookup.find(track);
  assert.equal(result.status, 'found');
  assert.equal(result.lyrics.isSynced, true);
  assert.equal(result.lyrics.lines[0].time, 13);
  assert.equal(result.lyrics.lines[0].words[0].start, 13);
  assert.equal(lookup.calls(), 0);
  assert.equal((await finder(null).find(track)).status, 'picked');
  assert.equal((await finder(null, true).find(track)).status, 'picked');
});
