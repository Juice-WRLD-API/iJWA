// "Play Next" and "Add to Queue" for a song found in search: lined up wherever the song playing plays (QueueMenu.swift,
// playqueue.js). His ask, 2026-10-12: "bir şarkı aradım, onu sıraya koyacağım".
const { Menu } = require('electron');
const { popup } = require('./drag');
const { NOTICES } = require('./playqueue');

/** The menu for a song of search's results, over `window`; `notify` shows the word on whether it went in. */
function show(item, { queue, window, notify }) {
  if (item?.kind !== 'song') return;
  // Its ID says where it was found: YouTube Music ("yt:v:…"), else Apple's catalog, found by name where it plays.
  const id = String(item.id || '');
  const song = { title: item.title || '', artist: item.artist || '', album: item.album || '',
    youTubeID: id.startsWith('yt:v:') ? id.slice(5) : null };
  const lineUp = async (next) => {
    const done = await queue.add(song, next);
    notify(done ? NOTICES.queued(next) : NOTICES.notQueued);
  };
  const entries = queue.canAdd
    ? [{ label: 'Play Next', click: () => lineUp(true) }, { label: 'Add to Queue', click: () => lineUp(false) }]
    : [{ label: 'Songs can’t be lined up where this one plays', enabled: false }];
  const menu = Menu.buildFromTemplate(entries);
  if (!window || window.isDestroyed()) return;
  // Search's bar open holds the keys: the menu leaves it so, rather than taking them away as it closes (drag.popup), so
  // the next song can be typed straight after.
  if (window.isFocusable()) menu.popup({ window });
  else popup(menu, window);
}

module.exports = { show };
