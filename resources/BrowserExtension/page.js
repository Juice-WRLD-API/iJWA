// What a music page is asked to do, run inside the page itself (its own world, where YouTube's player and SoundCloud's
// buttons are). The same words the Mac's iBaila ran there by AppleScript (WebMusic.swift's javascript(for:on:)), so a
// page answers alike either way: "ok", "none" (nothing on it to press), "wait …" (not yet the page asked for),
// "pressed:…", "playing:…". Each function is handed to the page whole: nothing outside it is seen there.

/** held, play, pause, next, previous, seek (seconds), go (an address), start (the page's path: SoundCloud presses nothing
 *  until the page is that one). */
export function pageAction(site, action, arg) {
  // Whether the page holds its song back: unseen, and its song never loaded — Chromium keeps a page that never played
  // from loading its media while it isn't seen; SoundCloud's makes none at all, its Play left disabled (2026-10-10).
  // iBaila for Windows then shows a minimized window unseen a moment.
  if (action === 'held') {
    const m = window.__ibailaMedia || document.querySelector('video, audio');
    return document.hidden && (!m || m.readyState === 0) ? 'held' : 'free';
  }
  // iBaila's repeat (off, one, all): the page's own button pressed until it says that one (content/main.js holds it);
  // what it says then.
  if (action === 'repeat') return window.__ibailaRepeat ? window.__ibailaRepeat(arg) : 'none';
  // Spotify's Web Player: the page's own answers to the media keys (content/main.js holds them), else its own buttons
  // (data-testid, the same in every language); a page reached in the page itself, the music playing on.
  if (site === 'spotifyWeb') {
    const own = window.__ibailaActions || {};
    const media = window.__ibailaMedia;
    const button = (id) => document.querySelector(`[data-testid="${id}"]`);
    const press = (id) => { const b = button(id); if (!b) return 'none'; b.click(); return 'ok'; };
    const plays = () => (media ? !media.paused : null);
    // A button's own word on what it does: "Pause" while playing, in any of these languages.
    const saysPause = (b) => /pause|duraklat|pausa|pausieren|pauzeren|wstrzymaj|暂停|一時停止/i.test(b.getAttribute('aria-label') || '');
    switch (action) {
      case 'play':
        if (own.play) { own.play({ action: 'play' }); return 'ok'; }
        if (plays() === true) return 'ok';
        return press('control-button-playpause');
      case 'pause':
        if (own.pause) { own.pause({ action: 'pause' }); return 'ok'; }
        if (plays() === false) return 'ok';
        return press('control-button-playpause');
      case 'next': if (own.nexttrack) { own.nexttrack({ action: 'nexttrack' }); return 'ok'; } return press('control-button-skip-forward');
      case 'previous': if (own.previoustrack) { own.previoustrack({ action: 'previoustrack' }); return 'ok'; } return press('control-button-skip-back');
      case 'seek':
        if (own.seekto) { own.seekto({ action: 'seekto', seekTime: arg, fastSeek: false }); return 'ok'; }
        if (!media) return 'none';
        media.currentTime = arg; return 'ok';
      case 'volume':
        if (window.__ibailaWant) window.__ibailaWant(arg);
        if (window.__ibailaSlide && window.__ibailaSlide(arg)) return 'ok';
        if (!media) return 'none';
        media.volume = arg; return 'ok';
      // Its own address changed the way its links change it: no new page, the song playing plays on.
      case 'go': {
        const to = new URL(arg, location.href);
        if (to.host !== location.host) { location.href = to.href; return 'ok'; }
        history.pushState({}, '', to.pathname + to.search);
        dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        return 'ok';
      }
      // A song, album or artist found by Spotify's own search, the one signed in: what an open music encyclopedia
      // has no Spotify link for (Lil Mosey's "Call", 2026-10-10) is there all the same. Its results page shown a moment;
      // its address answered, or "none" when no result bears the name asked.
      case 'find': return (async () => {
        const { kind, artist } = arg || {};
        // Apple names its singles and EPs so ("Lifestyle - Single"); Spotify, not. Of the artists, the first.
        const title = String((arg || {}).title || '').replace(/\s+-\s+(single|ep)$/i, '');
        const lead = String(artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0];
        const tab = kind === 'album' ? 'albums' : kind === 'artist' ? 'artists' : 'tracks';
        const query = kind === 'artist' ? title : `${title} ${lead}`.trim();
        const plain = (text) => String(text || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const want = plain(title);
        const path = kind === 'album' ? '/album/' : kind === 'artist' ? '/artist/' : '/track/';
        // The result bearing the name asked: links of the page before (the results not drawn yet) never stand for it.
        const results = () => {
          if (!location.pathname.startsWith('/search/')) return null;
          const links = [...document.querySelectorAll(`main a[href*="${path}"]`)];
          return links.find((a) => plain(a.textContent) === want) || links.find((a) => plain(a.textContent).includes(want)) || null;
        };
        history.pushState({}, '', `/search/${encodeURIComponent(query)}/${tab}`);
        dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        // Waited for as the page draws them, not by the clock: a tab no one sees has its clock slowed to a tick a
        // second, and the results were waited for past iBaila's patience (2026-10-10).
        const pick = await new Promise((done) => {
          const found = results();
          if (found) return done(found);
          const watch = new MutationObserver(() => { const now = results(); if (now) { watch.disconnect(); done(now); } });
          watch.observe(document.documentElement, { childList: true, subtree: true });
          setTimeout(() => { watch.disconnect(); done(results()); }, 7000);
        });
        if (pick) return new URL(pick.getAttribute('href'), location.origin).href;
        // What the page held instead, for iBaila's log.
        const seen = [...document.querySelectorAll(`a[href*="${path}"]`)];
        const main = document.querySelector('main');
        const rows = document.querySelectorAll('[role="row"], [data-encore-id="card"], [data-testid*="card" i]').length;
        return `none ${location.pathname.slice(0, 50)} ${document.visibilityState} links:${seen.length} [${seen.slice(0, 4).map((a) => plain(a.textContent).slice(0, 24)).join(' | ')}] rows:${rows} anchors:${main ? main.querySelectorAll('a').length : -1} text:${main ? plain(main.innerText).slice(0, 120) : '-'} want:${want}`;
      })();
      // A song of one of the user's lists — or of an album — played in it, so the rest carries on after it: the page's own player
      // asked, as the list's rows ask it — it plays in a tab no one sees, and a song far down a long list too — else the
      // song's row pressed on the list's page. "played", or what happened instead.
      case 'playIn': return (async () => {
        if (location.hostname !== 'open.spotify.com') return 'wait ' + location.hostname;
        const { list, track } = arg || {};
        if (!list || !track) return 'none';
        const pause = (ms) => new Promise((done) => setTimeout(done, ms));
        const player = () => {
          const kept = window.__ibailaPlayer;
          if (kept && typeof kept.play === 'function') return kept;
          const root = document.querySelector('#main') || document.body;
          let fiber = null;
          for (const el of [root, ...root.querySelectorAll('div')].slice(0, 300)) {
            const key = Object.keys(el).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
            if (key) { fiber = el[key]; break; }
          }
          if (!fiber) return null;
          while (fiber.return) fiber = fiber.return;
          const stack = [fiber];
          for (let n = 0; stack.length && n < 20000; n++) {
            const f = stack.pop();
            const api = f.memoizedProps && f.memoizedProps.playerAPI;
            if (api && typeof api.play === 'function') return (window.__ibailaPlayer = api);
            if (f.sibling) stack.push(f.sibling);
            if (f.child) stack.push(f.child);
          }
          return null;
        };
        const playing = (api) => { try { const s = api.getState && api.getState(); return s && s.item ? s.item.uri : ''; } catch (e) { return ''; } };
        const api = player();
        let said = 'no player';
        if (api) {
          for (const skipTo of [{ uri: track }, { uri: track, index: Number((arg || {}).index) }]) {
            if (!(skipTo.index >= 0) && 'index' in skipTo) continue;
            try {
              // Its answer waited for a few seconds at most: signed out, it never comes.
              await Promise.race([api.play({ uri: list }, { featureIdentifier: list.startsWith('spotify:album:') ? 'album' : 'playlist' }, { skipTo }), pause(4000)]);
            } catch (e) { said = 'threw ' + String(e && e.message || e).slice(0, 60); continue; }
            for (let i = 0; i < 3; i++) { await pause(1000); if (playing(api) === track) return 'played'; }
            said = 'asked, playing ' + (playing(api) || 'nothing');
          }
        }
        // The song's row on the list's page, drawn once the page shows it.
        const id = track.split(':')[2];
        // A playlist's page, an album's, or the songs the user liked.
        const [, kind, key] = list.split(':');
        const path = kind === 'playlist' || kind === 'album' ? `/${kind}/${key}` : '/collection/tracks';
        if (location.pathname.replace(/^\/intl-[\w-]+/, '') !== path) {
          history.pushState({}, '', path);
          dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        }
        const rowOf = () => { const a = document.querySelector(`[data-testid="tracklist-row"] a[href*="/track/${id}"]`); return a && a.closest('[data-testid="tracklist-row"]'); };
        const row = await new Promise((done) => {
          if (rowOf()) return done(rowOf());
          const watch = new MutationObserver(() => { const r = rowOf(); if (r) { watch.disconnect(); done(r); } });
          watch.observe(document.documentElement, { childList: true, subtree: true });
          setTimeout(() => { watch.disconnect(); done(rowOf()); }, 6000);
        });
        const button = row && row.querySelector('button[aria-label]');
        if (!button) return 'none ' + said;
        button.click();
        return 'pressed row; ' + said;
      })();
      // The page's own big play button, unless it says it plays already; only on the page asked for.
      case 'start': {
        const want = arg ? String(arg).replace(/\/$/, '') : null;
        if (want && location.pathname.replace(/\/$/, '') !== want) return 'wait ' + location.pathname.slice(0, 40);
        const big = document.querySelector('[data-testid="action-bar-row"] [data-testid="play-button"]')
          || document.querySelector('main [data-testid="play-button"]');
        if (!big) return 'none ' + location.pathname.slice(0, 40);
        if (saysPause(big)) return 'playing:' + (big.getAttribute('aria-label') || '').slice(0, 30);
        big.click();
        return 'pressed:' + (big.getAttribute('aria-label') || '').slice(0, 30);
      }
    }
    return 'none';
  }

  if (site !== 'soundCloud') {
    // YouTube's player, on YouTube Music: its own calls, else the video itself.
    const p = document.getElementById('movie_player');
    const v = document.querySelector('video');
    switch (action) {
      case 'play': if (p && p.playVideo) { p.playVideo(); return 'ok'; } if (!v) return 'none'; v.play(); return 'ok';
      case 'pause': if (p && p.pauseVideo) { p.pauseVideo(); return 'ok'; } if (!v) return 'none'; v.pause(); return 'ok';
      // A song iBaila starts is never muted; how loud it plays is the page's own setting, which iBaila's volume shows.
      case 'start':
        if (p && p.playVideo) { if (p.unMute) p.unMute(); p.playVideo(); return 'ok'; }
        if (!v) return 'none';
        v.muted = false; v.play(); return 'ok';
      // iBaila's volume (0…1) is the page's own: YouTube Music's slider (content/main.js moves it), else the player's.
      case 'volume':
        if (window.__ibailaWant) window.__ibailaWant(arg);
        if (window.__ibailaSlide && window.__ibailaSlide(arg)) return 'ok';
        if (p && p.setVolume) { if (p.unMute) p.unMute(); p.setVolume(Math.round(arg * 100)); return 'ok'; }
        if (!v) return 'none';
        v.muted = false; v.volume = arg; return 'ok';
      case 'next': {
        const b = document.querySelector('ytmusic-player-bar .next-button, .ytp-next-button');
        if (b) { b.click(); return 'ok'; }
        if (p && p.nextVideo) { p.nextVideo(); return 'ok'; }
        return 'none';
      }
      case 'previous': {
        const b = document.querySelector('ytmusic-player-bar .previous-button, .ytp-prev-button');
        if (b) { b.click(); return 'ok'; }
        if (p && p.previousVideo) { p.previousVideo(); return 'ok'; }
        return 'none';
      }
      case 'seek': if (p && p.seekTo) { p.seekTo(arg, true); return 'ok'; } if (!v) return 'none'; v.currentTime = arg; return 'ok';
      // Gone from the page without its "Leave site?": the leaving's two ways of asking do nothing, and the page's
      // own onbeforeunload is dropped.
      case 'go':
        try {
          const P = BeforeUnloadEvent.prototype;
          Object.defineProperty(P, 'returnValue', { configurable: true, get() { return ''; }, set() {} });
          P.preventDefault = function () {};
        } catch (e) {}
        window.onbeforeunload = null;
        window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); }, true);
        location.href = arg;
        return 'ok';
    }
    return 'none';
  }

  // SoundCloud's buttons, found by what they say — "Play", "Pause", "Skip to next" — rather than by their look, which
  // SoundCloud changes: the player bar's along the window's foot, and the page's own, the biggest on it.
  const plays = ['play', 'abspielen', 'lire', 'reproducir', 'reproduzir', 'afspelen', 'odtwórz', 'spela'];
  const pauses = ['pause', 'pausieren', 'pausa', 'pauzeren', 'wstrzymaj'];
  // SoundCloud's 2025 pages draw inside a frame of its own site: every document is looked through.
  const docs = [document];
  for (let i = 0; i < docs.length; i++) for (const f of docs[i].querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }
  const query = (q) => docs.flatMap((d) => [...d.querySelectorAll(q)]);
  const view = (x) => (x.ownerDocument && x.ownerDocument.defaultView) || window;
  const inner = (x, q) => { const y = x.querySelector(q); return y ? y.getAttribute('aria-label') || y.textContent : ''; };
  // What a button says it does comes first: SoundCloud keeps "sc-button-play" on a button saying "Pause".
  const labelOf = (x) => [x.getAttribute('aria-label'), x.getAttribute('title'), inner(x, '[aria-label]'), inner(x, 'title')].filter(Boolean).join(' ').toLowerCase();
  const classOf = (x) => [typeof x.className === 'string' ? x.className : '', x.getAttribute('data-testid') || '',
    (x.textContent || '').trim().length < 16 ? x.textContent : ''].join(' ').toLowerCase();
  const said = (x) => (labelOf(x) + ' | ' + classOf(x)).trim();
  const words = (s) => s.split(/[^a-zçğıöşüóéè]+/);
  const state = (x) => {
    const l = labelOf(x);
    if (/playlist|plays|player|next up|play next/.test(l)) return null;
    const w = words(l || classOf(x));
    if (pauses.some((p) => w.includes(p))) return 'pause';
    if (plays.some((p) => w.includes(p))) return 'play';
    return null;
  };
  const is = (x, list) => state(x) === (list === pauses ? 'pause' : 'play');
  const has = (x, word) => said(x).includes(word);
  const size = (x) => { const r = x.getBoundingClientRect(); return r.width * r.height; };
  const shown = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const all = [];
  const met = new Set();
  // Never a link (the logo goes home) nor anything in the page's header.
  const away = (x) => (x.tagName.toLowerCase() === 'a' && x.getAttribute('href')) || x.closest('header,nav')
    || (x.ownerDocument === document && x.getBoundingClientRect().top < 90) || x.tagName.toLowerCase() === 'iframe';
  for (const x of query('button,a,[role="button"],[aria-label],[title],[data-testid],svg')) {
    const t = x.closest('button,a,[role="button"],[tabindex]') || (x.tagName.toLowerCase() === 'svg' ? x.parentElement : x);
    if (t && !met.has(t) && shown(t) && !away(t)) { met.add(t); all.push(t); }
  }
  const bar = all.filter((x) => x.getBoundingClientRect().top > view(x).innerHeight - 140);
  const biggest = (list) => all.filter((x) => is(x, list) && !bar.includes(x)).sort((a, b) => size(b) - size(a))[0];
  const press = (x) => { if (x.click) x.click(); else x.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
  const wave = () => {
    const w = query('canvas,[class*="waveform" i],[data-testid*="waveform" i]')
      .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 200 && r.top < view(x).innerHeight - 140; })
      .sort((a, b) => size(b) - size(a))[0];
    if (!w) return 'none';
    const r = w.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.left + 2, clientY: r.top + r.height / 2 };
    for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) w.dispatchEvent(k.startsWith('pointer') ? new PointerEvent(k, o) : new MouseEvent(k, o));
    return 'waveform';
  };
  // The page's play button by its shape, when nothing on it says Play: a round or square box one points at, 48 to 150
  // points, holding an icon and no picture, above the player bar; the biggest.
  const shaped = () => {
    const found = [];
    for (const x of query('button,a,div,span,[role="button"]')) {
      const r = x.getBoundingClientRect();
      if (r.width < 48 || r.width > 150 || Math.abs(r.width - r.height) > r.width * 0.12) continue;
      if (r.top < 0 || r.top > view(x).innerHeight - 160 || away(x) || view(x).getComputedStyle(x).cursor !== 'pointer') continue;
      if (!x.querySelector('svg') || x.querySelector('img,picture,canvas')) continue;
      if (x.parentElement && x.parentElement.getBoundingClientRect().width === r.width && found.includes(x.parentElement)) continue;
      found.push(x);
    }
    return found.sort((a, b) => size(b) - size(a))[0];
  };
  // What the page holds, for the log, when nothing could be pressed.
  const seen = () => 'none ' + location.pathname.slice(0, 40) + ' ' + document.visibilityState + ' frames:' + (docs.length - 1) + '/'
    + document.querySelectorAll('iframe').length + ' ' + all.length + ' ['
    + all.filter((x) => !bar.includes(x)).sort((a, b) => size(b) - size(a)).slice(0, 8)
      .map((x) => said(x).slice(0, 24) + '@' + Math.round(x.getBoundingClientRect().width)).join('|') + ']';
  // Never the space bar: it plays whatever the player bar holds, which may be another song.
  const start = () => {
    const p = biggest(plays), q = biggest(pauses);
    if (q && (!p || size(q) >= size(p))) return 'playing:' + said(q).slice(0, 40);
    if (p) { press(p); return 'pressed:' + said(p).slice(0, 40); }
    const b = shaped();
    if (b) { press(b); return 'shape:' + Math.round(b.getBoundingClientRect().width) + ' ' + said(b).slice(0, 30); }
    return wave() === 'waveform' ? 'waveform' : seen();
  };

  // iBaila's volume (0…1): the player's, and kept for the next song's player (content/main.js).
  if (action === 'volume') {
    if (window.__ibailaWant) window.__ibailaWant(arg);
    // SoundCloud's own slider (content/main.js), else its audio.
    if (window.__ibailaSlide && window.__ibailaSlide(arg)) return 'ok';
    window.__ibailaVolume = arg;
    const m = window.__ibailaMedia;
    if (!m) return 'none';
    m.muted = false;
    m.volume = arg;
    return 'ok';
  }

  // The page's own answers to the media keys, when it gave them (content/main.js holds them): what the Mac's and
  // Windows' media keys reach.
  const own = window.__ibailaActions || {};
  const answer = { play: 'play', pause: 'pause', next: 'nexttrack', previous: 'previoustrack' }[action];
  if (answer && own[answer]) { own[answer]({ action: answer }); return 'ok'; }
  if (action === 'seek' && own.seekto) { own.seekto({ action: 'seekto', seekTime: arg, fastSeek: false }); return 'ok'; }

  switch (action) {
    case 'play': { const b = bar.find((x) => is(x, plays)); if (b) { press(b); return 'ok'; } return start(); }
    case 'pause': {
      const b = bar.find((x) => is(x, pauses));
      if (b) { press(b); return 'ok'; }
      const big = biggest(pauses);
      if (big) { press(big); return 'ok'; }
      return 'none';
    }
    case 'next': { const b = bar.find((x) => has(x, 'next')); if (!b) return 'none'; press(b); return 'ok'; }
    case 'previous': { const b = bar.find((x) => has(x, 'previous') || has(x, 'prev')); if (!b) return 'none'; press(b); return 'ok'; }
    case 'seek': { const m = window.__ibailaMedia; if (!m) return 'none'; m.currentTime = arg; return 'ok'; }
    // SoundCloud is one page that changes its own address: a link it follows itself keeps it playing on.
    case 'go': { const a = document.createElement('a'); a.href = arg; document.body.appendChild(a); a.click(); a.remove(); return 'ok'; }
    // The page's own big play, unless it plays already (how loud: iBaila's volume, the page's own).
    case 'start': {
      const want = arg ? String(arg).replace(/\/$/, '') : null;
      if (want && location.pathname.replace(/\/$/, '') !== want) return 'wait ' + location.pathname.slice(0, 40);
      return start();
    }
  }
  return 'none';
}

/** The song the page says it plays: its own media session's title, the one it gives the computer's Now Playing. */
export function pageSong() {
  const m = navigator.mediaSession && navigator.mediaSession.metadata;
  return m ? m.title : '';
}
