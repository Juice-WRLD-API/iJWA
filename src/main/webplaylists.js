// The user's own lists on the music site they listen on — their playlists on YouTube Music, SoundCloud or Spotify's
// Web Player, and the songs they liked there — read by iBaila's extension in the site's tab, where they are signed in
// (lists.js), for the playlist (WebPlaylists.swift). Kept on disk for each site, so they show at once; read again when
// the shelf opens, a list is chosen, or the refresh is pressed. Nothing is read while nobody asks.
const fs = require('fs');
const path = require('path');
const { extension } = require('./extension');

/** The songs of this many lists are kept, the chosen one among them. */
const KEPT_LISTS = 8;
const HOMES = { youTubeMusic: 'https://music.youtube.com/', soundCloud: 'https://soundcloud.com/', spotifyWeb: 'https://open.spotify.com/' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WebPlaylists {
  site = null;
  lists = [];          // { id, name, count, artwork, owner }
  current = null;
  songs = [];          // { id, title, artist, album, duration, artwork, link }
  isLoading = false;
  isReading = false;
  signedOut = false;
  unreachable = false;
  kept = { lists: [], chosen: null, songs: {}, order: [] };
  loading = null;
  opened = new Set();  // the sites a tab was opened behind for, this run
  /** Listening in Spotify's app: Spotify's lists are read in the app itself (spotifyinside.js), never in a Web Player
   *  tab (panel.js says). */
  inSpotifyApp = () => false;

  constructor(onChange) {
    this.onChange = onChange;
    const site = require('./settings').get().webPlaylistSite;
    if (site) this.show(site);
  }

  static file(site) { return path.join(require('electron').app.getPath('userData'), 'Web Playlists', `${site}.json`); }

  /** The lists kept for `site`, shown at once. */
  show(site) {
    if (!site || site === this.site) return;
    this.site = site;
    require('./settings').set({ webPlaylistSite: site });
    try { this.kept = { lists: [], chosen: null, songs: {}, order: [], ...JSON.parse(fs.readFileSync(WebPlaylists.file(site), 'utf8')) }; }
    catch { this.kept = { lists: [], chosen: null, songs: {}, order: [] }; }
    this.lists = this.kept.lists;
    this.signedOut = false;
    this.unreachable = false;
    this.current = this.kept.lists.find((l) => l.id === this.kept.chosen) || null;
    this.songs = (this.current && this.kept.songs[this.current.id]) || [];
    this.onChange();
  }

  save(site) {
    const file = WebPlaylists.file(site);
    fs.promises.mkdir(path.dirname(file), { recursive: true }).then(() => fs.promises.writeFile(file, JSON.stringify(this.kept))).catch(() => {});
  }

  /** The tab of the site the extension reads in: the site's own, in the browser listened in, else any that has it. */
  async tab(site) {
    const name = extension.pick();
    if (!name) return null;
    const tab = ((await extension.tabs(name)) || []).find((t) => t.site === site);
    return tab ? { name, tab: tab.id } : null;
  }

  /** With none open, one opened behind the browser's own — never a browser started for it — once a run per site; it is
   *  the site's music tab from then on (his ask, 2026-10-10). */
  async openTab(site) {
    const name = extension.pick();
    if (!name || this.opened.has(site)) return null;
    this.opened.add(site);
    const tab = await extension.open(name, HOMES[site], { behind: true });
    if (tab == null) return null;
    console.log('[lists] opened', site, 'behind, for the lists');
    return { name, tab };
  }

  /** The site's lists read again in its tab. */
  async refresh() {
    const site = this.site;
    if (!site || this.isReading) return;
    this.isReading = true;
    this.onChange();
    try {
      // Listening in Spotify's app: its lists from the app itself — a Web Player tab only when the app's page can't be
      // reached without cutting a song short.
      if (site === 'spotifyWeb' && this.inSpotifyApp()) {
        const lists = await require('./spotifyinside').library();
        if (lists && this.site === site) {
          this.unreachable = false;
          this.signedOut = false;
          this.lists = lists;
          this.kept.lists = lists;
          if (this.current) this.current = lists.find((l) => l.id === this.current.id) || this.current;
          this.save(site);
          return;
        }
      }
      let opened = false;
      let place = await this.tab(site);
      if (!place) { place = await this.openTab(site); opened = Boolean(place); }
      if (!place) { this.unreachable = true; return; }
      this.unreachable = false;
      let found = await extension.library(place.name, place.tab, site);
      // A page just opened: read again as it comes up.
      for (let i = 0; opened && i < 6 && (!found || !found.signedIn); i++) {
        await sleep(2000);
        found = await extension.library(place.name, place.tab, site);
      }
      if (!found || this.site !== site) return;
      this.signedOut = !found.signedIn;
      if (!found.signedIn) return;
      this.lists = found.lists;
      this.kept.lists = found.lists;
      if (this.current) this.current = found.lists.find((l) => l.id === this.current.id) || this.current;
      this.save(site);
      console.log('[lists]', found.lists.length, 'on', site);
    } finally {
      this.isReading = false;
      this.onChange();
    }
  }

  /** A list chosen: the songs kept of it at once, then read again. */
  async choose(list) {
    const site = this.site;
    if (!site) return;
    this.current = list;
    this.kept.chosen = list.id;
    this.songs = this.kept.songs[list.id] || [];
    this.save(site);
    this.onChange();
    await this.load(list, site);
  }

  /** The list shown read again. */
  reload() { if (this.current && this.site) return this.load(this.current, this.site); return null; }

  async load(list, site) {
    this.loading = list.id;
    this.isLoading = true;
    this.onChange();
    try {
      let found = null;
      if (site === 'spotifyWeb' && this.inSpotifyApp()) {
        const songs = await require('./spotifyinside').songs(list.id);
        if (songs) found = { songs };
      }
      if (!found) {
        let opened = false;
        let place = await this.tab(site);
        if (!place) { place = await this.openTab(site); opened = Boolean(place); }
        if (!place) { this.unreachable = true; return; }
        this.unreachable = false;
        found = await extension.list(place.name, place.tab, site, list.id);
        // A page just opened: read again as it comes up.
        for (let i = 0; opened && i < 6 && !found; i++) {
          await sleep(2000);
          found = await extension.list(place.name, place.tab, site, list.id);
        }
      }
      if (!found || this.site !== site) return;
      this.kept.songs[list.id] = found.songs;
      this.kept.order = [list.id, ...this.kept.order.filter((id) => id !== list.id)];
      for (const old of this.kept.order.slice(KEPT_LISTS)) if (old !== this.kept.chosen) delete this.kept.songs[old];
      this.kept.order = this.kept.order.slice(0, KEPT_LISTS);
      this.save(site);
      if (this.current?.id === list.id) this.songs = found.songs;
      console.log('[lists]', found.songs.length, 'songs in', list.name, 'on', site);
    } finally {
      if (this.loading === list.id) this.loading = null;
      this.isLoading = this.loading != null;
      this.onChange();
    }
  }
}

module.exports = { WebPlaylists };
