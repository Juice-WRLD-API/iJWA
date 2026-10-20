// What a music site plays next — its own queue, the songs the user lined up and the ones it carries on with — read
// inside its page, and one of them played, as a click on it there would. Handed to the page whole (chrome.scripting):
// nothing outside the function is seen there. His ask, 2026-10-12: a customer wanted the queue beside the player
// instead of going to Spotify to change it.
//
// ask: { what: 'read' } → { songs: [{ id, title, artist, album, duration, artwork, current, queued }] }
//      { what: 'play', id } → { played }
//      { what: 'remove', id } → { done }
//      { what: 'add', song, next } → { done }: `song` the site's own ID for it (a Spotify URI, a YouTube video ID),
//      played next or at the end of what the user lined up
// Either way, { error } when the page couldn't say.

export async function pageQueue(site, ask) {
  try { return await answer(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 160) }; }

  async function answer() {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));

    // ---- Spotify's Web Player: its PlayerAPI, as its own queue page uses it (SpotifyInside.swift does the same in
    // Spotify's app) ----
    if (site === 'spotifyWeb') {
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
      if (!platform) return { error: 'no player' };
      let key = null;
      platform.getRegistry()._map.forEach((v, k) => { if (k.description === 'PlayerAPI') key = k; });
      const player = platform.getRegistry().resolve(key);
      if (ask.what === 'play') {
        const [uri, uid] = String(ask.id || '').split('|');
        await player.skipTo({ uri, uid });
        return { played: true };
      }
      // Changed and answered at once: Spotify shows a change in its queue a second or two later, and iBaila reads it
      // again until it does (PlayQueue.swift) — waited for here, the page's timers in a tab behind are slowed to a
      // crawl.
      if (ask.what === 'remove') {
        const [uri, uid] = String(ask.id || '').split('|');
        await player.removeFromQueue([{ uri, uid }]);
        return { done: true };
      }
      if (ask.what === 'add') {
        if (!/^spotify:track:/.test(ask.song || '')) return { done: false };
        if (ask.next) await player.playAsNextInQueue([{ uri: ask.song }]); else await player.addToQueue([{ uri: ask.song }]);
        return { done: true };
      }
      const queue = await player.getQueue();
      const picture = (images) => {
        const url = ((images || []).find((i) => i.label === 'standard') || (images || [])[0] || {}).url || '';
        if (/^https?:\/\//.test(url)) return url;
        const id = url.split(':')[2];
        return id ? 'https://i.scdn.co/image/' + id : '';
      };
      const song = (t, current, queued) => ({
        id: `${t.uri}|${t.uid || ''}`, title: t.name || '', artist: (t.artists || []).map((a) => a.name).join(', '),
        album: (t.album && t.album.name) || '', duration: ((t.duration && t.duration.milliseconds) || 0) / 1000,
        artwork: picture(t.album && t.album.images), current, queued,
      });
      const songs = [];
      if (queue.current) songs.push(song(queue.current, true, false));
      for (const t of queue.queued || []) songs.push(song(t, false, true));
      for (const t of (queue.nextUp || []).slice(0, 60)) songs.push(song(t, false, false));
      return { songs };
    }

    // ---- YouTube Music: the queue its player keeps in its own store, read and changed there — not in the page
    // drawn from it: in a tab behind, the browser holds back drawing and timers, and a remove that opened the song's
    // menu and waited for it did nothing (his test, 2026-10-12). Playing goes through the song's own link in the
    // queue; removing and adding through its menu's own items, made and pressed unseen, as a click on them would.
    if (site === 'youTubeMusic') {
      const queueElement = document.querySelector('ytmusic-player-queue');
      if (!queueElement || !queueElement.getState) return { error: 'no queue' };
      const state = queueElement.getState().queue || {};
      const renderer = (i) => i && (i.playlistPanelVideoRenderer
        || (i.playlistPanelVideoWrapperRenderer && i.playlistPanelVideoWrapperRenderer.primaryRenderer
          && i.playlistPanelVideoWrapperRenderer.primaryRenderer.playlistPanelVideoRenderer));
      const all = [...(state.items || []), ...(state.automixItems || [])].map(renderer).filter((r) => r && r.videoId);
      const text = (runs) => (runs && runs.runs ? runs.runs.map((r) => r.text).join('') : '');
      // A song's place in the queue is named by YouTube Music's own ID for it, which it may give anew as the queue is
      // fetched again: "not in the queue" for a song plainly there (his test, 2026-10-12). The video is named beside it,
      // and found by it, after the song playing, when the ID no longer is.
      const idOf = (r, n) => `${r.playlistSetVideoId || n}|${r.videoId}`;
      const find = (id) => {
        const exact = all.find((r, n) => idOf(r, n) === id);
        if (exact) return exact;
        const video = String(id || '').split('|')[1];
        const from = Math.max(state.selectedItemIndex || 0, 0);
        return all.find((r, n) => n > from && r.videoId === video) || all.find((r) => r.videoId === video);
      };
      const press = (data) => {
        const item = document.createElement('ytmusic-menu-service-item-renderer');
        item.style.display = 'none';
        queueElement.appendChild(item);
        item.data = data;
        item.click();
        // Kept a moment: what it does may still read it.
        setTimeout(() => item.remove(), 3000);
      };
      const option = (r, icon) => {
        const entries = (r && r.menu && r.menu.menuRenderer && r.menu.menuRenderer.items) || [];
        return entries.map((m) => m.menuServiceItemRenderer).find((o) => o && o.icon && o.icon.iconType === icon);
      };
      if (ask.what === 'play') {
        const r = find(ask.id);
        const app = document.querySelector('ytmusic-app');
        if (!r || !r.navigationEndpoint || !app || !app.resolveCommand) return { played: false };
        app.resolveCommand(r.navigationEndpoint);
        return { played: true };
      }
      if (ask.what === 'remove') {
        const r = find(ask.id);
        const remove = option(r, 'REMOVE');
        if (!remove) {
          const icons = ((r && r.menu && r.menu.menuRenderer && r.menu.menuRenderer.items) || [])
            .map((m) => { const o = m[Object.keys(m)[0]]; return (o && o.icon && o.icon.iconType) || Object.keys(m)[0]; });
          return { done: false, why: r ? `no remove in its menu: ${icons.join(' ')}` : `not in the queue (${all.length} songs)` };
        }
        press(remove);
        return { done: true };
      }
      if (ask.what === 'add') {
        // Any song's "Play next" or "Add to queue", made to name the song asked for.
        const video = String(ask.song || '');
        const add = all.map((r) => option(r, ask.next ? 'QUEUE_PLAY_NEXT' : 'ADD_TO_REMOTE_QUEUE')).find(Boolean);
        if (!/^[\w-]{11}$/.test(video) || !add) return { done: false };
        const data = JSON.parse(JSON.stringify(add));
        const target = data.serviceEndpoint && data.serviceEndpoint.queueAddEndpoint && data.serviceEndpoint.queueAddEndpoint.queueTarget;
        if (!target) return { done: false };
        target.videoId = video;
        if (target.onEmptyQueue && target.onEmptyQueue.watchEndpoint) target.onEmptyQueue.watchEndpoint.videoId = video;
        press(data);
        return { done: true };
      }
      const selected = Math.max(state.selectedItemIndex || 0, 0);
      const songs = all.slice(selected, selected + 61).map((r, n) => {
        const thumbs = (r.thumbnail && r.thumbnail.thumbnails) || [];
        const byline = text(r.shortBylineText) || text(r.longBylineText);
        return {
          id: idOf(r, selected + n), title: text(r.title), artist: byline.split(' • ')[0], album: '',
          duration: text(r.lengthText).split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0),
          artwork: (thumbs[0] || {}).url || '', current: n === 0, queued: false,
        };
      });
      return { songs };
    }

    // ---- SoundCloud: its Next up panel, drawn once opened; opened for a moment if it never was ----
    if (site === 'soundCloud') {
      let rows = [...document.querySelectorAll('.queueItemView')];
      let opened = false;
      if (!rows.length) {
        const toggle = document.querySelector('.playControls__queue button, .playControls__queue');
        if (!toggle) return { error: 'no queue' };
        toggle.click();
        opened = true;
        for (let n = 0; n < 15 && !rows.length; n++) { await wait(100); rows = [...document.querySelectorAll('.queueItemView')]; }
      }
      const link = (row) => row.querySelector('.queueItemView__title a, a.sc-link-primary, a[href]');
      const idOf = (row) => (link(row) && link(row).getAttribute('href')) || '';
      let result;
      if (ask.what === 'add') {
        result = { done: false };
      } else if (ask.what === 'remove') {
        const row = rows.find((r) => idOf(r) === ask.id);
        const button = row && row.querySelector('.queueItemView__remove, .queueItemView__removeButton, button[title*="Remove" i]');
        if (button) button.click();
        result = { done: Boolean(button) };
      } else if (ask.what === 'play') {
        const row = rows.find((r) => idOf(r) === ask.id);
        const button = row && (row.querySelector('.queueItemView__play, .sc-button-play, .playButton, button[title*="Play" i]')
          || row.querySelector('.queueItemView__artwork, .sc-artwork'));
        if (button) button.click();
        result = { played: Boolean(button) };
      } else {
        const playing = rows.findIndex((r) => /\bm-(playing|active)\b/.test(r.className));
        const from = Math.max(playing, 0);
        result = { songs: rows.slice(from, from + 61).map((row, n) => {
          const art = row.querySelector('.sc-artwork span, .image__full, span[style*="background-image"]');
          const style = (art && art.getAttribute('style')) || '';
          return {
            id: idOf(row), title: ((row.querySelector('.queueItemView__title') || link(row) || {}).textContent || '').trim(),
            artist: ((row.querySelector('.queueItemView__username') || {}).textContent || '').trim(), album: '', duration: 0,
            artwork: (style.match(/url\("?([^")]+)"?\)/) || [])[1] || '', current: playing >= 0 && n === 0, queued: false,
          };
        }) };
      }
      // Closed again as it was: nothing left open in the user's page.
      if (opened) { const toggle = document.querySelector('.playControls__queue button, .playControls__queue'); if (toggle) toggle.click(); }
      return result;
    }

    return { error: 'no queue on ' + site };
  }
}
