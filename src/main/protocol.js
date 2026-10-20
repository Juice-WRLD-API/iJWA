// The app's pages are served from ibaila://app/, not from file://: module scripts and audio worklets need a real
// origin. Saved song artwork is served from ibaila://app/artwork/ and covers from the web from ibaila://app/cover/,
// the same origin, so pages can read their colors; the wallpaper's frost is ibaila://app/frost.jpg.
const { protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { serveFile } = require('./files');
const { pathToFileURL } = require('url');
const artwork = require('./artwork');
const covers = require('./covers');
const wallpaper = require('./wallpaper');

const root = path.join(__dirname, '..');

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'ibaila', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

function handle() {
  protocol.handle('ibaila', (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/artwork/')) {
      return net.fetch(pathToFileURL(artwork.file(decodeURIComponent(url.pathname.slice('/artwork/'.length)))).toString());
    }
    if (url.pathname.startsWith('/cover/')) return covers.serve(decodeURIComponent(url.pathname.slice('/cover/'.length)));
    if (url.pathname === '/frost.jpg') return wallpaper.serve();
    if (url.pathname === '/wallpaper.jpg') return wallpaper.serveFull();
    // Videos are read in pieces as they play: each request says which bytes it wants.
    if (url.pathname.startsWith('/clip/')) return serveFile(path.join(require('./clips').folder(), path.basename(decodeURIComponent(url.pathname.slice(6)))), request);
    // The user's own songs, from the folders they made playlists, and nowhere else.
    if (url.pathname.startsWith('/song/')) {
      const song = decodeURIComponent(url.pathname.slice('/song/'.length));
      return require('./main-state').folders?.knows(song) ? serveFile(song, request) : new Response('Not found', { status: 404 });
    }
    if (url.pathname.startsWith('/desktop-video/')) {
      const folder = require('./livewallpaper').videoFolder();
      const file = path.normalize(path.join(folder, decodeURIComponent(url.pathname.slice('/desktop-video/'.length))));
      return file.startsWith(folder) ? serveFile(file, request) : new Response('Not found', { status: 404 });
    }
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

module.exports = { registerScheme, handle };
