// The user's own lists on a music site — their playlists, and the songs they liked — read inside the site's page, the
// way the page itself reads them: signed in there, nothing more is asked of the user, and nothing leaves this computer
// but for iBaila. And the song playing liked or not, as the page's own heart does. Handed to the page whole
// (chrome.scripting): nothing outside the function is seen there.
//
// ask: { what: 'library' } → { signedIn, lists: [{ id, name, count, artwork, owner }] }
//      { what: 'list', id, limit } → { name, songs: [{ id, title, artist, album, duration, artwork, link }] }
//      { what: 'liked', id? } → { song, liked }; { what: 'like', id?, on } → { song, liked } (no id: the song playing)
// Either way, { error } when the site said no.

export async function pageLists(site, ask) {
  // A question that failed on the way — the site said no, or answered otherwise than read — says why, instead of
  // nothing at all: iBaila's log had only "no answer" for SoundCloud's likes (2026-10-10).
  try { return await answer(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 160) }; }

  async function answer() {
    const limit = Math.min(Number(ask.limit) || 500, 1000);
    // Every object in an answer, with the one it sits in: the sites change the shape of their answers more than
    // the names of what they hold.
    const walk = (value, visit, parent = null) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) walk(item, visit, parent); return; }
      if (visit(value, parent) === false) return;
      for (const key in value) walk(value[key], visit, value);
    };
    const first = (value, key) => { let found; walk(value, (o) => { if (found !== undefined) return false; if (key in o) found = o[key]; }); return found; };
    const text = (runs) => (runs && runs.runs ? runs.runs.map((r) => r.text).join('') : '');
    const seconds = (clock) => String(clock || '').split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
    const cookie = (name, doc = document) => { const m = doc.cookie.match(new RegExp('(?:^|; )' + name.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&') + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
    // What the extension's watch of the page heard (content/main.js): Spotify's and SoundCloud's own keys to their lists.
    const heard = window.__ibailaHeard || {};
    // Heard by the time the page next asks its site anything — at most `ms` from now.
    const hear = (has, ms) => (has() ? Promise.resolve(true) : new Promise((done) => {
      const waiters = (window.__ibailaHeardWaiters = window.__ibailaHeardWaiters || []);
      const check = () => { if (has()) { done(true); return true; } return false; };
      waiters.push(check);
      setTimeout(() => done(has()), ms);
    }));

    // ---- Spotify's Web Player: its own library inside the page, as its own sidebar and heart use it ----
    // The app's root holds its platform, whose registry holds RootlistAPI (the user's playlists), LibraryAPI (the songs
    // liked) and PlaylistAPI (a playlist's songs) — the same in Spotify's desktop app (SpotifyInside.swift). Its
    // questions by fingerprint, below, only when they can't be found: Spotify changes those fingerprints, and its
    // playlists came back none and its liked songs empty (his Chrome, 2026-10-10).
    if (site === 'spotifyWeb') {
      const inside = (() => {
        let platform = window.__ibailaPlatform;
        if (!platform) {
          const root = [...document.querySelectorAll('body *')].find((e) => Object.keys(e).some((k) => k.startsWith('__reactContainer')));
          const stack = root ? [root[Object.keys(root).find((k) => k.startsWith('__reactContainer'))]] : [];
          for (let n = 0; stack.length && n < 50000 && !platform; n++) {
            const f = stack.pop();
            if (!f) continue;
            if (f.memoizedProps && f.memoizedProps.platform && f.memoizedProps.platform.getRegistry) platform = f.memoizedProps.platform;
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
          }
          if (platform) window.__ibailaPlatform = platform;
        }
        if (!platform) return null;
        const api = (name) => { let key = null; platform.getRegistry()._map.forEach((v, k) => { if (k.description === name) key = k; }); return key ? platform.getRegistry().resolve(key) : null; };
        // Signed out, the page is a guest's: its library answers empty, as an empty one would.
        const guest = () => { try { const session = platform.getSession && platform.getSession(); return Boolean(session && session.isAnonymous); } catch (e) { return false; } };
        return { api, guest };
      })();
      // Spotify gives a picture as spotify:image:<id> or, now, as a plain https link: the link passed on as it is
      // (read as an ID, every cover came out empty — Isaac's report, 2026-10-11).
      const picture = (url) => {
        const text = String(url || '');
        if (/^https?:\/\//.test(text)) return text;
        const id = text.split(':')[2];
        return id ? 'https://i.scdn.co/image/' + id : '';
      };
      const fromInside = async () => {
        if (!inside) return null;
        const library = inside.api('LibraryAPI'), rootlist = inside.api('RootlistAPI'), playlists = inside.api('PlaylistAPI');
        if (!library || !rootlist || !playlists) return null;
        if (ask.what === 'library') {
          // A guest's page — not signed in to Spotify in this browser — said so, for iBaila to ask them to sign in: its
          // empty library was taken for one with only Liked Songs in it, and a customer was shown that alone (2026-10-14).
          if (inside.guest()) return { signedIn: false, lists: [] };
          const liked = await library.getTracks({ offset: 0, limit: 1 });
          const lists = [{ id: 'spotify:collection:tracks', name: 'Liked Songs', count: liked.totalLength || null, artwork: '', owner: '' }];
          const each = (items) => { for (const item of items || []) {
            if (item.type === 'playlist') lists.push({ id: item.uri, name: item.name, count: item.totalLength ?? null,
              artwork: picture(item.images && item.images[0] && item.images[0].url), owner: (item.owner && item.owner.name) || '' });
            else if (item.items) each(item.items);
          } };
          each((await rootlist.getContents()).items);
          // Nothing at all: the page hasn't read its library yet — asked by its questions instead, below.
          if (lists.length === 1 && !liked.totalLength) return null;
          return { signedIn: true, lists };
        }
        if (ask.what === 'liked' || ask.what === 'like') {
          let uri = ask.id;
          if (!uri) { const player = inside.api('PlayerAPI'); const state = player && player.getState && player.getState(); uri = state && state.item && state.item.uri; }
          if (!/^spotify:track:\w+$/.test(uri || '')) return { error: 'no song' };
          if (ask.what === 'like') await library[ask.on ? 'add' : 'remove']({ uris: [uri] });
          return { song: uri, liked: Boolean((await library.contains(uri))[0]) };
        }
        const liked = ask.id === 'spotify:collection:tracks';
        let name = liked ? 'Liked Songs' : '';
        if (!liked) { try { name = ((await playlists.getMetadata(ask.id)) || {}).name || ''; } catch (e) { /* the songs all the same */ } }
        const songs = [];
        for (let offset = 0; offset < limit; offset += 100) {
          const page = liked ? await library.getTracks({ offset, limit: 100 }) : await playlists.getContents(ask.id, { offset, limit: 100 });
          for (const t of page.items || []) {
            if (!String(t.uri).startsWith('spotify:track:') || songs.length >= limit) continue;
            const images = (t.album && t.album.images) || [];
            songs.push({ id: t.uri, title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '), album: (t.album && t.album.name) || '',
              duration: ((t.duration && t.duration.milliseconds) || 0) / 1000,
              artwork: picture((images.find((i) => i.label === 'standard') || images[0] || {}).url),
              link: 'https://open.spotify.com/track/' + t.uri.split(':')[2] });
          }
          if ((page.items || []).length < 100) break;
        }
        return { name, songs };
      };
      try { const found = await fromInside(); if (found) return found; } catch (e) { /* by its questions, then */ }
    }

    // ---- Spotify's Web Player: its own questions (GraphQL, by the name and fingerprint of each), with its own key ----
    if (site === 'spotifyWeb') {
      // Its questions take the page's app key along with the user's: waited for until the page asks one of its own.
      await hear(() => heard.spotify && heard.spotify['client-token'], 6000);
      if (!(heard.spotify && heard.spotify.authorization)) return { error: 'not heard yet' };
      const headers = { ...heard.spotify, 'content-type': 'application/json;charset=UTF-8' };
      const ops = (heard.spotifyOps = heard.spotifyOps || {});
      // Each question's fingerprint: as the page last asked it, else from the page's own script, else as last seen.
      const known = {
        libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
        fetchPlaylist: '8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a',
        fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
        addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
        removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
        areEntitiesInLibrary: '134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed',
      };
      const fingerprint = async (name) => {
        if (ops[name]) return ops[name];
        for (const script of document.scripts) {
          if (!/\/web-player\.[0-9a-f]+\.js$/.test(script.src || '')) continue;
          try {
            const source = await (await fetch(script.src)).text();
            for (const m of source.matchAll(/"(\w+)","(?:query|mutation)","([0-9a-f]{64})"/g)) if (!ops[m[1]]) ops[m[1]] = m[2];
          } catch (e) {}
        }
        return ops[name] || known[name];
      };
      const query = async (name, variables) => {
        const body = { variables, operationName: name, extensions: { persistedQuery: { version: 1, sha256Hash: await fingerprint(name) } } };
        const r = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', { method: 'POST', headers, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`${name} ${r.status}`);
        return r.json();
      };
      // The page's own wording of a question, where it asked it: Spotify adds to what each question takes.
      const asked = (name, fallback) => ({ ...fallback, ...((heard.spotifyVars || {})[name] || {}) });
      const picture = (sources) => {
        const list = (sources || []).filter((s) => s && s.url);
        return (list.find((s) => s.width === 300) || list.sort((a, b) => (a.width || 999) - (b.width || 999))[0] || {}).url || '';
      };

      // A song liked, or not: kept in the user's Liked Songs, as the page's own heart does (its questions, 2026-10-10:
      // addToLibrary / removeFromLibrary take libraryItemUris, areEntitiesInLibrary answers "saved"). The song asked
      // for, else the one the page's player plays.
      if (ask.what === 'liked' || ask.what === 'like') {
        const playing = () => {
          let api = window.__ibailaPlayer;
          if (!api) {
            const root = document.querySelector('#main') || document.body;
            let fiber = null;
            for (const el of [root, ...root.querySelectorAll('div')].slice(0, 300)) {
              const key = Object.keys(el).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
              if (key) { fiber = el[key]; break; }
            }
            while (fiber && fiber.return) fiber = fiber.return;
            const stack = fiber ? [fiber] : [];
            for (let n = 0; stack.length && n < 20000 && !api; n++) {
              const f = stack.pop();
              const found = f.memoizedProps && f.memoizedProps.playerAPI;
              if (found && typeof found.play === 'function') api = window.__ibailaPlayer = found;
              if (f.sibling) stack.push(f.sibling);
              if (f.child) stack.push(f.child);
            }
          }
          try { const state = api && api.getState && api.getState(); if (state && state.item && state.item.uri) return state.item.uri; } catch (e) {}
          const link = document.querySelector('[data-testid="now-playing-widget"] a[href*="/track/"]');
          return link ? 'spotify:track:' + link.getAttribute('href').split('/track/')[1].split(/[?/]/)[0] : '';
        };
        const uri = ask.id || playing();
        if (!/^spotify:track:\w+$/.test(uri)) return { error: 'no song' };
        if (ask.what === 'like') {
          const answer = await query(ask.on ? 'addToLibrary' : 'removeFromLibrary',
            ask.on ? { libraryItemUris: [uri], interactionId: null } : { libraryItemUris: [uri] });
          if (answer && answer.errors && answer.errors.length) return { error: String(answer.errors[0].message || 'refused').slice(0, 80) };
          return { song: uri, liked: Boolean(ask.on) };
        }
        const saved = JSON.stringify(await query('areEntitiesInLibrary', { uris: [uri] })).match(/"saved":(true|false)/);
        return saved ? { song: uri, liked: saved[1] === 'true' } : { error: 'no answer' };
      }

      if (ask.what === 'library') {
        const lists = [];
        const met = new Set();
        let signedIn = false;
        for (let offset = 0; offset < limit; offset += 50) {
          const answer = await query('libraryV3', { ...asked('libraryV3', { filters: [], order: null, textFilter: '', features: ['LIKED_SONGS', 'YOUR_EPISODES'], expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: true }), flatten: true, offset, limit: 50 });
          const library = first(answer, 'libraryV3');
          if (!library) break;
          signedIn = true;
          let more = false;
          walk(library, (o, parent) => {
            const data = o.__typename ? o : null;
            if (!data) return;
            const uri = data.uri || (parent && parent._uri) || '';
            const kind = data.__typename;
            if (!(kind === 'Playlist' || kind === 'PseudoPlaylist') || met.has(uri) || !data.name) return;
            if (!/^spotify:(playlist:|collection:tracks|user:[^:]+:collection$)/.test(uri)) return;
            met.add(uri);
            more = true;
            const id = uri.startsWith('spotify:playlist:') ? uri : 'spotify:collection:tracks';
            lists.push({ id, name: data.name, count: data.count ?? (data.content && data.content.totalCount) ?? null,
              artwork: picture(first(data.images, 'sources')), owner: (first(data.ownerV2, 'name') || '') });
            return false;
          });
          const total = library.totalCount ?? 0;
          if (!more || offset + 50 >= total) break;
        }
        if (signedIn && !lists.some((l) => l.id === 'spotify:collection:tracks')) lists.unshift({ id: 'spotify:collection:tracks', name: 'Liked Songs', count: null, artwork: '', owner: '' });
        return { signedIn, lists };
      }

      // A list's songs: a playlist's, or the songs the user liked.
      const liked = ask.id === 'spotify:collection:tracks';
      const songs = [];
      const met = new Set();
      let name = liked ? 'Liked Songs' : '';
      for (let offset = 0; offset < limit; offset += liked ? 50 : 100) {
        const answer = liked
          ? await query('fetchLibraryTracks', { ...asked('fetchLibraryTracks', {}), offset, limit: 50 })
          : await query('fetchPlaylist', { ...asked('fetchPlaylist', { enableWatchFeedEntrypoint: false }), uri: ask.id, offset, limit: 100 });
        const playlist = liked ? null : first(answer, 'playlistV2');
        if (playlist && playlist.name) name = playlist.name;
        let found = 0;
        walk(answer, (o, parent) => {
          if (o.__typename !== 'Track' || !o.name) return;
          const uri = o.uri || (parent && parent._uri) || '';
          if (!uri.startsWith('spotify:track:')) return false;
          found++;
          if (met.has(uri) || songs.length >= limit) return false;
          met.add(uri);
          const album = o.albumOfTrack || {};
          songs.push({ id: uri, title: o.name,
            artist: ((o.artists && o.artists.items) || []).map((a) => a.profile && a.profile.name).filter(Boolean).join(', '),
            album: album.name || '', duration: ((o.trackDuration || o.duration || {}).totalMilliseconds || 0) / 1000,
            artwork: picture(album.coverArt && album.coverArt.sources), link: 'https://open.spotify.com/track/' + uri.split(':')[2] });
          return false;
        });
        if (!found) break;
      }
      return { name, songs };
    }

    // ---- YouTube Music: its own browse requests, signed as the page signs them ----
    if (site === 'youTubeMusic') {
      const cfg = (key) => (window.ytcfg && window.ytcfg.get ? window.ytcfg.get(key) : undefined);
      if (!cfg('INNERTUBE_CONTEXT')) return { error: 'no ytcfg' };
      if (!cfg('LOGGED_IN') && ask.what === 'library') return { signedIn: false, lists: [] };
      const sha1 = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const post = async (path, body, extra = '') => {
        const context = JSON.parse(JSON.stringify(cfg('INNERTUBE_CONTEXT')));
        const delegated = cfg('DELEGATED_SESSION_ID');
        if (delegated) context.user = { ...(context.user || {}), onBehalfOfUser: delegated };
        const headers = { 'content-type': 'application/json', 'x-origin': location.origin,
          'x-goog-authuser': String(cfg('SESSION_INDEX') ?? 0),
          'x-youtube-client-name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 67),
          'x-youtube-client-version': String(cfg('INNERTUBE_CLIENT_VERSION') || '') };
        if (delegated) headers['x-goog-pageid'] = delegated;
        if (cfg('VISITOR_DATA')) headers['x-goog-visitor-id'] = cfg('VISITOR_DATA');
        const sid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
        if (sid) {
          const now = Math.floor(Date.now() / 1000);
          headers.authorization = `SAPISIDHASH ${now}_${await sha1(`${now} ${sid} ${location.origin}`)}`;
        }
        const r = await fetch(`/youtubei/v1/${path}?prettyPrint=false` + extra, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context, ...body }) });
        if (!r.ok) throw new Error(path + ' ' + r.status);
        return r.json();
      };
      const browse = (body, extra = '') => post('browse', body, extra);

      // A song liked, or not, as the page's own thumb does (like/like, like/removelike; "next" tells its likeStatus —
      // measured signed in, 2026-10-10). The song asked for, else the one its player holds.
      if (ask.what === 'liked' || ask.what === 'like') {
        if (!cfg('LOGGED_IN')) return { error: 'signed out' };
        const player = document.getElementById('movie_player');
        const id = ask.id || (player && player.getVideoData ? player.getVideoData().video_id : '') || '';
        if (!id) return { error: 'no song' };
        if (ask.what === 'like') {
          await post(ask.on ? 'like/like' : 'like/removelike', { target: { videoId: id } });
          return { song: id, liked: Boolean(ask.on) };
        }
        const status = JSON.stringify(await post('next', { videoId: id })).match(/"likeStatus":"(\w+)"/);
        return { song: id, liked: Boolean(status && status[1] === 'LIKE') };
      }
      // The next part of a long answer: asked for by the item that ends the rows, else the old way. (A playlist's page
      // holds the old way's token too, for its suggestions: the rows' own comes first, or the list stopped at 100.)
      const onward = async (answer) => {
        const command = first(first(answer, 'continuationItemRenderer'), 'continuationCommand');
        if (command && command.token) return browse({ continuation: command.token });
        const old = first(answer, 'nextContinuationData');
        if (old && old.continuation) return browse({}, `&ctoken=${old.continuation}&continuation=${old.continuation}&type=next`);
        return null;
      };
      const picture = (thumbs) => { const list = (first(thumbs, 'thumbnails') || []); return (list[list.length - 1] || {}).url || ''; };

      if (ask.what === 'library') {
        const lists = [];
        const met = new Set();
        let answer = await browse({ browseId: 'FEmusic_liked_playlists' });
        for (let page = 0; answer && page < 20 && lists.length < limit; page++) {
          walk(answer, (o) => {
            const item = o.musicTwoRowItemRenderer || o.musicResponsiveListItemRenderer;
            if (!item) return;
            const id = (first(item.navigationEndpoint || item, 'browseId') || '');
            // Not "Episodes for later" (VLSE): podcast episodes, not songs.
            if (!id.startsWith('VL') || id === 'VLSE' || met.has(id)) return false;
            met.add(id);
            const title = item.title ? text(item.title) : text(first(item.flexColumns, 'text'));
            const under = item.subtitle ? text(item.subtitle) : '';
            const count = Number((under.match(/(\d[\d.,]*)\s/) || [])[1]?.replace(/[.,]/g, '')) || null;
            lists.push({ id: id.slice(2), name: title, count, artwork: picture(item.thumbnailRenderer || item.thumbnail), owner: under.split(' • ')[1] || '' });
            return false;
          });
          answer = await onward(answer);
        }
        if (!met.has('VLLM')) lists.unshift({ id: 'LM', name: 'Liked Music', count: null, artwork: '', owner: '' });
        return { signedIn: true, lists };
      }

      const songs = [];
      const met = new Set();
      let answer = await browse({ browseId: 'VL' + ask.id });
      const name = text((first(answer, 'musicResponsiveHeaderRenderer') || first(answer, 'musicDetailHeaderRenderer') || {}).title);
      for (let page = 0; answer && page < 30 && songs.length < limit; page++) {
        let found = 0;
        walk(answer, (o) => {
          const row = o.musicResponsiveListItemRenderer;
          if (!row) return;
          found++;
          const video = (row.playlistItemData && row.playlistItemData.videoId) || (first(row.overlay, 'watchEndpoint') || {}).videoId;
          if (!video || met.has(video) || songs.length >= limit) return false;
          met.add(video);
          const column = (i) => (row.flexColumns && row.flexColumns[i] && row.flexColumns[i].musicResponsiveListItemFlexColumnRenderer) || {};
          const by = ((column(1).text || {}).runs || []);
          const artists = by.filter((r) => /ARTIST|USER_CHANNEL/.test(JSON.stringify(r.navigationEndpoint || ''))).map((r) => r.text);
          // A song's length is in its own column, or, for a video, in the column an album's name would be.
          const clock = /^\d{1,2}(:\d{2}){1,2}$/;
          const third = text(column(2).text);
          const length = text(first(row.fixedColumns, 'text')) || (clock.test(third) ? third : '');
          songs.push({ id: video, title: text(column(0).text),
            artist: (artists.length ? artists : by.map((r) => r.text).filter((t) => !/^\s*[•&,]\s*$/.test(t))).join(', '),
            album: clock.test(third) ? '' : third, duration: seconds(length),
            artwork: picture(row.thumbnail), link: `https://music.youtube.com/watch?v=${video}&list=${ask.id}` });
          return false;
        });
        if (!found) break;
        answer = await onward(answer);
      }
      return { name, songs };
    }

    // ---- SoundCloud: its own API, with the page's key and the user's ----
    if (site === 'soundCloud') {
      // SoundCloud's 2025 pages draw inside a frame of their own site: each window of it looked through.
      const windows = [window];
      for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentWindow && frame.contentWindow.document) windows.push(frame.contentWindow); } catch (e) {} }
      const fromPage = () => {
        for (const w of windows) {
          try {
            const used = w.performance.getEntriesByType('resource').map((e) => e.name).reverse().find((u) => /api(-v2)?\.soundcloud\.com/.test(u) && /client_id=/.test(u));
            if (used) return new URL(used).searchParams.get('client_id');
          } catch (e) {}
        }
        return null;
      };
      await hear(() => heard.soundCloudId || fromPage(), 4000);
      const client = heard.soundCloudId || fromPage();
      const token = cookie('oauth_token');
      const key = heard.soundCloudAuth || (token ? 'OAuth ' + token : null);
      if (!client) return { error: 'no client id' };
      // The user's own (their library, their likes) only signed in; a list itself, either way.
      const liking = ask.what === 'liked' || ask.what === 'like';
      const own = ask.what === 'library' || ask.id === 'likes' || liking;
      if (own && !key) return ask.what === 'library' ? { signedIn: false, lists: [] } : { error: 'signed out' };
      const api = async (path, params = {}) => {
        const url = new URL(path.startsWith('http') ? path : 'https://api-v2.soundcloud.com' + path);
        url.searchParams.set('client_id', client);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        const r = await fetch(url, { headers: { accept: 'application/json', ...(key ? { authorization: key } : {}) } });
        if (!r.ok) throw new Error(url.pathname + ' ' + r.status);
        return r.json();
      };
      const picture = (art) => (art || '').replace('-large.', '-t200x200.');
      const me = own ? await api('/me') : null;

      // A song liked, or not, as the page's own heart does (its own paths, 2026-10-10: me/track_likes/ids, and
      // users/:userId/track_likes/:id put or deleted). The song asked for, else the one in the player bar.
      if (liking) {
        let id = ask.id ? String(ask.id) : '';
        if (!id) {
          let href = '';
          for (const w of windows) {
            try { const link = w.document.querySelector('.playbackSoundBadge__titleLink'); if (link) { href = link.getAttribute('href') || ''; break; } } catch (e) {}
          }
          // Its page's address, whole or from the site's root, without what follows it ("?in=" a list).
          const page = href ? new URL(href, 'https://soundcloud.com') : null;
          if (page) { page.search = ''; page.hash = ''; }
          const found = page ? await api('/resolve', { url: page.href }).catch(() => null) : null;
          id = String((found && found.kind === 'track' && found.id) || '');
          // Not found by its page (his Mac, 2026-10-10: "/resolve 404"): the song the player last fetched to play,
          // "soundcloud:tracks:ID" in its address.
          if (!id) {
            for (const w of windows) {
              try {
                const fetched = w.performance.getEntriesByType('resource').map((e) => e.name).reverse().find((u) => /soundcloud(:|%3A)tracks(:|%3A)\d+/.test(u));
                if (fetched) { id = fetched.match(/soundcloud(?::|%3A)tracks(?::|%3A)(\d+)/)[1]; break; }
              } catch (e) {}
            }
          }
          if (!id) return { error: 'no song ' + (page ? page.pathname.slice(0, 60) : 'in the player bar') };
        }
        if (ask.what === 'like') {
          const url = new URL(`https://api-v2.soundcloud.com/users/${me.id}/track_likes/${id}`);
          url.searchParams.set('client_id', client);
          const r = await fetch(url, { method: ask.on ? 'PUT' : 'DELETE', headers: { accept: 'application/json', authorization: key } });
          if (!r.ok && !(!ask.on && r.status === 404)) return { error: 'like ' + r.status };
          return { song: id, liked: Boolean(ask.on) };
        }
        const ids = await api('/me/track_likes/ids', { limit: 5000 });
        return { song: id, liked: (ids.collection || []).map(String).includes(id) };
      }

      if (ask.what === 'library') {
        const lists = [{ id: 'likes', name: 'Likes', count: me.likes_count ?? me.public_favorites_count ?? null, artwork: picture(me.avatar_url), owner: me.username || '' }];
        const met = new Set();
        const add = (p) => {
          if (!p || !p.id || met.has(p.id)) return;
          met.add(p.id);
          lists.push({ id: String(p.id), name: p.title || '', count: p.track_count ?? null,
            artwork: picture(p.artwork_url || p.calculated_artwork_url || (p.tracks && p.tracks[0] && p.tracks[0].artwork_url)),
            owner: (p.user && p.user.username) || '' });
        };
        try {
          let page = await api('/me/library/all', { limit: 50, offset: 0, linked_partitioning: 1 });
          for (let n = 0; page && n < 10 && lists.length < limit; n++) {
            for (const item of page.collection || []) add(item.playlist);
            page = page.next_href ? await api(page.next_href) : null;
          }
        } catch (e) {
          // The older lists: the user's own, and the ones they liked.
          const mine = await api(`/users/${me.id}/playlists_without_albums`, { limit: 200, linked_partitioning: 1 });
          for (const p of mine.collection || []) add(p);
          const likes = await api(`/users/${me.id}/likes`, { limit: 200, linked_partitioning: 1 }).catch(() => ({}));
          for (const like of likes.collection || []) add(like.playlist);
        }
        return { signedIn: true, lists };
      }

      const song = (t, set) => ({ id: String(t.id), title: t.title || '',
        artist: (t.publisher_metadata && t.publisher_metadata.artist) || (t.user && t.user.username) || '',
        album: (t.publisher_metadata && t.publisher_metadata.album_title) || '', duration: (t.full_duration || t.duration || 0) / 1000,
        artwork: picture(t.artwork_url || (t.user && t.user.avatar_url)),
        // Played from the list: the track's page "in" it, so the list carries on after it.
        link: (t.permalink_url || '') + (set ? '?in=' + set : '') });
      if (ask.id === 'likes') {
        const songs = [];
        let page = await api(`/users/${me.id}/track_likes`, { limit: 100, linked_partitioning: 1 });
        while (page && songs.length < limit) {
          for (const like of page.collection || []) if (like.track && songs.length < limit) songs.push(song(like.track, `${me.permalink}/likes`));
          page = page.next_href && songs.length < limit ? await api(page.next_href) : null;
        }
        return { name: 'Likes', songs };
      }
      const playlist = await api(`/playlists/${ask.id}`, { representation: 'full' });
      const set = (playlist.permalink_url || '').replace(/^https?:\/\/[^/]+\//, '');
      const order = (playlist.tracks || []).map((t) => t.id).slice(0, limit);
      const full = new Map((playlist.tracks || []).filter((t) => t.title).map((t) => [t.id, t]));
      const missing = order.filter((id) => !full.has(id));
      for (let i = 0; i < missing.length; i += 50) {
        const batch = await api('/tracks', { ids: missing.slice(i, i + 50).join(',') });
        for (const t of batch || []) full.set(t.id, t);
      }
      return { name: playlist.title || '', songs: order.map((id) => full.get(id)).filter(Boolean).map((t) => song(t, set)) };
    }
    return { error: 'unknown site' };
  }
}
