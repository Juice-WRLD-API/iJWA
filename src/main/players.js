// Starting a song or an album in the app the user listens in. Spotify takes no orders from other apps and shares no
// song IDs, so spotify-agent.ps1 — a helper kept running beside iJWA — opens Spotify's own pages and presses
// the right Play button there, and reads the IDs of the song playing from Spotify's window.
const helpers = require('./agents');

/** A helper of iJWA's, asked one JSON line at a time (spotify-agent.ps1, web-agent.ps1), run in the helpers'
 *  PowerShell (agents.js). */
class Agent {
  seq = 0;
  waiting = new Map();   // seq → { resolve, timer }

  constructor(script) {
    this.name = script.replace(/\.ps1$/, '');
    helpers.listen(this.name, (line) => {
      let answer; try { answer = JSON.parse(line); } catch { return; }
      const asked = this.waiting.get(answer.seq);
      if (!asked) return;
      this.waiting.delete(answer.seq);
      clearTimeout(asked.timer);
      asked.resolve(answer);
    }, () => {
      for (const [, asked] of this.waiting) { clearTimeout(asked.timer); asked.resolve(null); }
      this.waiting.clear();
    });
  }

  start() { return helpers.send(this.name, 'start'); }

  /** Sends a command; answers its answer, or null when none comes in time — after which, for a command that must not
   *  take that long (`stuck`), the helper is started afresh. */
  ask(command, timeout, stuck = false) {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(seq);
        resolve(null);
        if (stuck) helpers.restart(this.name);
      }, timeout);
      this.waiting.set(seq, { resolve, timer });
      if (!helpers.send(this.name, JSON.stringify({ ...command, seq }))) { clearTimeout(timer); this.waiting.delete(seq); resolve(null); }
    });
  }

  stop() { helpers.stop(); }
}

const agent = new Agent('spotify-agent.ps1');

let helper = null;
/** The now-playing helper, told which song iJWA is starting so it knows its ID when it plays. */
function useHelper(nowPlaying) {
  helper = nowPlaying;
  // Started only where Spotify or Apple Music is listened to — chosen, or playing — so the first click there finds it
  // ready; listening on the web, it never runs (memory, 2026-10-10). Unused a while, it ends (agents.ps1).
  const warm = () => {
    const choice = nowPlaying.choice, source = nowPlaying.track?.source;
    if (choice === 'spotify' || choice === 'appleMusic' || source === 'spotify' || source === 'music') agent.start();
  };
  warm();
  nowPlaying.on('track', warm);
  nowPlaying.on('contenders', warm);
  require('electron').app.on('will-quit', () => agent.stop());
}

/** Plays a song, or an album, in Spotify. A new one gives the one still being looked for up. Pressed is not yet
 *  playing: Spotify is watched for a few seconds to see it start, and asked once more if it doesn't — the second time
 *  without the list around the song (NowPlaying.startInSpotify, Mac 2026-10-10). */
async function play(command, whole = false) {
  // Not on Windows (building on the Mac): Spotify is slow to answer, and never starts it.
  if (process.platform !== 'win32') { console.log('[spotify] would play', command); await new Promise((r) => setTimeout(r, 4000)); return whole ? null : false; }
  // The song playing before: an album or an artist pressed plays one of its songs, never one named like it.
  const before = helper?.track?.id || '';
  // From inside Spotify's own page first: found by its own search and played by its own player, nothing shown and
  // nothing coming forward (spotifyinside.js). The helper's way — its window made see-through, its search typed, its
  // buttons pressed — only when that page can't be reached.
  const inside = await playInside(command, before);
  if (inside) return whole ? inside : inside.ok;
  for (let attempt = 0; attempt < 2; attempt++) {
    const asked = attempt === 0 ? command : { ...command, context: undefined };
    const started = Date.now();
    const answer = await agent.ask({ do: 'play', ...asked }, 45000, true);
    if (answer?.error === 'superseded') return whole ? null : false;
    console.log('[spotify]', answer?.ok ? 'pressed' : 'failed', asked.id || `${asked.kind} ${asked.title}`, `${Date.now() - started} ms`, answer?.ok ? '' : answer?.error || 'no answer');
    if (!answer?.ok) { if (attempt === 0 && asked.context) continue; return whole ? answer : false; }
    if (await startedPlaying(asked, before, 7000)) return whole ? answer : true;
    // Spotify plays something new all the same: pressed again, the same button would pause it.
    if (helper?.playing && helper.track?.source === 'spotify' && helper.track.id !== before) {
      console.log('[spotify] pressed; it plays', helper.track.title, '— not pressed again');
      return whole ? answer : true;
    }
    console.log('[spotify] pressed but not playing', asked.title, attempt === 0 ? '— asked again' : '');
    if (attempt === 1) return whole ? answer : false;
  }
  return whole ? null : false;
}

/** `command` played inside Spotify's page: { ok, id, name, error }, or null when the page can't be reached. */
async function playInside(command, before) {
  const spotify = require('./spotifyinside');
  if (!(await spotify.ready())) return null;
  const kind = command.kind || 'track';
  const started = Date.now();
  // As on the Mac (NowPlaying.startSpotify), what to play is found first and then played inside: its Spotify ID when
  // known; else Spotify's own search service; else, as the Mac finds it, by name through MusicBrainz and Spotify's
  // public pages (spotifyweb.js).
  let uri = command.id ? `spotify:track:${command.id}` : await spotify.search(kind, command.title, command.artist || '');
  if (!uri) {
    const web = require('./spotifyweb');
    uri = await (kind === 'album' ? web.albumURI(command.title, command.artist || '')
      : kind === 'artist' ? web.artistURI(command.title)
        : web.songURI(command.title, command.artist || '', command.album || '')).catch(() => null);
  }
  if (!uri) {
    console.log('[spotify] not found in Spotify', kind, command.title, `${Date.now() - started} ms`);
    return { ok: false, error: 'not found in Spotify' };
  }
  const played = await spotify.play(uri, kind === 'track' ? command.context || null : null);
  if (played !== 'played') return { ok: false, error: `inside: ${played}` };
  const ok = await startedPlaying(command, before, 6000);
  console.log('[spotify]', ok ? 'playing' : 'played but not playing', uri, `${Date.now() - started} ms`);
  return { ok, id: uri.split(':')[1] === 'track' ? uri.split(':')[2] : '', name: command.title, pressed: 'inside' };
}

/** Whether Spotify plays what was asked within `ms`, as Windows' media session tells it (nowplaying.js): the song by its
 *  name; an album or an artist by a song of theirs, or any other than the one before. Matched by the song's name, an
 *  album never was: "pressed but not playing", it was pressed again — and the second press paused it (a friend's PC,
 *  Sıla's İmza, 2026-10-10). */
function startedPlaying(asked, before, ms) {
  const np = helper;
  const { title, kind } = asked;
  if (!np || !title) return Promise.resolve(true);
  const plainTitle = (t) => String(t || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/ - .*$/, '').trim();
  const playing = () => {
    if (!np.playing || np.track?.source !== 'spotify') return false;
    if (kind === 'album') return plainTitle(np.track.album) === plainTitle(title) || np.track.id !== before;
    if (kind === 'artist') return np.track.id !== before;
    return plainTitle(np.track.title) === plainTitle(title);
  };
  if (playing()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const check = () => { if (playing()) { done(true); } };
    const done = (value) => { clearTimeout(timer); np.off('track', check); np.off('playing', check); resolve(value); };
    const timer = setTimeout(() => done(playing()), ms);
    np.on('track', check);
    np.on('playing', check);
  });
}

// Songs found once through Spotify's search, by their Spotify ID: played again, they go straight there.
const found = new Map(); // "track|title|artist" → id
const plainKey = (kind, title, artist) => `${kind}|${String(title).toLowerCase().trim()}|${String(artist || '').toLowerCase().trim()}`;

/** Plays `title` by `artist` in Spotify, found through its search: kind 'track', 'album' or 'artist'. */
async function playInSpotify(kind, title, artist) {
  const key = plainKey(kind, title, artist);
  if (kind === 'track' && found.has(key)) return playSpotifyURI(`spotify:track:${found.get(key)}`, title);
  const answer = await play({ kind, title, artist: artist || '' }, true);
  if (answer?.ok && answer.id && kind === 'track') {
    found.set(key, answer.id);
    // The song now playing learns its ID, as if it had been played by it.
    helper?.learn?.(`spotify:track:${answer.id}`, title);
  }
  return Boolean(answer?.ok);
}

/** Plays a song by its Spotify address. Spotify only opens a song's album with the song marked while something else
 *  plays, so the song's own Play button is pressed there; Spotify is put back where it was. With a list (`context`, a
 *  playlist or the songs liked), the list's page is opened and the song's row pressed there, so the list goes on. */
function playSpotifyURI(uri, title = '', context = '') {
  helper?.expect?.(uri, title);
  return play({ kind: 'track', id: String(uri).split(':').pop(), title, ...(context ? { context } : {}) });
}

/** Plays a song, an album or an artist (`kind`: 'track', 'album', 'artist') in Windows' Apple Music app, found through
 *  its own search and played from its own pages (spotify-agent.ps1's Apple). */
async function playInAppleMusic(kind, title, artist) {
  if (process.platform !== 'win32') { console.log('[apple] would play', kind, title); return false; }
  const started = Date.now();
  const answer = await agent.ask({ do: 'apple', kind, title, artist: artist || '' }, 45000);
  console.log('[apple]', answer?.ok ? `played ${answer.played}${answer.started ? '' : ' (not started yet)'}` : `failed: ${answer?.error || 'no answer'}${answer?.first ? ` (first result: ${answer.first}, of ${answer.cards})` : ''}`,
    `${kind} ${title}`, `${Date.now() - started} ms`, answer?.restarted ? '(its search stuck: Apple Music started again)' : '');
  return Boolean(answer?.ok);
}

/** Moves the song playing in Windows' Apple Music app to `seconds`, by its own scrubber (spotify-agent.ps1's AppleSeek). */
function seekInAppleMusic(seconds) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return agent.ask({ do: 'apple-seek', seconds }, 6000).then((answer) => {
    if (!answer?.ok) console.log('[apple] seek failed:', answer?.error || 'no answer');
    return answer;
  });
}

/** Apple Music's repeat set to off, one or all by its own button (Windows' media controls can't): the one it took. */
function repeatInAppleMusic(mode) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return agent.ask({ do: 'apple-repeat', mode }, 8000).then((answer) => {
    if (!answer?.ok) console.log('[apple] repeat failed:', answer?.error || 'no answer');
    return answer?.ok ? answer.mode : null;
  });
}

/** The volume the mixer shows for the app playing (`app` as Windows' media controls name it), 0...1; set when `value`
 *  is given. Null when the app has no sound of its own to set. */
async function appVolume(app, value) {
  if (process.platform !== 'win32' || !app) return null;
  const answer = await agent.ask(value == null ? { do: 'volume', app } : { do: 'volume', app, value }, 8000);
  return value == null ? answer?.volume ?? null : Boolean(answer?.ok);
}

/** The Spotify IDs of the song playing (by its title), its album and its artists, read from Spotify's window. */
function readSpotifyNow(title) { return agent.ask({ do: 'now', title }, 15000); }

module.exports = { playInSpotify, playInAppleMusic, seekInAppleMusic, repeatInAppleMusic, readSpotifyNow, playSpotifyURI, appVolume, useHelper, Agent };
