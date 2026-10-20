// Between the page's own world (main.js) and the extension: what plays, passed on.
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || typeof event.data.ibailaState !== 'object') return;
  try { chrome.runtime.sendMessage({ state: event.data.ibailaState }).catch(() => {}); } catch {}
});

// The loudness last chosen on this site, handed to the page as it opens (main.js gives it to the player).
{
  const site = /(^|\.)soundcloud\.com$/.test(location.hostname) ? 'soundCloud' : location.hostname === 'open.spotify.com' ? 'spotifyWeb' : 'youTubeMusic';
  try {
    chrome.storage.local.get(`volume:${site}`)
      .then((kept) => window.postMessage({ ibailaVolume: kept[`volume:${site}`] ?? null }, '*'))
      .catch(() => window.postMessage({ ibailaVolume: null }, '*'));
  } catch { window.postMessage({ ibailaVolume: null }, '*'); }
}
