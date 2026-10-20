// iBaila's browser extension from the player's side (ExtensionSetup.swift): whether it still has to be added, and
// adding it. A browser's music without it is only heard — playing what is picked, the lists, the heart and repeat all
// go through it — so for someone listening in a browser it isn't a choice, and the player asks for it in its middle
// until it's there (his call, 2026-10-10: "optional değil, kurması lazım").
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const ID = 'gigknfcahepjbpbbenehclomobbhnoih';
const local = process.env.LOCALAPPDATA || '';
const roaming = process.env.APPDATA || '';
/** The browsers it goes in, by the extension's name for each: their name, extensions page and profiles. */
const BROWSERS = {
  chrome: { name: 'Chrome', page: 'chrome://extensions', profiles: [path.join(local, 'Google', 'Chrome', 'User Data')] },
  edge: { name: 'Edge', page: 'edge://extensions', profiles: [path.join(local, 'Microsoft', 'Edge', 'User Data')] },
  brave: { name: 'Brave', page: 'brave://extensions', profiles: [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
  opera: { name: 'Opera', page: 'opera://extensions',
    profiles: [path.join(roaming, 'Opera Software', 'Opera Stable'), path.join(roaming, 'Opera Software', 'Opera GX Stable')] },
  vivaldi: { name: 'Vivaldi', page: 'chrome://extensions', profiles: [path.join(local, 'Vivaldi', 'User Data')] },
};
const SITE_NAMES = { youTubeMusic: 'YouTube Music', soundCloud: 'SoundCloud', spotifyWeb: 'Spotify' };

class ExtensionSetup extends EventEmitter {
  /** It's in a browser on this PC: it said hello here once, or a browser's profile lists it. A browser closed is then
   *  only a browser closed, never a reason to ask. */
  known = false;
  /** The profiles have been read, so the player never asks someone who has it for the moment that takes. */
  checked = false;
  /** Its button pressed: the player waits for it. */
  adding = false;
  /** Come after being asked for: the player says so a moment, then lets it go. */
  arrived = false;
  last = '';

  start({ nowPlaying }) {
    const settings = require('./settings');
    const { extension } = require('./extension');
    this.nowPlaying = nowPlaying;
    this.known = Boolean(settings.get().extensionKnown);
    extension.on('links', () => this.heard(extension.browsers()));
    nowPlaying.on('state', () => this.changed());
    if (this.known) { this.checked = true; return; }
    // Added before iBaila kept count (1.6), or in a browser not open now: its profile says so.
    this.listed().then((found) => {
      if (found) this.know();
      this.checked = true;
      this.changed();
    });
  }

  /** The site of a browser the user listens on: the one chosen, else the one playing when nothing is. */
  site() {
    const np = this.nowPlaying;
    if (np.choice) return np.chosenSite;
    return np.track?.source === 'web' && SITE_NAMES[np.webSite] ? np.webSite : null;
  }

  /** The browser it goes to: the computer's own, else the first there is. */
  browser() {
    const { BrowserExtension } = require('./extension');
    const own = BrowserExtension.defaultBrowser();
    if (own && BROWSERS[own]) return own;
    return Object.keys(BROWSERS).find((key) => BROWSERS[key].profiles.some((folder) => fs.existsSync(folder))) || null;
  }

  state() {
    const site = this.site();
    const browser = this.browser();
    return {
      asks: this.arrived || (Boolean(site) && this.checked && !this.known),
      adding: this.adding, arrived: this.arrived,
      site: SITE_NAMES[site] || null,
      browser: BROWSERS[browser]?.name || null,
      page: BROWSERS[browser]?.page || 'chrome://extensions',
    };
  }

  changed() {
    const state = this.state();
    const said = JSON.stringify(state);
    if (said === this.last) return;
    this.last = said;
    this.emit('state', state);
  }

  /** The browsers it's in, as each says hello or goes. */
  heard(browsers) {
    if (!browsers.length) return;
    this.know();
    if (this.adding) {
      this.adding = false;
      this.arrived = true;
      setTimeout(() => { this.arrived = false; this.changed(); }, 2600);
    }
    this.changed();
  }

  /** The folder iBaila keeps for it shown, selected, to be dragged; the browser's extensions page's address ready to
   *  paste. */
  add() {
    const { shell, clipboard } = require('electron');
    const { extension, BrowserExtension } = require('./extension');
    extension.keepCopy();
    shell.showItemInFolder(BrowserExtension.folder);
    const browser = this.browser();
    const page = BROWSERS[browser]?.page || 'chrome://extensions';
    clipboard.writeText(page);
    if (!this.known) {
      this.adding = true;
      this.changed();
    }
    return { folder: BrowserExtension.folder, page };
  }

  know() {
    if (this.known) return;
    this.known = true;
    require('./settings').set({ extensionKnown: true });
    console.log('[extension] known on this PC');
  }

  /** Whether a browser's profile lists it: added by hand, it is written in the profile's preferences. */
  async listed() {
    for (const browser of Object.values(BROWSERS)) {
      for (const root of browser.profiles) {
        let folders = [root];
        try {
          folders = folders.concat((await fs.promises.readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)));
        } catch { continue; }
        for (const folder of folders) {
          for (const name of ['Secure Preferences', 'Preferences']) {
            try {
              if ((await fs.promises.readFile(path.join(folder, name), 'utf8')).includes(ID)) return true;
            } catch { /* no such file */ }
          }
        }
      }
    }
    return false;
  }
}

module.exports = { extensionSetup: new ExtensionSetup() };
