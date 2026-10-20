// iBaila's word with this browser. iBaila — the app on this computer, Mac or PC — waits at a port on this computer
// only; this finds it, says which browser it is, and does what it asks with the browser's YouTube Music and
// SoundCloud tabs (and Spotify's Web Player): lists them, sends one to a page, opens one, has a page play, pause, skip or start (page.js),
// and reads the user's own lists there for iBaila's playlist (lists.js).
// Nothing else of the browser is seen or touched. iBaila not running, it is looked for again every half minute.
import { pageAction, pageSong } from './page.js';
import { pageLists } from './lists.js';
import { pageQueue } from './queue.js';
import { pageAudio } from './audio.js';

const PORTS = [47823, 47824];
const SITES = [
  { site: 'youTubeMusic', hosts: ['music.youtube.com'] },
  { site: 'soundCloud', hosts: ['soundcloud.com', 'm.soundcloud.com'] },
  // Spotify's Web Player in the browser — not Spotify's app, which iBaila follows on its own.
  { site: 'spotifyWeb', hosts: ['open.spotify.com'] },
];
const PATTERNS = SITES.flatMap((s) => s.hosts.map((host) => `*://${host}/*`));

/** The browser this is, by the name iBaila knows it. */
function browserName() {
  const agent = navigator.userAgent;
  if (/\bEdg\//.test(agent)) return 'edge';
  if (/\bOPR\//.test(agent)) return 'opera';
  if (/\bVivaldi\//.test(agent)) return 'vivaldi';
  if (navigator.brave) return 'brave';
  return 'chrome';
}

function siteOf(url) {
  try {
    const host = new URL(url).hostname;
    return SITES.find((s) => s.hosts.includes(host))?.site || null;
  } catch { return null; }
}

// ---- iBaila ----

let socket = null;
let connecting = false;

/** Looks for iBaila at its ports, one after another. */
function connect(index = 0) {
  if (socket || connecting) return;
  connecting = true;
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORTS[index]}/ibaila`); } catch { connecting = false; return; }
  ws.onopen = () => {
    connecting = false;
    socket = ws;
    send({ hello: { browser: browserName(), version: chrome.runtime.getManifest().version } });
    // What each page plays: iBaila has just come (or come back) — and a paused page says nothing by itself.
    for (const state of states.values()) send(state);
    askPages();
  };
  ws.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    // iBaila's pings only keep this awake: a message heard holds the browser from putting it to sleep.
    if (message.id != null) answer(message);
    if (message.latest) freshen(message.latest);
  };
  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
      setTimeout(connect, 2000);
    } else if (connecting) {
      connecting = false;
      if (index + 1 < PORTS.length) connect(index + 1);
    }
  };
  ws.onerror = () => {};   // its close follows
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function answer(message) {
  let reply;
  try { reply = await handle(message); } catch (error) { reply = { ok: false, error: String(error?.message || error) }; }
  // The question's number last: nothing in an answer (a song's own id, say) may take its place.
  send({ ...reply, id: message.id });
}

// ---- kept up to date ----

// Added by hand (not from the store), the extension is read from its folder only as the browser starts it: iBaila
// updated, a newer copy lay in the folder while this one ran on — and couldn't see Spotify's Web Player, which the newer
// one could (2026-10-10). iBaila, which writes that folder, says which version lies there; newer than this one, it
// starts itself again into it — once for each version, and never one the store keeps up to date itself.
const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function freshen(latest) {
  const manifest = chrome.runtime.getManifest();
  if (manifest.update_url || !newer(latest, manifest.version)) return;
  const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
  if (reloadedFor === latest) return;
  await chrome.storage.local.set({ reloadedFor: latest });
  chrome.runtime.reload();
}

// ---- the music tabs ----

/** The browser's YouTube Music and SoundCloud tabs: the one playing first, then the ones shown, the latest first. */
async function musicTabs() {
  const [tabs, windows] = await Promise.all([chrome.tabs.query({ url: PATTERNS }), chrome.windows.getAll().catch(() => [])]);
  // A page in a minimized window that never played holds its song back until it's seen (iBaila for Windows shows such a
  // window unseen a moment).
  const minimized = new Set(windows.filter((w) => w.state === 'minimized').map((w) => w.id));
  return tabs
    .map((t) => ({ id: t.id, window: t.windowId, site: siteOf(t.url), url: t.url, title: t.title || '', audible: Boolean(t.audible),
      active: Boolean(t.active), at: t.lastAccessed || 0, minimized: minimized.has(t.windowId) }))
    .filter((t) => t.site)
    .sort((a, b) => (b.audible - a.audible) || (b.active - a.active) || (b.at - a.at));
}

function inPage(tab, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId: tab }, world: 'MAIN', func, args }).then((results) => results?.[0]?.result);
}

async function handle(m) {
  switch (m.do) {
    case 'tabs':
      return { ok: true, tabs: await musicTabs() };
    // A page asked to play, pause, skip, seek, go somewhere or start — in the page itself; a place in the song and
    // its loudness in each of its frames too, as SoundCloud's player may be in one of them (the first that could,
    // answers).
    case 'tell': {
      if (m.action === 'seek' || m.action === 'volume') {
        const results = await chrome.scripting.executeScript({ target: { tabId: m.tab, allFrames: true }, world: 'MAIN', func: pageAction,
          args: [m.site, m.action, m.arg ?? null] });
        const done = results.find((r) => r.result && r.result !== 'none');
        return { ok: true, answer: String(done?.result ?? 'none') };
      }
      return { ok: true, answer: String((await inPage(m.tab, pageAction, [m.site, m.action, m.arg ?? null])) ?? '') };
    }
    // The user's own lists on the tab's site — their playlists, the songs they liked — and a list's songs, read in the
    // page signed in there (lists.js).
    case 'library':
      return { ok: true, ...((await inPage(m.tab, pageLists, [m.site, { what: 'library', limit: m.limit }])) || { error: 'no answer' }) };
    // The song playing in the tab (or the one `song` names; `id` is the question's own number) liked or not: `on`
    // true or false sets it, none asks.
    case 'like':
      return { ok: true, ...((await inPage(m.tab, pageLists, [m.site, typeof m.on === 'boolean' ? { what: 'like', id: m.song, on: m.on } : { what: 'liked', id: m.song }])) || { error: 'no answer' }) };
    // The song playing's sound, for timing its words (audio.js): prepared, then taken in pieces.
    case 'audio':
      return { ok: true, ...((await inPage(m.tab, pageAudio, [m.site, { what: m.what, from: m.from, count: m.count }])) || { error: 'no answer' }) };
    // The song asked for comes as `item`: a message's own `id` is the number its answer is matched by.
    case 'queue':
      return { ok: true, ...((await inPage(m.tab, pageQueue, [m.site, { what: m.what || 'read', id: m.item, song: m.song, next: m.next }])) || { error: 'no answer' }) };
    case 'list':
      return { ok: true, ...((await inPage(m.tab, pageLists, [m.site, { what: 'list', id: m.list, limit: m.limit }])) || { error: 'no answer' }) };
    // What each music page says it plays.
    case 'songs': {
      const songs = [];
      for (const tab of await musicTabs()) {
        const title = await inPage(tab.id, pageSong).catch(() => '');
        if (title) songs.push({ tab: tab.id, site: tab.site, title });
      }
      return { ok: true, songs };
    }
    // A page opened: in the tab given, else in a new tab of the window last used — shown in it, as a page only starts
    // once its tab has been shown; the window itself stays where it is — else, with no window, in a new one, minimized.
    case 'open': {
      if (m.tab != null) {
        await chrome.tabs.update(m.tab, { url: m.url });
        return { ok: true, tab: m.tab };
      }
      // Opened only to read the user's lists in (iBaila's playlist shelf): a tab behind the one shown, the window
      // left as it is; with no window, a new one, minimized.
      if (m.background) {
        const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
        if (last) {
          const tab = await chrome.tabs.create({ windowId: last.id, url: m.url, active: false });
          return { ok: true, tab: tab.id };
        }
        const made = await chrome.windows.create({ url: m.url, focused: false, state: 'minimized' });
        return { ok: true, tab: made.tabs?.[0]?.id ?? null };
      }
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      if (windows.length) {
        const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => windows[0]);
        const tab = await chrome.tabs.create({ windowId: last.id, url: m.url, active: true });
        return { ok: true, tab: tab.id };
      }
      const made = await chrome.windows.create({ url: m.url, focused: false, state: 'minimized' });
      return { ok: true, tab: made.tabs?.[0]?.id ?? null };
    }
  }
  return { ok: false, error: `unknown: ${m.do}` };
}

// ---- what plays ----

/** Each music page asked what it plays now (content/main.js), its answer passed on as it would have told it. */
async function askPages() {
  for (const tab of await musicTabs()) {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN',
      func: () => (window.__ibailaNow ? window.__ibailaNow() : null) }).catch(() => []);
    const now = results.map((r) => r.result).find(Boolean);
    if (!now) continue;
    const state = { event: 'state', tab: tab.id, ...now };
    states.set(tab.id, state);
    send(state);
  }
}

/** Each music tab's last word on what it plays (content/main.js), passed on to iBaila as it comes. */
const states = new Map();

/** Each site's loudness as last told, kept for its next page (content/main.js applies it). */
const loudness = {};

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message?.state || !sender.tab) return;
  const state = { event: 'state', tab: sender.tab.id, ...message.state };
  if (typeof state.volume === 'number' && loudness[state.site] !== state.volume) {
    loudness[state.site] = state.volume;
    chrome.storage.local.set({ [`volume:${state.site}`]: state.volume });
  }
  states.set(sender.tab.id, state);
  if (socket) send(state); else connect();
});
chrome.tabs.onRemoved.addListener((tab) => { if (states.delete(tab)) send({ event: 'gone', tab }); });
// A music tab sent to another site.
chrome.tabs.onUpdated.addListener((tab, change) => {
  if (change.url && !siteOf(change.url) && states.delete(tab)) send({ event: 'gone', tab });
});

// ---- awake ----

chrome.alarms.create('ibaila', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
// Installed or updated: the music tabs already open still hold the old extension's word-passer, cut off — they told
// iBaila nothing until reloaded (2026-10-09). A new one goes into each, and the page's own listener (main.js) where it
// has none yet — a site the old one didn't know; where it has one, that one carries on.
chrome.runtime.onInstalled.addListener(async () => {
  connect();
  for (const tab of await chrome.tabs.query({ url: PATTERNS })) {
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['content/main.js'] }).catch(() => {});
    chrome.scripting.executeScript({ target, files: ['content/bridge.js'] }).catch(() => {});
  }
});
// A music tab starting or stopping wakes it too: iBaila is looked for at once.
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if ('audible' in change && siteOf(tab.url || '')) connect(); });
connect();
