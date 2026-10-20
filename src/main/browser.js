// The music pages in the user's browser (WebMusic.swift's browser half): which site a browser's song plays on, read
// from its tabs' titles; a page opened in a new tab kept behind, the one it replaces closed; a page's own buttons
// pressed. web-agent.ps1 does it, a helper started the first time a browser plays, and kept.
const { Agent } = require('./players');
const { simple, whole } = require('./names');

const agent = new Agent('web-agent.ps1');
const isWindows = process.platform === 'win32';

/** A tab's site by its title (web-agent.ps1's SiteOf): YouTube Music's, SoundCloud's — "▶ Song by Someone" while it
 *  plays — or YouTube's. */
function siteOfTitle(title) {
  const text = String(title || '');
  if (/YouTube Music/.test(text)) return 'youTubeMusic';
  if (/SoundCloud/.test(text) || /^\s*[▶►]/.test(text)) return 'soundCloud';
  if (/[-–] YouTube\b/.test(text)) return 'youTube';
  if (/Spotify\s*[-–]\s*Web Player/i.test(text)) return 'spotifyWeb';
  return null;
}
const isMusic = (site) => site === 'youTubeMusic' || site === 'soundCloud' || site === 'spotifyWeb';

let read = { at: 0, tabs: null, pending: null };

/** Every browser tab's title, read at most every second and a half. */
async function tabs() {
  if (!isWindows) return [];
  if (read.tabs && Date.now() - read.at < 1500) return read.tabs;
  if (read.pending) return read.pending;
  // No answer in time (the agent busy working a page): nothing is known, not "no tabs".
  read.pending = agent.ask({ do: 'tabs' }, 6000).then((answer) => {
    read = answer ? { at: Date.now(), tabs: answer.tabs || [], pending: null } : { at: 0, tabs: null, pending: null };
    return read.tabs;
  });
  return read.pending;
}

/** The site a browser's song plays on: the tab whose title names it; with none naming it, a site chosen counts only
 *  when no other music site is open beside it — taking another site's song for it is worse than missing one — and
 *  with none chosen, YouTube Music's tab, else SoundCloud's. `named`: a tab said so. */
async function musicSite(title, only, artist = '') {
  const list = await tabs();
  if (!list) return { site: null, named: false, unknown: true };
  const wanted = simple(title);
  const tab = wanted ? list.find((t) => whole(t.title).includes(wanted)) : null;
  // SoundCloud names its tab after the track playing, "Song by Someone", and nothing else; Spotify's web player,
  // "Song • Someone".
  const soundCloud = (text) => artist && whole(text).includes(whole(`${title} by ${artist}`));
  const spotify = (text) => artist && String(text).includes(' \u2022 ') && whole(text).includes(whole(`${title} ${artist}`));
  if (tab) return { site: siteOfTitle(tab.title) || (soundCloud(tab.title) ? 'soundCloud' : spotify(tab.title) ? 'spotifyWeb' : null), named: true };
  const sites = list.map((t) => siteOfTitle(t.title)).filter(Boolean);
  if (only) {
    const open = new Set(sites.filter((s) => isMusic(s) || s === only));
    return { site: open.size === 1 && open.has(only) ? only : null, named: false };
  }
  return { site: sites.find((s) => s === 'youTubeMusic') || sites.find(isMusic) || null, named: false };
}

/** Opens a page in a new tab of the browser (`app`, Windows' name for it: "msedge", "chrome"), kept behind; the site's
 *  tab it replaces — the one playing `playing`, else the one shown — closes. */
async function open(url, { site, app, playing, title } = {}) {
  if (!isWindows) { console.log('[web] would open', url); return { pressed: '' }; }
  // SoundCloud's page doesn't start by itself: its Play is pressed while the browser is shown for the new tab.
  const press = site === 'soundCloud' ? 'play' : '';
  const answer = await agent.ask({ do: 'open', url, site: site || '', app: browserName(app), playing: playing || '', press, title: title || '' }, 45000);
  read.at = 0;
  console.log('[web] open', url, answer?.ok ? `(in ${answer.opened}${answer.replaced ? ` “${answer.replaced}”` : ''}${answer.closed ? ', closed it' : ''}${answer.pressed ? `, pressed ${answer.pressed}` : press ? ', Play not found' : ''}; was ${answer.state}; tabs ${answer.tabs})` : answer?.error || 'no answer');
  return answer?.ok ? { pressed: answer.pressed || '' } : null;
}

/** Presses the site's own button in its tab: 'play' (a page that doesn't start by itself), 'next', 'previous'. */
async function press(site, what) {
  if (!isWindows) return false;
  const answer = await agent.ask({ do: 'press', site, what }, 10000);
  console.log('[web] press', site, what, answer?.ok ? `${answer.pressed} on “${answer.page}”` : answer?.error || 'no answer', answer?.seen ? `(saw ${answer.seen})` : '');
  return Boolean(answer?.ok);
}

/** The window of the browser `app` showing the tab `title`, minimized or covered, shown unseen for `ms` and put back:
 *  a page in it that never played loads its song (web-agent.ps1 LetLoad). */
async function letLoad(app, title, ms) {
  if (!isWindows) return false;
  const answer = await agent.ask({ do: 'letload', app: browserName(app), title: title || '', ms }, ms + 8000);
  console.log('[web] let load in', app, answer?.ok ? (answer.shown ? `(shown unseen ${ms} ms, was ${answer.was})` : '(its window not found)') : answer?.error || 'no answer');
  return Boolean(answer?.shown);
}

/** The browser's process name from Windows' media name for it ("MSEdge", "Chrome", "308046B0AF4A39CB" for Firefox). */
function browserName(app) {
  const name = String(app || '').toLowerCase().replace(/\.exe$/, '');
  for (const known of ['msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi', 'arc']) if (name.includes(known)) return known;
  if (name.includes('edge')) return 'msedge';
  return '';
}

module.exports = { tabs, musicSite, open, press, letLoad, siteOfTitle, isMusic };
