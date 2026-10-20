// Spotify's own player and search, from inside its app (SpotifyInside.swift). Spotify's app is a web page in a window
// (its "xpui"). Told from outside, it comes forward or has to be shown: the helper typed its search and pressed its
// buttons in a window made see-through, and on a friend's PC pressed "Save to Your Library" for Play (2026-10-10). Told
// from inside its page — the PlayerAPI its own play buttons use, its own search page — it plays with nothing shown and
// nothing coming forward (measured on the Mac the same day: search 38 ms, Spotify hidden throughout). The page is
// reached through Chromium's debugging port, which Spotify opens when started with --remote-debugging-port: on this
// computer only, and no web page can use it (Chromium turns away any page's origin). iJWA starts Spotify so,
// minimized (--minimized, as Spotify's own start with Windows: no window); one the user started is started again so,
// once, the first time a song is picked.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = 47825;
const ARGS = [`--remote-debugging-port=${PORT}`, '--minimized'];
const log = (...words) => console.log('[spotify inside]', ...words);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Its page's address for the debugging protocol, from the port's list of pages. */
async function page() {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
    return pages.find((p) => p.type === 'page' && String(p.url).includes('xpui'))?.webSocketDebuggerUrl || null;
  } catch { return null; }
}

/** `expression` run in Spotify's page, awaited; its answer. */
async function evaluate(expression, ms = 8000) {
  const address = await page();
  if (!address) return null;
  return new Promise((resolve) => {
    let socket;
    const done = (value) => { clearTimeout(timer); try { socket?.close(); } catch { /* gone */ } resolve(value); };
    const timer = setTimeout(() => done(null), ms);
    try { socket = new WebSocket(address); } catch { done(null); return; }
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } })));
    socket.addEventListener('message', (event) => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.id === 1) done(message.result?.result?.value ?? null);
    });
    socket.addEventListener('error', () => done(null));
  });
}

// Finds Spotify's platform and PlayerAPI once and keeps them on the page: the app's root holds its platform, whose
// registry holds the player its own play buttons use.
const FIND = `
window.__ijwaInside = window.__ijwaInside || (() => {
  let found = null;
  return () => {
    if (found) return found;
    const root = [...document.querySelectorAll('body *')].find((e) => Object.keys(e).some((k) => k.startsWith('__reactContainer')));
    if (!root) return null;
    const stack = [root[Object.keys(root).find((k) => k.startsWith('__reactContainer'))]];
    let platform = null;
    for (let n = 0; stack.length && n < 50000 && !platform; n++) {
      const fiber = stack.pop();
      if (!fiber) continue;
      if (fiber.memoizedProps?.platform?.getRegistry) platform = fiber.memoizedProps.platform;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    if (!platform) return null;
    const registry = platform.getRegistry();
    let key = null;
    registry._map.forEach((value, name) => { if (name.description === 'PlayerAPI') key = name; });
    found = key ? { platform, player: registry.resolve(key) } : null;
    return found;
  };
})()`;

/** Where Spotify is: the one running, else where Spotify's installer puts it, else the Store's alias for it. */
function spotifyExe() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path"],
    { windowsHide: true, timeout: 5000 }, (error, out) => {
      const running = String(out || '').trim();
      if (running && fs.existsSync(running)) return resolve({ exe: running, running: true });
      const candidates = [path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'Spotify.exe')];
      resolve({ exe: candidates.find((file) => fs.existsSync(file)) || null, running: false });
    });
  });
}

/** NowPlaying, for whether Spotify plays: told by the queue (playqueue.js), the one reader that mustn't start it again. */
let helper = null;
function useHelper(nowPlaying) { helper = nowPlaying; }

/** Whether Spotify plays now (SpotifyInside.spotifyPlays): the Mac asks Spotify itself; here Windows' media session
 *  for it says, as the helper last heard (smtc.ps1), else the song followed. */
function spotifyPlays() {
  const np = helper;
  if (!np) return false;
  const { sourceOf } = require('./nowplaying');
  if (Array.isArray(np.sessions)) return np.sessions.some((one) => one.playing && sourceOf(one.app) === 'spotify');
  return Boolean(np.playing && np.track?.source === 'spotify');
}

async function playerFound() {
  return (await evaluate(`${FIND}; window.__ijwaInside() ? 'found' : 'no'`, 2000)) === 'found';
}

let readying = null;
/** Spotify running with its page reachable and its player found: started so if it isn't running, started again so if
 *  the user started it. One at a time. `restarting` (SpotifyInside.Restarting): for a song asked to play, 'always' —
 *  something new starts anyway; to read its queue, 'whenSilent' — only while it plays nothing, never cutting a song
 *  short. */
async function ready(restarting = 'always') {
  if (process.platform !== 'win32') return false;
  if (restarting === 'whenSilent' && !(await playerFound()) && spotifyPlays()) return false;
  readying ||= (async () => {
    if (await playerFound()) return true;
    const { exe, running } = await spotifyExe();
    if (!exe) return false;
    if (running) {
      log('Spotify started again, its page reachable');
      await new Promise((done) => execFile('taskkill', ['/F', '/T', '/IM', 'Spotify.exe'], { windowsHide: true }, () => done()));
      await sleep(800);
    }
    spawn(exe, ARGS, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 50; i++) {
      await sleep(300);
      if (await playerFound()) return true;
    }
    log("Spotify's page couldn't be reached");
    return false;
  })().finally(() => { readying = null; });
  return readying;
}

/** Plays `uri` — in `context` (an album, a playlist, an artist), from it, when there is one. 'played', 'refused' or
 *  'unreachable'. */
async function play(uri, context = null) {
  if (!(await ready())) return 'unreachable';
  const call = context
    ? `inside.player.play({ uri: ${JSON.stringify(context)} }, { featureIdentifier: 'ijwa' }, { skipTo: { uri: ${JSON.stringify(uri)} } })`
    : `inside.player.play({ uri: ${JSON.stringify(uri)} }, { featureIdentifier: 'ijwa' }, {})`;
  const answer = await evaluate(`${FIND};
    (async () => { const inside = window.__ijwaInside(); if (!inside) return 'no player'; await ${call}; return 'played'; })()`);
  log('played', uri, 'in', context || 'nothing', '→', answer ?? 'no answer');
  return answer === 'played' ? 'played' : 'refused';
}

/** An album, song or artist found by Spotify's own search service, the one its search page asks (searchDesktop, through
 *  the page's GraphQL loader): nothing drawn, so it works with Spotify minimized. The page's own search drawn unseen,
 *  which this replaced, found nothing there: a minimized window draws no results (a customer's PC and the VM,
 *  2026-10-11). The query's ID is read from Spotify's own search code each start, so an update of Spotify keeps it.
 *  Its "spotify:…" address, or null. */
async function search(kind, title, artist = '') {
  if (!(await ready())) return null;
  const answer = await evaluate(`${FIND};
    (async () => {
      const inside = window.__ijwaInside();
      if (!inside) return null;
      if (!window.__ijwaSearchHash) {
        const code = await (await fetch('https://xpui.app.spotify.com/xpui-routes-search.js')).text();
        window.__ijwaSearchHash = (code.match(/"searchDesktop","query","([0-9a-f]{64})"/) || [])[1] || null;
      }
      if (!window.__ijwaSearchHash) return null;
      const kind = ${JSON.stringify(kind)};
      const title = ${JSON.stringify(String(title || ''))}.replace(/\\s+-\\s+(single|ep)$/i, '');
      const lead = ${JSON.stringify(String(artist || ''))}.split(/\\s*(?:,|&|\\bfeat\\.?|\\bft\\.?|\\bx\\b|\\bwith\\b)\\s*/i)[0];
      const plain = (text) => String(text || '').toLowerCase().replace(/\\s*[([].*?[)\\]]/g, '').replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();
      const want = plain(title), who = plain(lead);
      const load = inside.platform.getGraphQLLoader();
      const result = await load({ name: 'searchDesktop', operation: 'query', sha256Hash: window.__ijwaSearchHash, value: null }, {
        searchTerm: kind === 'artist' ? title : (title + ' ' + lead).trim(), offset: 0, limit: 10, numberOfTopResults: 5,
        includeAudiobooks: false, includeArtistHasConcertsField: false, includePreReleases: false,
        includeLocalConcertsField: false, includeAuthors: false });
      const found = result?.data?.searchV2;
      if (!found) return null;
      const byName = (items, name, people) => {
        const named = items.filter((x) => plain(name(x)) === want);
        return named.find((x) => !who || people(x).some((p) => plain(p) === who)) || named[0]
          || items.find((x) => plain(name(x)).includes(want) && (!who || people(x).some((p) => plain(p) === who))) || null;
      };
      if (kind === 'artist') {
        return (found.artists?.items || []).find((x) => plain(x.data?.profile?.name) === want)?.data?.uri || null;
      }
      if (kind === 'album') {
        const albums = (found.albumsV2?.items || []).map((x) => x.data).filter(Boolean);
        return byName(albums, (x) => x.name, (x) => (x.artists?.items || []).map((a) => a.profile?.name))?.uri || null;
      }
      const tracks = (found.tracksV2?.items || []).map((x) => x.item?.data).filter(Boolean);
      return byName(tracks, (x) => x.name, (x) => (x.artists?.items || []).map((a) => a.profile?.name))?.uri || null;
    })()`, 10000);
  log('searched', kind, title, '→', answer ?? 'nothing');
  return answer;
}

// ---- its queue (SpotifyInside.queue, skip, remove, add; 2026-10-12) ----

/** What Spotify plays next, from its own queue inside its page (the PlayerAPI its queue page uses): the song playing,
 *  the songs the user lined up, then the ones it carries on with — each { id: "uri|uid", title, artist, album, duration,
 *  artwork, current, queued }. Its app isn't started again for this while it plays: null then, and when its page can't
 *  be reached. */
async function queue() {
  if (!(await ready('whenSilent'))) return null;
  const text = await evaluate(`${FIND};
    (async () => {
      const inside = window.__ijwaInside();
      if (!inside) return null;
      const platform = inside.platform;
      const api = (name) => { let key = null; platform.getRegistry()._map.forEach((v, k) => { if (k.description === name) key = k; }); return platform.getRegistry().resolve(key); };
      const picture = (images) => { const url = ((images || []).find((i) => i.label === 'standard') || (images || [])[0] || {}).url || ''; const id = url.split(':')[2]; return id ? 'https://i.scdn.co/image/' + id : ''; };
      const queue = await api('PlayerAPI').getQueue();
      const song = (t, current, queued) => ({ id: t.uri + '|' + (t.uid || ''), title: t.name || '', artist: (t.artists || []).map((a) => a.name).join(', '),
        album: t.album?.name || '', duration: (t.duration?.milliseconds || 0) / 1000, artwork: picture(t.album?.images), current, queued });
      const songs = [];
      if (queue.current) songs.push(song(queue.current, true, false));
      for (const t of queue.queued || []) songs.push(song(t, false, true));
      for (const t of (queue.nextUp || []).slice(0, 60)) songs.push(song(t, false, false));
      return JSON.stringify(songs);
    })()`, 6000);
  let rows; try { rows = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows.filter((song) => typeof song?.id === 'string' && typeof song.title === 'string' && song.title)
    .map((song) => ({ id: song.id, title: song.title, artist: song.artist || '', album: song.album || '',
      duration: Number(song.duration) || 0, artwork: song.artwork || '', current: Boolean(song.current), queued: Boolean(song.queued) }));
}

/** Plays the song of Spotify's queue that `id` names ("uri|uid"), as a click on it in its queue: whether it went. */
async function skipTo(id) {
  const parts = String(id).split('|');
  if (parts.length !== 2 || !(await playerFound())) return false;
  const answer = await evaluate(`${FIND};
    (async () => {
      const inside = window.__ijwaInside();
      if (!inside) return null;
      const platform = inside.platform;
      let key = null; platform.getRegistry()._map.forEach((v, k) => { if (k.description === 'PlayerAPI') key = k; });
      await platform.getRegistry().resolve(key).skipTo({ uri: ${JSON.stringify(parts[0])}, uid: ${JSON.stringify(parts[1])} });
      return 'played';
    })()`, 6000);
  log('skipped to', parts[0], "in Spotify's queue →", answer ?? 'no answer');
  return answer === 'played';
}

/** The song `id` ("uri|uid") taken out of Spotify's queue: whether it was. */
function remove(id) {
  const parts = String(id).split('|');
  if (parts.length !== 2) return Promise.resolve(false);
  return player(`removeFromQueue([{ uri: ${JSON.stringify(parts[0])}, uid: ${JSON.stringify(parts[1])} }])`);
}

/** Spotify's song `uri` added to its queue, to play next or after the songs lined up: whether it was. */
function add(uri, next) {
  if (!String(uri).startsWith('spotify:track:')) return Promise.resolve(false);
  return player(`${next ? 'playAsNextInQueue' : 'addToQueue'}([{ uri: ${JSON.stringify(uri)} }])`);
}

/** `call` made on Spotify's PlayerAPI in its page, awaited: whether it went. Spotify shows the change in its queue a
 *  second or two later, and the queue (playqueue.js) reads it again until it does. Its app isn't started for it. */
async function player(call) {
  if (!(await playerFound())) return false;
  const answer = await evaluate(`${FIND};
    (async () => {
      const inside = window.__ijwaInside();
      if (!inside) return null;
      const platform = inside.platform;
      let key = null; platform.getRegistry()._map.forEach((v, k) => { if (k.description === 'PlayerAPI') key = k; });
      await platform.getRegistry().resolve(key).${call};
      return 'done';
    })()`, 6000);
  log("Spotify's queue:", `${call.slice(0, 40)}…`, '→', answer ?? 'no answer');
  return answer === 'done';
}

// ---- the user's lists (SpotifyInside.library, songs(of:)) ----

// A picture as Spotify gives it: spotify:image:<id>, or now a plain https link, passed on as it is.
const PICTURE = `const picture = (url) => { const text = String(url || ''); if (/^https?:\\/\\//.test(text)) return text; const id = text.split(':')[2]; return id ? 'https://i.scdn.co/image/' + id : ''; };`;

/** The user's lists in Spotify's app — the songs they liked first, then their playlists, those in folders too — read
 *  from its own library inside its page: no Web Player tab, nothing shown. The Mac has read them so since 2026-10-10;
 *  here they were read only in a browser's Web Player tab, which a customer listening in the app had none of, and none
 *  came (2026-10-14). Each { id, name, count, artwork, owner }; null when its page can't be reached. */
async function library() {
  if (!(await ready('whenSilent'))) return null;
  const text = await evaluate(`${FIND};
    (async () => {
      const inside = window.__ijwaInside();
      if (!inside) return null;
      const platform = inside.platform;
      const api = (name) => { let key = null; platform.getRegistry()._map.forEach((v, k) => { if (k.description === name) key = k; }); return platform.getRegistry().resolve(key); };
      ${PICTURE}
      const liked = await api('LibraryAPI').getTracks({ offset: 0, limit: 1000 });
      const lists = [{ id: 'spotify:collection:tracks', name: 'Liked Songs', count: liked.totalLength || liked.items.length, artwork: '', owner: '' }];
      const walk = (items) => { for (const item of items || []) {
        if (item.type === 'playlist') lists.push({ id: item.uri, name: item.name, count: item.totalLength ?? null, artwork: picture(item.images?.[0]?.url), owner: item.owner?.name || item.owner?.displayName || '' });
        else if (item.items) walk(item.items);
      } };
      walk((await api('RootlistAPI').getContents()).items);
      return JSON.stringify(lists);
    })()`, 10000);
  let rows; try { rows = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  log(rows.length, "lists in Spotify's app");
  return rows.filter((list) => typeof list?.id === 'string' && typeof list.name === 'string')
    .map((list) => ({ id: list.id, name: list.name, count: list.count ?? null, artwork: list.artwork || '', owner: list.owner || '' }));
}

/** A list's songs, from Spotify's own library inside its page: its songs liked, or a playlist's, 500 at most. Each
 *  { id, title, artist, album, duration, artwork, link }; null when its page can't be reached. */
async function songs(list) {
  if (!(await ready('whenSilent'))) return null;
  const text = await evaluate(`${FIND};
    (async () => {
      const inside = window.__ijwaInside();
      if (!inside) return null;
      const platform = inside.platform;
      const api = (name) => { let key = null; platform.getRegistry()._map.forEach((v, k) => { if (k.description === name) key = k; }); return platform.getRegistry().resolve(key); };
      ${PICTURE}
      const uri = ${JSON.stringify(String(list))};
      const songs = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const page = uri === 'spotify:collection:tracks'
          ? await api('LibraryAPI').getTracks({ offset, limit: 100 })
          : await api('PlaylistAPI').getContents(uri, { offset, limit: 100 });
        for (const t of page.items || []) {
          if (!String(t.uri).startsWith('spotify:track:')) continue;
          songs.push({ id: t.uri, title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '), album: t.album?.name || '',
            duration: (t.duration?.milliseconds || 0) / 1000, artwork: picture((t.album?.images || []).find((i) => i.label === 'standard')?.url || t.album?.images?.[0]?.url),
            link: 'https://open.spotify.com/track/' + t.uri.split(':')[2] });
        }
        if ((page.items || []).length < 100) break;
      }
      return JSON.stringify(songs);
    })()`, 15000);
  let rows; try { rows = JSON.parse(text); } catch { return null; }
  return Array.isArray(rows) ? rows.filter((song) => typeof song?.id === 'string' && typeof song.title === 'string') : null;
}

module.exports = { play, search, ready, queue, skipTo, remove, add, library, songs, useHelper, ARGS };
