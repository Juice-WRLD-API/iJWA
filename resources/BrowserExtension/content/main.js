// Inside YouTube Music's, SoundCloud's and Spotify's Web Player's pages, in their own world: what plays, told to iJWA through the extension
// (bridge.js passes it on) — the song the page names (its media session, what it gives the computer's Now Playing),
// where it is, whether it plays, and whether it is an ad. Told when it changes, and now and then while it plays.
// It keeps hold of the page's player too, for page.js: the audio SoundCloud never puts in the page, and the page's own
// answers to the media keys (play, pause, next, back, a place in the song).
//
// Each copy of it is on duty in turn: the extension updated, a newer copy is put into the pages already open, takes the
// duty over — the page's player and its answers to the media keys with it — and the older one falls quiet at its next
// look. The page's own hooks are set once, and hand what they catch to whichever copy is on duty: an open page needed
// reloading for each new version before (2026-10-10).
(() => {
  const me = {};
  window.__ijwaOnDuty = me;
  const onDuty = () => window.__ijwaOnDuty === me;
  const site = /(^|\.)soundcloud\.com$/.test(location.hostname) ? 'soundCloud' : location.hostname === 'open.spotify.com' ? 'spotifyWeb' : 'youTubeMusic';

  // The page's own hooks, once: its answers to the media keys as it hands them to the browser (kept for every copy),
  // and its player, told to play — SoundCloud plays from an audio element never put in the page.
  if (!window.__ijwaHooked) {
    window.__ijwaHooked = true;
    window.__ijwaActions = window.__ijwaActions || {};
    if (window.MediaSession) {
      const set = MediaSession.prototype.setActionHandler;
      MediaSession.prototype.setActionHandler = function (action, handler) {
        window.__ijwaActions[action] = handler;
        return set.call(this, action, handler);
      };
    }
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (window.__ijwaHold) window.__ijwaHold(this);
      return play.apply(this, args);
    };
    document.addEventListener('play', (event) => {
      if (event.target instanceof HTMLMediaElement && window.__ijwaHold) window.__ijwaHold(event.target, true);
    }, true);
  }

  // What the page sends its own site, heard once per page: Spotify's key and the fingerprints of its questions, and
  // SoundCloud's app key and the user's — what reading the user's lists takes (lists.js). Nothing else is kept, and
  // nothing leaves the page. Set apart from the hooks above, so pages hooked by an older copy gain it too. A frame of
  // the site's own (SoundCloud's 2025 pages) keeps what it hears in the page's top window.
  if (!window.__ijwaListening && site !== 'youTubeMusic') {
    window.__ijwaListening = true;
    let top = window;
    try { if (window.top.location.host === location.host) top = window.top; } catch (e) {}
    const heard = (top.__ijwaHeard = top.__ijwaHeard || {});
    const told = () => { top.__ijwaHeardWaiters = (top.__ijwaHeardWaiters || []).filter((check) => !check()); };
    const plain = (headers) => {
      if (!headers) return {};
      if (headers instanceof Headers) return Object.fromEntries(headers.entries());
      if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [String(k).toLowerCase(), v]));
      return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    };
    const note = (url, headers, body) => {
      url = String(url || '');
      if (site === 'spotifyWeb') {
        if (!/\.spotify\.com\//.test(url) || !/^Bearer /.test(headers.authorization || '')) return;
        if (/\/pathfinder\//.test(url)) {
          heard.spotify = headers;
          try {
            const asked = typeof body === 'string' ? JSON.parse(body) : null;
            const hash = asked && asked.extensions && asked.extensions.persistedQuery && asked.extensions.persistedQuery.sha256Hash;
            if (asked && asked.operationName && hash) {
              (heard.spotifyOps = heard.spotifyOps || {})[asked.operationName] = hash;
              (heard.spotifyVars = heard.spotifyVars || {})[asked.operationName] = asked.variables || {};
            }
          } catch (e) {}
        } else if (!heard.spotify) {
          heard.spotify = { authorization: headers.authorization };
        }
        told();
      } else if (/api(-v2)?\.soundcloud\.com/.test(url)) {
        const id = (url.match(/[?&]client_id=([^&]+)/) || [])[1];
        if (id) heard.soundCloudId = decodeURIComponent(id);
        if (/^OAuth /.test(headers.authorization || '')) heard.soundCloudAuth = headers.authorization;
        told();
      }
    };
    const fetched = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' || input instanceof URL ? input : input && input.url;
        const headers = { ...(input && input.headers ? plain(input.headers) : {}), ...plain(init && init.headers) };
        note(url, headers, init && init.body);
      } catch (e) {}
      return fetched.apply(this, arguments);
    };
    const opened = XMLHttpRequest.prototype.open;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ijwaUrl = url;
      try { note(url, {}, null); } catch (e) {}
      return opened.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { if (/^authorization$/i.test(name)) note(this.__ijwaUrl, { authorization: value }, null); } catch (e) {}
      return setHeader.apply(this, arguments);
    };
  }

  // The player, the one held before taken over.
  let media = null;
  const events = ['play', 'playing', 'pause', 'seeked', 'durationchange', 'ended', 'ratechange', 'loadedmetadata', 'volumechange'];
  const heard = () => { if (onDuty()) soon(); };
  const hold = (element) => {
    if (!element || element === media) return;
    media = element;
    window.__ijwaMedia = element;
    // The loudness iJWA set, kept from one song's player to the next.
    if (window.__ijwaVolume != null) element.volume = window.__ijwaVolume;
    for (const name of events) element.addEventListener(name, heard);
    settle();
  };
  window.__ijwaHold = (element, started) => { if (!onDuty()) return; hold(element); if (started) soon(); };

  // The loudness last chosen on this site — iJWA's slider or the page's own — kept by the extension (bridge.js
  // hands it over as the page opens) and given to the page's player once it has one: YouTube's own memory didn't keep
  // what iJWA set, and a song or site later the page was back at its old loudness (2026-10-09). Given, it is held a
  // few seconds — YouTube's player sets its own remembered loudness as it gets ready, over ours — and the page's
  // loudness isn't told meanwhile, or its old one would be kept instead.
  let wanted;            // not heard yet: undefined; none kept: null
  let appliedAt = 0;
  const holding = () => appliedAt > 0 && Date.now() - appliedAt < 6000;
  window.addEventListener('message', (event) => {
    // Pages post plain strings too (reCAPTCHA's "recaptcha-setup"): `in` throws on them.
    if (!onDuty() || event.source !== window || !event.data || typeof event.data !== 'object' || !('ijwaVolume' in event.data)) return;
    wanted = event.data.ijwaVolume;
    settle();
  });
  // iJWA's slider moved (page.js): that is the loudness held from now on.
  window.__ijwaWant = (level) => { wanted = level; };

  // YouTube Music's own volume slider, moved as a hand would: its value set and told, and the page turns its player to
  // it along its own curve — at 30 on the slider the player plays at 8 (measured 2026-10-09); set on the player
  // itself, the slider never moved and the two disagreed.
  // The page's own volume control, whichever page it is: the player bar's slider (tp-yt-paper-slider, 0…100); on the
  // newer page — a signed-in account's, 2026-10-09 — a plain range input in the player's volume pop-up
  // ("ytSliderShapeVerticalSlider"); on a page to come, any slider standing in something named for volume, never the
  // song's progress bar. Found once and kept while it is on the page.
  let found = null;
  const volumish = (e) => {
    for (let x = e, i = 0; x && i < 6; x = x.parentElement, i++) {
      const name = `${x.id || ''} ${typeof x.className === 'string' ? x.className : ''} ${x.getAttribute('aria-label') || ''} ${x.getAttribute('data-testid') || ''}`.toLowerCase();
      if (/progress|seek|timeline|scrub/.test(name)) return false;
      if (name.includes('volume')) return true;
    }
    return false;
  };
  const slider = () => {
    if (found && found.isConnected) return found;
    found = (site === 'youTubeMusic' && (document.querySelector('ytmusic-player-bar #volume-slider')
      || document.querySelector('input.ytSliderShapeVerticalSlider, [class*="VolumePopup"] input[type="range"]')))
      || [...document.querySelectorAll('input[type="range"], tp-yt-paper-slider')].find(volumish)
      || null;
    return found;
  };
  const range = (control) => {
    const low = Number(control.min ?? 0) || 0;
    const high = Number(control.max ?? 100) || 100;
    return { low, span: high > low ? high - low : 100 };
  };
  const level = (control) => {
    const { low, span } = range(control);
    const value = (Number(control.value) - low) / span;
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;
  };
  function slide(control, to) {
    const { low, span } = range(control);
    // To the control's own steps: whole numbers on a 0…100 one, finer on Spotify's 0…1 (rounded whole, 0.3 was 0).
    const step = Number(control.step) > 0 ? Number(control.step) : span > 1 ? 1 : 0;
    const exact = low + to * span;
    const value = step ? Math.round(exact / step) * step : exact;
    if (control instanceof HTMLInputElement) {
      // A plain input, set the way a hand's move sets it, past what the page may have put on its value.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(control, String(value));
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      control.value = value;
      control.dispatchEvent(new CustomEvent('value-change', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // With no slider where it's looked for, what the page has instead, told once for iJWA's log: YouTube Music's page
  // differs from account to account (a signed-in page had none there, 2026-10-09).
  let probed = '';
  function probe() {
    if (probed) return probed;
    // Inside the page's components too (their own shadow roots), where newer pages keep their controls.
    const roots = [document];
    for (let i = 0; i < roots.length && roots.length < 400; i++) {
      for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
    }
    const seen = roots.flatMap((r) => [...r.querySelectorAll('[id*="volume" i], [class*="volume" i], [aria-label*="volume" i], [aria-label*="ses" i], tp-yt-paper-slider, [role="slider"], input[type="range"]')])
      .slice(0, 14)
      .map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className || '').split(' ').slice(0, 2).join('.')}[${e.getAttribute('aria-label') || ''}]=${e.value ?? e.getAttribute('aria-valuenow') ?? ''}`);
    // Where the page keeps its loudness between visits (SoundCloud's isn't on its audio).
    let kept = [];
    try { kept = Object.keys(localStorage).filter((k) => /volume/i.test(k)).slice(0, 4).map((k) => `${k}=${String(localStorage.getItem(k)).slice(0, 60)}`); } catch (e) {}
    probed = `${roots.length - 1} shadow roots; ` + (seen.join(' | ') || 'nothing') + ' ; stored: ' + (kept.join(' | ') || 'none');
    return probed;
  }

  // SoundCloud's own volume, its player bar's (0…1): read off its slider; set the way a hand sets it — the pop-up
  // opened by pointing at it, the slider pressed at the height wanted, the pop-up let go — so SoundCloud turns its
  // player, moves its slider and keeps the loudness itself (its "V2::local::settings"; measured 2026-10-10: pressed at
  // 30%, it read 0.31 and kept 0.3). Set on its audio instead, SoundCloud's slider stayed full.
  const soundCloudSlider = () => (site === 'soundCloud' ? document.querySelector('.volume__sliderWrapper') : null);
  function soundCloudLevel(wrapper) {
    const value = Number(wrapper.getAttribute('aria-valuenow'));
    const top = Number(wrapper.getAttribute('aria-valuemax') || 1) || 1;
    return Number.isFinite(value) ? Math.min(Math.max(value / top, 0), 1) : null;
  }
  // Its own keys, Shift+Up and Shift+Down, a tenth a press, for a tab no one sees: there the browser holds the
  // pop-up's opening still, and it was never pressed (his Mac, 2026-10-10). Muted, the first press only gives back
  // the loudness SoundCloud kept; from that, to the one wanted.
  function soundCloudKeys(wrapper, to) {
    let kept = {};
    try { kept = JSON.parse(localStorage.getItem('V2::local::settings') || '{}') || {}; } catch (e) {}
    const key = (up) => document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: up ? 'ArrowUp' : 'ArrowDown', code: up ? 'ArrowUp' : 'ArrowDown', keyCode: up ? 38 : 40, which: up ? 38 : 40,
      shiftKey: true, bubbles: true }));
    let now = typeof kept.volume === 'number' ? kept.volume : (soundCloudLevel(wrapper) ?? 1);
    if (kept.muted) {
      if (to <= 0) return;
      key(true);
    }
    const steps = Math.round((to - now) / 0.1);
    for (let i = 0; i < Math.abs(steps); i++) key(steps > 0);
  }

  // The pop-up opens a moment after it's pointed at: the slider is pressed once it stands there.
  function soundCloudSet(wrapper, to) {
    if (document.visibilityState !== 'visible') { soundCloudKeys(wrapper, to); return true; }
    const box = wrapper.closest('.volume') || wrapper;
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) box.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' }));
    // Pressed once it has stopped opening — its place the same twice running: pressed mid-way, the height read was
    // the bottom, and SoundCloud went silent (2026-10-10).
    let tries = 0, last = null;
    const press = () => {
      const r = wrapper.getBoundingClientRect();
      const still = last && r.height > 0 && Math.abs(r.height - last.height) < 0.5 && Math.abs(r.top - last.top) < 0.5;
      last = r;
      if (!still) {
        if (++tries < 20) { setTimeout(press, 60); return; }
        // It never stood still: its own keys instead.
        for (const type of ['mouseout', 'mouseleave']) box.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseleave' }));
        soundCloudKeys(wrapper, to);
        return;
      }
      const at = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.bottom - r.height * to, button: 0 };
      wrapper.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
      wrapper.dispatchEvent(new MouseEvent('mouseup', at));
      document.dispatchEvent(new MouseEvent('mouseup', at));
      wrapper.dispatchEvent(new MouseEvent('click', at));
      setTimeout(() => {
        for (const type of ['mouseout', 'mouseleave']) box.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseleave' }));
      }, 150);
    };
    press();
    return true;
  }

  /** How loud the page plays, 0…1, and what said so: the site's own slider, else its player, else the audio. */
  function loudness() {
    const player = site === 'youTubeMusic' ? document.getElementById('movie_player') : null;
    const muted = player && player.isMuted && player.isMuted();
    const control = slider();
    if (control && level(control) != null) return { level: muted ? 0 : level(control), from: 'slider' };
    const cloud = soundCloudSlider();
    if (cloud && soundCloudLevel(cloud) != null) return { level: soundCloudLevel(cloud), from: 'slider' };
    if (player && player.getVolume) return { level: muted ? 0 : player.getVolume() / 100, from: 'player' };
    if (media) return { level: media.muted ? 0 : media.volume, from: 'audio' };
    return null;
  }

  /** The page made that loud, by the same control its loudness is read from. */
  function setLoudness(to) {
    const player = site === 'youTubeMusic' ? document.getElementById('movie_player') : null;
    if (player && player.isMuted && player.isMuted()) player.unMute();
    const control = slider();
    if (control) {
      const video = document.querySelector('video');
      const was = level(control), heard = video ? video.volume : null;
      slide(control, to);
      // The page took the move — its video's loudness changed with it; a page that heard nothing of it has its player
      // set instead, a moment later.
      if (video && heard != null && Math.abs(to - was) > 0.02 && player && player.setVolume) {
        setTimeout(() => { if (Math.abs(video.volume - heard) < 0.005) player.setVolume(Math.round(to * 100)); }, 400);
      }
      return true;
    }
    const cloud = soundCloudSlider();
    if (cloud && soundCloudSet(cloud, to)) { window.__ijwaVolume = null; return true; }
    if (player && player.setVolume) { player.setVolume(Math.round(to * 100)); return true; }
    if (media) { media.muted = false; media.volume = to; window.__ijwaVolume = to; return true; }
    return false;
  }
  window.__ijwaSlide = setLoudness;

  function settle() {
    if (wanted == null || (appliedAt && !holding())) return;
    const now = loudness();
    if (!now) return;
    if (Math.abs(now.level - wanted) > 0.03) setLoudness(wanted);
    if (!appliedAt) appliedAt = Date.now();
  }

  // The song playing on Spotify's Web Player, as its page: a link to it in the player, or the album's link that
  // points at it ("?highlight=spotify:track:…", as the signed-in page has it). Not there, what the player holds
  // instead, for iJWA's log.
  function spotifySong() {
    const pointed = document.querySelector('a[href*="highlight=spotify:track:"], a[href*="highlight=spotify%3Atrack%3A"]');
    if (pointed) {
      const id = decodeURIComponent(new URL(pointed.href).searchParams.get('highlight') || '').split(':')[2];
      if (id) return `https://open.spotify.com/track/${id}`;
    }
    const own = document.querySelector('[data-testid="now-playing-widget"] a[href*="/track/"], [data-testid="now-playing-bar"] a[href*="/track/"], footer a[href*="/track/"]');
    if (own) return own.href;
    // The signed-in page names only the song's album there (2026-10-10): that, and iJWA finds the song in its list.
    const bar = document.querySelector('[data-testid="now-playing-widget"], [data-testid="now-playing-bar"], footer');
    const album = bar && bar.querySelector('a[href*="/album/"]');
    if (album) return album.href;
    return bar ? 'none: ' + [...bar.querySelectorAll('a')].slice(0, 5).map((a) => a.getAttribute('href')).join(' ') : 'none: no bar';
  }

  // The page's own repeat — off, the song ("one") or all of it — read off its own button in any language: YouTube
  // Music's icon (loop, loop_active, loop_one), SoundCloud's mark on it (m-one, m-all), Spotify's checked or half
  // checked. iJWA's repeat button presses it until it says the one asked (page.js): the page then repeats as it
  // would for a hand (2026-10-10: iJWA's did nothing on any of them).
  // YouTube Music's older page keeps it in its player bar; the newer one (signed in, 2026-10-10) in its player controls.
  // The one shown: a page may keep a copy out of sight.
  const repeatSelector = site === 'youTubeMusic' ? 'ytmusic-player-bar .repeat, ytmusic-player-controls .repeat'
    : site === 'soundCloud' ? '.playControls .repeatControl, .repeatControl' : '[data-testid="control-button-repeat"]';
  const repeatButton = () => {
    let all = [...document.querySelectorAll(repeatSelector)];
    // YouTube Music's pages differ from account to account: his showed it in neither place (2026-10-10). Then anything
    // of its own named so, as the thing one presses.
    if (!all.length && site === 'youTubeMusic') {
      all = [...document.querySelectorAll('.repeat, [class*="repeat" i], [aria-label*="repeat" i]')]
        .map((x) => x.closest('yt-icon-button, tp-yt-paper-icon-button, yt-button-shape, button, [role="button"]') || x);
    }
    return all.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || all[0] || null;
  };
  // What YouTube Music's own page calls each mode, in its own language: asked of it once.
  let repeatWords = null;
  function repeatMode() {
    const b = repeatButton();
    if (!b) return null;
    if (site === 'youTubeMusic') {
      const icon = b.querySelector('yt-icon, .yt-icon');
      const name = String((icon && (icon.iconName || icon.iconType || icon.icon || icon.getAttribute('icon'))) || '').toLowerCase();
      if (/loop|repeat/.test(name)) return /one/.test(name) ? 'one' : /active|all|_on\b/.test(name) ? 'all' : 'off';
      const said = (b.getAttribute('title') || b.getAttribute('aria-label') || (b.querySelector('[aria-label]') || b).getAttribute('aria-label') || '').trim();
      if (!repeatWords) {
        const host = b.closest('ytmusic-player-bar, ytmusic-player-controls');
        try {
          if (host && typeof host.computeRepeatButtonAriaLabel === 'function') {
            repeatWords = { [host.computeRepeatButtonAriaLabel('NONE')]: 'off', [host.computeRepeatButtonAriaLabel('ALL')]: 'all',
              [host.computeRepeatButtonAriaLabel('ONE')]: 'one' };
          }
        } catch (e) {}
      }
      if (repeatWords && repeatWords[said]) return repeatWords[said];
      const lower = said.toLowerCase();
      return /\bone\b/.test(lower) ? 'one' : /\ball\b/.test(lower) ? 'all' : /\boff\b/.test(lower) ? 'off' : null;
    }
    if (site === 'soundCloud') return b.classList.contains('m-one') ? 'one' : b.classList.contains('m-all') ? 'all' : 'off';
    const checked = b.getAttribute('aria-checked');
    return checked === 'mixed' ? 'one' : checked === 'true' ? 'all' : 'off';
  }
  // The button as the page has it, for iJWA's log when it couldn't be read or pressed.
  function repeatSeen() {
    const all = [...document.querySelectorAll(repeatSelector)];
    const b = repeatButton();
    if (!b) {
      const like = [...document.querySelectorAll('[class*=repeat i], [aria-label*=repeat i]')].slice(0, 3)
        .map((x) => `${x.tagName.toLowerCase()}.${String(x.className).slice(0, 40)}[${x.getAttribute('aria-label') || ''}] in ${x.parentElement ? x.parentElement.tagName.toLowerCase() : '-'}`);
      return `no button; like it: ${like.join(' | ') || 'nothing'}`;
    }
    const icon = b.querySelector('yt-icon, .yt-icon, svg');
    return `${all.length} found, ${b.tagName.toLowerCase()}.${String(b.className).split(' ').slice(0, 2).join('.')}`
      + ` title="${b.getAttribute('title') || ''}" aria="${b.getAttribute('aria-label') || ''}" disabled=${Boolean(b.disabled)}`
      + ` icon=${icon ? `${icon.tagName.toLowerCase()}:${icon.iconName || icon.iconType || icon.getAttribute('icon') || '-'}` : 'none'}`;
  }
  // Pressed once more each time it took the press, up to the one asked — YouTube Music and SoundCloud change their
  // mark at once, Spotify once its player has answered: watched for, not waited for by the clock, which runs slow in
  // a tab no one sees. What the page says then, or "none" with no button to press.
  async function setRepeat(want) {
    if (!['off', 'one', 'all'].includes(want)) return 'none';
    for (let i = 0; i < 3; i++) {
      const was = repeatMode();
      if (was === want) return was;
      const b = repeatButton();
      if (!b || b.disabled || was == null) return 'none: ' + repeatSeen();
      b.click();
      await new Promise((done) => {
        if (repeatMode() !== was) return done();
        const watch = new MutationObserver(() => { if (repeatMode() !== was) { watch.disconnect(); done(); } });
        watch.observe(b.parentElement || b, { attributes: true, childList: true, subtree: true });
        setTimeout(() => { watch.disconnect(); done(); }, 2500);
      });
      if (repeatMode() === was) break;
    }
    return repeatMode() || 'none: ' + repeatSeen();
  }
  window.__ijwaRepeat = setRepeat;

  const plain = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  /** One name within the other, marks and spaces aside: "Lil Tecca" and "Lil Tecca - Topic". */
  const alike = (a, b) => { const x = plain(a), y = plain(b); return Boolean(x && y && (x.includes(y) || y.includes(x))); };
  const area = (art) => { const m = /(\d+)x(\d+)/.exec(art.sizes || ''); return m ? m[1] * m[2] : 0; };
  function now() {
    const m = navigator.mediaSession && navigator.mediaSession.metadata;
    const art = m && m.artwork && m.artwork.length ? [...m.artwork].sort((a, b) => area(b) - area(a))[0].src : '';
    const el = media || (site === 'youTubeMusic' ? document.querySelector('video') : null);
    if (el && el !== media) hold(el);
    const player = site === 'youTubeMusic' ? document.getElementById('movie_player') : null;
    // YouTube's own player keeps the song's time: its video runs on from one song of an album or list to the next
    // without starting again at nought, so a song just begun showed near its end (2026-10-10), and the video knows no
    // length while it loads. Loading, the song isn't moving: its time doesn't run on meanwhile.
    const own = player && typeof player.getCurrentTime === 'function' && typeof player.getDuration === 'function'
      && typeof player.getPlayerState === 'function' ? player : null;
    const ownState = own ? own.getPlayerState() : null;
    // A free account's ad can stand in the page's media details while YouTube's own player still holds the song, and
    // unmarked: an Allianz ad, paused, as Opera's page came back (2026-10-10). Neither its title nor its maker is the
    // player's song's.
    const held = own && typeof own.getVideoData === 'function' ? own.getVideoData() : null;
    const stranger = Boolean(m && held && held.title && !alike(m.title, held.title) && !alike(m.artist, held.author));
    const heard = holding() ? null : loudness();
    return {
      site,
      title: (m && m.title) || '', artist: (m && m.artist) || '', album: (m && m.album) || '', artwork: art,
      playing: own ? ownState === 1 || ownState === 3 : el ? !el.paused && !el.ended : navigator.mediaSession.playbackState === 'playing',
      position: own ? own.getCurrentTime() : el ? el.currentTime : null,
      duration: own ? own.getDuration() || 0 : el && isFinite(el.duration) ? el.duration : 0,
      rate: own && ownState === 3 ? 0 : el ? el.playbackRate : 1,
      // Spotify's Web Player: the song's own page, for its Spotify id (iJWA's Continue Playing finds songs like it).
      link: site === 'spotifyWeb' ? spotifySong() : '',
      // YouTube Music's song itself, as its player holds it (its media details and player agree, or it's an ad): the
      // heart in iJWA's bar likes this one, not whatever the player holds a moment later.
      song: site === 'youTubeMusic' && held && held.video_id && !stranger ? held.video_id : '',
      // off, one or all, as the page's own repeat button says; null with none.
      repeat: repeatMode(),
      volume: heard ? heard.level : null,
      volumeFrom: heard ? (heard.from === 'slider' ? 'slider' : `${heard.from}; ${probe()}`) : '',
      // YouTube Music marks its player while an ad plays; Spotify names its ads so.
      ad: Boolean(player && player.classList.contains('ad-showing')) || stranger
        || (site === 'spotifyWeb' && Boolean(m) && (/^advertisement$/i.test(m.title || '') || (m.artist || '') === 'Spotify')),
      at: Date.now(),
    };
  }

  // What plays now, asked by the extension when it (re)finds iJWA: a paused page tells nothing by itself.
  window.__ijwaNow = () => { const s = now(); return s.title ? s : null; };

  if (window.__ijwaMedia) hold(window.__ijwaMedia);

  let told = null;
  function tell(state) { told = state; window.postMessage({ ijwaState: state }, '*'); }
  let timer = 0;
  function soon() { clearTimeout(timer); timer = setTimeout(() => { const s = now(); if (s.title) tell(s); }, 60); }

  // Looked at each second; told when something changed, the place jumped, or ten seconds passed while playing. Off
  // duty — a newer copy took over — it stops.
  const looking = setInterval(() => {
    if (!onDuty()) { clearInterval(looking); return; }
    settle();
    const s = now();
    if (!s.title) return;
    const t = told;
    const changed = !t || s.title !== t.title || s.artist !== t.artist || s.album !== t.album || s.artwork !== t.artwork || s.link !== t.link
      || s.playing !== t.playing || s.rate !== t.rate || s.ad !== t.ad || s.song !== t.song || s.repeat !== t.repeat || Math.abs(s.duration - t.duration) > 1
      || Math.abs((s.volume ?? -1) - (t.volume ?? -1)) > 0.01;
    const expected = t && t.position != null ? t.position + (t.playing ? ((s.at - t.at) / 1000) * t.rate : 0) : null;
    const jumped = expected != null && s.position != null && Math.abs(s.position - expected) > 1.5;
    if (changed || jumped || (s.playing && s.at - t.at > 10000)) tell(s);
  }, 1000);
})();
