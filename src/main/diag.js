// The test machine's hooks: it writes a step into diag.txt beside the settings — a window's state, a pick played on the
// web or in Apple Music, a place chosen, the list's state — and iBaila does it and says so in its log. Installed only
// where that file is already there (main.js), so never on a user's PC.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');

function install(desktop) {
  app.on('accessibility-support-changed', (_e, on) => console.log('[probe] accessibility', on ? 'on' : 'off'));
  const file = path.join(app.getPath('userData'), 'diag.txt');
  // Every picture a player hands Windows, kept as it came, to see what a browser sends before the page's own cover.
  const pictures = path.join(app.getPath('userData'), 'pictures');
  fs.mkdirSync(pictures, { recursive: true });
  global.ibailaKeepPicture = (track, bytes) => {
    try { fs.writeFileSync(path.join(pictures, `${Date.now()}-${String(track.title).replace(/[^\w]+/g, '_').slice(0, 30)}.img`), bytes); } catch { /* full */ }
  };
  let last = '';
  fs.watchFile(file, { interval: 700 }, async () => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8').trim(); } catch { return; }
    if (!text || text === last) return;
    last = text;
    const step = text.split(/\s+/)[0];
    const win = desktop.window;
    console.log('[probe] step', step);
    try {
      if (step === 'state') {
        console.log('[probe] accessibility now', app.isAccessibilitySupportEnabled(), '| cursor', JSON.stringify(screen.getCursorScreenPoint()));
        for (const w of BrowserWindow.getAllWindows()) {
          const wc = w.webContents;
          console.log('[probe] window', w.id, wc.getURL().replace('ibaila://app/', ''), JSON.stringify(w.getBounds()), 'visible', w.isVisible(),
            'focusable', w.isFocusable(), 'enabled', w.isEnabled(), 'focused', w.isFocused(), 'top', w.isAlwaysOnTop(), 'crashed', wc.isCrashed(),
            'pid', wc.getOSProcessId());
        }
        if (win && !win.isDestroyed()) {
          console.log('[probe] page', await win.webContents.executeJavaScript(`JSON.stringify({ body: getComputedStyle(document.body).pointerEvents,
            player: getComputedStyle(document.getElementById('player')).pointerEvents, hidden: document.hidden, focus: document.hasFocus(),
            at: document.elementFromPoint(20, 20)?.id || document.elementFromPoint(20, 20)?.className || null })`));
        }
      } else if (step === 'memory') {
        // Each process's memory (private, as Task Manager counts it) with the windows it draws.
        const pages = new Map();
        for (const w of BrowserWindow.getAllWindows()) {
          const pid = w.webContents.getOSProcessId();
          pages.set(pid, [...(pages.get(pid) || []), w.webContents.getURL().replace('ibaila://app/', '')]);
        }
        let total = 0;
        for (const m of app.getAppMetrics()) {
          const mb = (m.memory.privateBytes || m.memory.workingSetSize) / 1024;
          total += mb;
          console.log('[probe] memory', m.type, m.pid, `${mb.toFixed(1)} MB`, `cpu ${m.cpu.percentCPUUsage.toFixed(1)}%`, (pages.get(m.pid) || []).join(' + '));
        }
        console.log('[probe] memory total', `${total.toFixed(1)} MB`);
      } else if (step === 'mainmem') {
        // The main process: its memory, and the code it has loaded (packages by size on disk).
        const used = process.memoryUsage();
        const mb = (v) => `${(v / 1048576).toFixed(1)} MB`;
        console.log('[probe] mainmem rss', mb(used.rss), 'heap', mb(used.heapUsed), '/', mb(used.heapTotal), 'external', mb(used.external), 'buffers', mb(used.arrayBuffers));
        const packages = new Map();
        for (const file of Object.keys(require.cache)) {
          const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(file);
          const name = m ? m[1] : 'app:' + path.basename(file);
          let size = 0; try { size = fs.statSync(file).size; } catch { /* gone */ }
          packages.set(name, (packages.get(name) || 0) + size);
        }
        console.log('[probe] mainmem modules', [...packages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n, v]) => `${n} ${(v / 1024).toFixed(0)}K`).join(', '));
      } else if (step === 'gc') {
        // A full collection in every page (the debugger's own, V8's and Blink's heaps alike), to tell garbage from
        // what is really held.
        for (const w of BrowserWindow.getAllWindows()) {
          const wc = w.webContents;
          try {
            if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
            await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
            wc.debugger.detach();
            console.log('[probe] gc', wc.getURL().replace('ibaila://app/', ''));
          } catch (error) { console.log('[probe] gc failed', error.message); }
        }
      } else if (step === 'memdump') {
        // Chromium's own memory dump (memory-infra): what each process holds, by allocator — v8, blink, the
        // compositor's tiles, skia, images, fonts — written beside the settings as memdump.json.
        const { contentTracing } = require('electron');
        await contentTracing.startRecording({ included_categories: ['disabled-by-default-memory-infra'], excluded_categories: ['*'],
          memory_dump_config: { triggers: [{ mode: 'detailed', periodic_interval_ms: 1500 }] } });
        await new Promise((r) => setTimeout(r, 3500));
        const out = await contentTracing.stopRecording(path.join(app.getPath('userData'), 'memdump.json'));
        console.log('[probe] memdump', out);
      } else if (step === 'heap') {
        // What each page holds: its script heap, its elements, the pictures it decoded and its canvases.
        for (const w of BrowserWindow.getAllWindows()) {
          const page = await w.webContents.executeJavaScript(`JSON.stringify({
            heap: Math.round(performance.memory.usedJSHeapSize / 1048576) + '/' + Math.round(performance.memory.totalJSHeapSize / 1048576) + ' MB',
            nodes: document.getElementsByTagName('*').length,
            images: [...document.images].filter((i) => i.naturalWidth).map((i) => i.naturalWidth + 'x' + i.naturalHeight),
            backgrounds: [...document.querySelectorAll('*')].map((e) => getComputedStyle(e).backgroundImage).filter((b) => b && b !== 'none').map((b) => b.slice(0, 60)),
            canvases: [...document.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height),
            videos: [...document.querySelectorAll('video')].map((v) => v.videoWidth + 'x' + v.videoHeight + (v.paused ? ' paused' : ' playing')),
            filters: [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return s.backdropFilter !== 'none' || s.filter !== 'none'; }).length,
          })`).catch((e) => e.message);
          console.log('[probe] heap', w.webContents.getURL().replace('ibaila://app/', ''), page);
        }
      } else if (step === 'eval') {
        // eval <part of the page's address> <script…> <nonce>: the script run in that page, its answer logged.
        const words = text.split(/\s+/);
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(words[1]));
        console.log('[probe] eval', words[1], win ? await win.webContents.executeJavaScript(words.slice(2, -1).join(' '), true).catch((e) => `threw ${e.message}`) : 'no such page');
      } else if (step === 'click') {
        // click <part of the page's address> <x> <y> [right] <nonce>: a press there in the page, as a hand makes it.
        const words = text.split(/\s+/);
        const page = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(words[1]));
        const x = Math.round(Number(words[2])), y = Math.round(Number(words[3])), button = words[4] === 'right' ? 'right' : 'left';
        if (!page) console.log('[probe] click: no such page');
        else {
          page.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          await new Promise((r) => setTimeout(r, 120));
          page.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
          await new Promise((r) => setTimeout(r, 90));
          page.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
          console.log('[probe] clicked', words[1], x, y, button);
        }
      } else if (step === 'seek') {
        // seek <fraction> <nonce>: as the bar's slider does; then where the player says it is.
        const np = desktop.nowPlaying;
        const say = () => { const s = np.snapshot(); return `${s.track?.title} ${s.playing ? "playing" : "paused"} clock ${JSON.stringify(s.clock)} of ${Math.round(s.track?.duration || 0)} s, can ${JSON.stringify(s.can)}`; };
        console.log('[probe] before seek', say());
        np.seek(Number(text.split(/\s+/)[1]));
        await new Promise((r) => setTimeout(r, 3000));
        console.log('[probe] after seek', say());
      } else if (step === 'dragtest') {
        // The player moved 300 times the old way (its position only) and the new way (drag.js: the position with the
        // size it started with); its size before and after each.
        const w = desktop.window;
        const start = w.getBounds();
        for (let i = 0; i < 300; i++) { const [x, y] = w.getPosition(); w.setPosition(x + (i % 2 ? 3 : -3), y + (i % 2 ? 2 : -2)); }
        const oldWay = w.getBounds();
        w.setBounds(start);
        const [width, height] = w.getSize();
        for (let i = 0; i < 300; i++) { const [x, y] = w.getPosition(); w.setBounds({ x: x + (i % 2 ? 3 : -3), y: y + (i % 2 ? 2 : -2), width, height }); }
        const newWay = w.getBounds();
        w.setBounds(start);
        console.log('[probe] drag test, scale', screen.getPrimaryDisplay().scaleFactor, '| start', JSON.stringify(start), '| old way', JSON.stringify(oldWay), '| new way', JSON.stringify(newWay));
      } else if (step === 'sizetest') {
        // The player's size changed 20 times, as a slider dragged back and forth does, and set back: where it stands
        // before and after.
        const settings = require('./settings');
        const size = settings.get().desktop.size;
        const before = win.getBounds();
        for (let i = 0; i < 20; i++) { settings.set({ desktop: { size: i % 2 ? 0.9 : 0.1 } }); desktop.apply(); await new Promise((r) => setTimeout(r, 60)); }
        settings.set({ desktop: { size } }); desktop.apply();
        await new Promise((r) => setTimeout(r, 300));
        console.log('[probe] size test, scale', screen.getPrimaryDisplay().scaleFactor, '| before', JSON.stringify(before), '| after', JSON.stringify(win.getBounds()));
      } else if (step === 'placetest') {
        // placetest <section.key> <page> <nonce>: a slider of that part moved 20 times and set back, as the settings do
        // it; where the part's window stands before and after.
        const settings = require('./settings');
        const { ipcMain } = require('electron');
        const [section, key] = text.split(/\s+/)[1].split('.');
        const part = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(text.split(/\s+/)[2]));
        const was = settings.get()[section][key];
        const before = part().getBounds();
        for (let i = 0; i < 20; i++) { ipcMain.emit('set-style', {}, { [section]: { [key]: i % 2 ? 0.95 : 0.05 } }); await new Promise((r) => setTimeout(r, 120)); }
        ipcMain.emit('set-style', {}, { [section]: { [key]: was } });
        await new Promise((r) => setTimeout(r, 800));
        console.log('[probe] place test', section + '.' + key, 'scale', screen.getPrimaryDisplay().scaleFactor, '| before', JSON.stringify(before), '| after', JSON.stringify(part().getBounds()));
      } else if (step === 'watchsize') {
        // watchsize <nonce>: the player's size slider dragged back and forth for 3 s, then the player watched for 4 s:
        // its window, and its cards' size as the page draws them, every 400 ms.
        const { ipcMain } = require('electron');
        const page = desktop.window;
        const look = async () => `${JSON.stringify(page.getBounds())} ${await page.webContents.executeJavaScript(
          "(() => { const c = document.querySelector('.card, .ring-card, [class*=card]'); const r = c && c.getBoundingClientRect(); return (r ? Math.round(r.width) + 'x' + Math.round(r.height) : 'no card') + ' s=' + getComputedStyle(document.documentElement).getPropertyValue('--s').trim(); })()").catch((e) => e.message)}`;
        for (let i = 0; i < 180; i++) { ipcMain.emit('set-style', {}, { desktop: { size: 0.45 + 0.4 * Math.sin(i / 6) } }); await new Promise((r) => setTimeout(r, 16)); }
        for (let i = 0; i < 10; i++) { console.log('[probe] after the slider', i * 400, 'ms:', await look()); await new Promise((r) => setTimeout(r, 400)); }
      } else if (step === 'now') {
        // What iBaila follows now, and the choice.
        const np = desktop.nowPlaying;
        console.log('[probe] now', JSON.stringify({ choice: np.choice, track: np.track && { title: np.track.title, source: np.track.source, site: np.track.site }, playing: np.playing }));
      } else if (step === 'trace') {
        // trace <seconds> <nonce>: every reading of the player for that long — whether it plays, where Windows says it
        // stands — beside where iBaila's own clock says the song is.
        const t0 = Date.now();
        global.ibailaTrace = (data, np) => {
          const t = ((Date.now() - t0) / 1000).toFixed(1);
          if (data.title) console.log('[probe] trace', t, 's | reads', data.playing ? 'playing' : 'paused', 'at', data.position, '| clock', np.clock ? np.clockSeconds(Date.now() / 1000).toFixed(1) : '-', np.clock?.running ? 'running' : 'stopped');
        };
        setTimeout(() => { global.ibailaTrace = null; }, Number(text.split(/\s+/)[1] || 20) * 1000);
      } else if (step === 'press-play') {
        // The bar's Play pressed, as the page sends it.
        require('electron').ipcMain.emit('desk-control', {}, 'toggle');
        console.log('[probe] play pressed, held', desktop.nowPlaying.held, 'playing', desktop.nowPlaying.playing);
      } else if (step === 'frost') {
        // The frost's color in its middle, as the pages get it.
        const page = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('desktop.html'));
        console.log('[probe] frost', await page.webContents.executeJavaScript(`(async () => { const r = await fetch('ibaila://app/frost.jpg'); if (!r.ok) return 'none ' + r.status;
          const b = await createImageBitmap(await r.blob()); const c = new OffscreenCanvas(8, 8); const g = c.getContext('2d'); g.drawImage(b, 0, 0, 8, 8);
          return b.width + 'x' + b.height + ' rgb ' + [...g.getImageData(4, 4, 1, 1).data].slice(0, 3).join(','); })()`).catch((e) => e.message));
      } else if (step === 'slidertest') {
        // slidertest <key> <nonce>: a slider dragged for two seconds (a change every 16 ms), as the settings send it;
        // meanwhile the desktop's pages are asked something every 50 ms, and how long the slowest answer took is the
        // freeze the user would feel.
        const { ipcMain } = require('electron');
        const key = text.split(/\s+/)[1] || 'sensitivity';
        const page = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('desktop.html'));
        let slowest = 0, asked = 0, running = true;
        const ping = async () => {
          while (running) {
            const t = Date.now();
            await page.webContents.executeJavaScript('1');
            slowest = Math.max(slowest, Date.now() - t); asked++;
            await new Promise((r) => setTimeout(r, 50));
          }
        };
        const pinging = ping();
        for (let i = 0; i < 125; i++) {
          const value = 0.5 + 0.45 * Math.sin(i / 8);
          const patch = key.includes('.') ? { [key.split('.')[0]]: { [key.split('.')[1]]: value } } : { [key]: value };
          ipcMain.emit('set-style', {}, patch);
          await new Promise((r) => setTimeout(r, 16));
        }
        await new Promise((r) => setTimeout(r, 600));
        running = false; await pinging;
        console.log('[probe] slider test', key, '| slowest answer', slowest, 'ms of', asked);
      } else if (step === 'queue') {
        // queue read | play <i> | remove <i> | add <title> | <artist> | <next|last> <nonce>: the Queue, as the panel uses it.
        const words = text.split(/\s+/).slice(1, -1);
        const queue = desktop.nowPlaying.queue;
        const list = () => queue.songs.map((s, i) => `${i}${s.isCurrent ? '*' : ''}${s.isQueued ? '+' : ''} ${s.title}`).join(' | ');
        if (words[0] === 'panel') { require('./main-state').panel.chooseQueue(); console.log('[probe] queue panel shown'); }
        else if (words[0] === 'read') { queue.refresh(true); await new Promise((r) => setTimeout(r, 4000)); console.log('[probe] queue', queue.note, '::', list()); }
        else if (words[0] === 'play') console.log('[probe] queue play', await queue.play(Number(words[1])));
        else if (words[0] === 'remove') console.log('[probe] queue remove', words[1], queue.canRemove(Number(words[1])), await queue.remove(Number(words[1])), '::', list());
        else if (words[0] === 'add') {
          const [title, artist, where] = words.slice(1).join(' ').split('|').map((x) => x.trim());
          console.log('[probe] queue add', title, 'can', queue.canAdd, await queue.add({ title, artist, album: '' }, where === 'next'), '::', list());
        }
      } else if (step === 'pause') {
        desktop.nowPlaying.send('pause');
      } else if (step === 'web-tabs') {
        console.log('[probe] tabs', JSON.stringify(await require('./browser').tabs()));
      } else if (step === 'web-play') {
        // web-play <link> <title…> <nonce>: a song played on the web the way a pick from search plays it.
        const words = text.split(/\s+/);
        console.log('[probe] web play', await desktop.nowPlaying.web.play({ kind: 'song', link: words[1], title: words.slice(2, -1).join(' ') || 'song', artist: '' }));
      } else if (step === 'apple') {
        // apple <kind> <artist words…> | <title words…> <nonce>: a pick played in Apple Music.
        const [left, right] = text.slice(6).split('|');
        const words = left.trim().split(/\s+/);
        console.log('[probe] apple', await require('./players').playInAppleMusic(words[0], right.trim().split(/\s+/).slice(0, -1).join(' '), words.slice(1).join(' ')));
      } else if (step === 'spotify') {
        // spotify <kind> <artist words…> | <title words…> <nonce>: a pick played in Spotify's app, found by its search.
        const [left, right] = text.slice(8).split('|');
        const words = left.trim().split(/\s+/);
        console.log('[probe] spotify', await require('./players').playInSpotify(words[0], right.trim().split(/\s+/).slice(0, -1).join(' '), words.slice(1).join(' ')));
      } else if (step === 'spotify-find') {
        // spotify-find <kind> <artist words…> | <title words…> <nonce>: Spotify's own search, inside its page — nothing played.
        const [left, right] = text.slice(13).split('|');
        const words = left.trim().split(/\s+/);
        const inside = require('./spotifyinside');
        const started = Date.now();
        console.log('[probe] spotify ready', await inside.ready(), `${Date.now() - started} ms`);
        console.log('[probe] spotify search', await inside.search(words[0], right.trim().split(/\s+/).slice(0, -1).join(' '), words.slice(1).join(' ')));
      } else if (step === 'spotify-lists') {
        // spotify-lists <nonce>: the user's lists read inside Spotify's app, and the first playlist's songs — nothing played.
        const inside = require('./spotifyinside');
        const lists = await inside.library();
        console.log('[probe] spotify lists', lists ? lists.length : 'none', JSON.stringify((lists || []).slice(0, 4)));
        const one = (lists || [])[1];
        const songs = one ? await inside.songs(one.id) : null;
        console.log('[probe] spotify songs', one ? one.name : '-', songs ? songs.length : 'none', JSON.stringify((songs || []).slice(0, 2)));
      } else if (step === 'web-lists') {
        // web-lists <site> <nonce>: the user's lists read by the extension in the site's tab — nothing played.
        const { extension } = require('./extension');
        const site = text.split(/\s+/)[1];
        const name = extension.pick();
        const tab = ((name && await extension.tabs(name)) || []).find((t) => t.site === site);
        console.log('[probe] web lists in', name, tab ? tab.id : 'no tab');
        if (tab) {
          const found = await extension.ask(name, { do: 'library', tab: tab.id, site }, 20000);
          console.log('[probe] web lists', JSON.stringify(found).slice(0, 1500));
        }
      } else if (step === 'panel-list') {
        // panel-list <n> <nonce>: the user's n-th list on the web chosen for the playlist beside the player — nothing played.
        const panel = require('./main-state').panel;
        if (panel.listSite) { panel.lists.show(panel.listSite); await Promise.race([panel.lists.refresh(), new Promise((r) => setTimeout(r, 8000))]); }
        const lists = panel.lists.lists;
        const list = lists[Number(text.split(/\s+/)[1]) || 0];
        console.log('[probe] lists', lists.length, list ? list.name : 'none');
        if (list) panel.pickFromShelf(`web:${list.id}`);
      } else if (step === 'choose') {
        // choose <place|auto> <nonce>: where the user listens, as the source menu sets it.
        const choice = text.split(/\s+/)[1];
        require('./settings').set({ listenChoice: choice === 'auto' ? null : choice });
        desktop.nowPlaying.choiceChanged();
        console.log('[probe] chose', choice);
      } else if (step === 'panel') {
        const panel = require('./main-state').panel;
        const m = panel?.model();
        console.log('[probe] panel', m ? `${m.title} | ${m.subtitle} | ${m.songs.length} songs: ${m.songs.slice(0, 6).map((s) => `${s.title} — ${s.artist}`).join(' / ')}` : 'none');
      } else if (step === 'web-press') {
        await require('./browser').press(text.split(/\s+/)[1] || 'soundCloud', 'play');
      } else if (!win || win.isDestroyed()) {
        console.log('[probe] no player window');
      } else if (step === 'synthetic') {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
      } else if (step === 'a11y-off') {
        app.setAccessibilitySupportEnabled(false);
      } else if (step === 'ignore-off') {
        win.setIgnoreMouseEvents(false);
      } else if (step === 'refocus') {
        win.setFocusable(true); win.setFocusable(false);
      } else if (step === 'reshow') {
        win.hide(); win.showInactive();
      } else if (step === 'recreate') {
        desktop.hide(); desktop.apply();
      }
    } catch (error) { console.log('[probe] step failed', error.message); }
  });
}

module.exports = { install };
