// The places one listens in, as their marks (SourceMark.swift): Apple Music, Spotify, Unreleased, YouTube, YouTube Music,
// SoundCloud, a browser and iJWA's own player — drawn here, on a 100-unit square, the mark filling about four
// fifths of it as an app icon's shape does, so they stand side by side at one size.
const mark = (body, defs = '') =>
  `<svg viewBox="0 0 100 100" aria-hidden="true"><defs>${defs}</defs><g transform="translate(9 9) scale(0.82)">${body}</g></svg>`;

/** Bars rising toward the cloud, then the cloud, as SoundCloud draws itself. */
const cloud = () => {
  let bars = '';
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const height = 10 + 20 * t * t + 2 * t;
    bars += `<rect x="${12 + 4.2 * i}" y="${66 - height}" width="2.4" height="${height}" rx="1.2" fill="#fff"/>`;
  }
  return `${bars}<rect x="50" y="36" width="20" height="30" rx="1" fill="#fff"/><circle cx="65" cy="44" r="17" fill="#fff"/>
    <circle cx="79.5" cy="54.5" r="11.5" fill="#fff"/><rect x="50" y="50" width="30" height="16" fill="#fff"/>`;
};

export const logos = {
  appleMusic: mark(`<rect width="100" height="100" rx="23" fill="url(#am)"/>
    <path d="M40 70V34.5c0-1.6 1.1-2.9 2.6-3.2l22-4.6c1.9-.4 3.4 1 3.4 2.9v31.6" fill="none" stroke="#fff" stroke-width="5.5"/>
    <ellipse cx="33" cy="70.5" rx="8" ry="6.6" fill="#fff"/><ellipse cx="61" cy="64" rx="8" ry="6.6" fill="#fff"/>`,
    '<linearGradient id="am" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb5c74"/><stop offset="1" stop-color="#fa233b"/></linearGradient>'),
  spotify: mark(`<circle cx="50" cy="50" r="50" fill="#1ed760"/>
    <path d="M22 38c19-6 40-4 57 6" fill="none" stroke="#121212" stroke-width="8.5" stroke-linecap="round"/>
    <path d="M26 53c15-4.5 32-3 46 4.5" fill="none" stroke="#121212" stroke-width="7" stroke-linecap="round"/>
    <path d="M30 67c12-3.5 25-2.4 36 3.4" fill="none" stroke="#121212" stroke-width="5.5" stroke-linecap="round"/>`),
  unreleased: mark('<image href="ijwa://app/desktop/unreleased.png" width="100" height="100"/>'),
  youTube: mark(`<rect y="15" width="100" height="70" rx="20" fill="#ff0000"/><path d="M40 35v30l26-15z" fill="#fff"/>`),
  youTubeMusic: mark(`<circle cx="50" cy="50" r="50" fill="#ff0033"/><circle cx="50" cy="50" r="29" fill="none" stroke="#fff" stroke-width="5"/>
    <path d="M41 36v28l24-14z" fill="#fff"/>`),
  soundCloud: mark(`<rect width="100" height="100" rx="23" fill="url(#sc)"/>${cloud()}`,
    '<linearGradient id="sc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8c00"/><stop offset="1" stop-color="#ff3300"/></linearGradient>'),
  browser: mark(`<circle cx="50" cy="50" r="50" fill="url(#br)"/><g fill="none" stroke="#fff" stroke-width="4.5" opacity="0.95">
    <circle cx="50" cy="50" r="32"/><ellipse cx="50" cy="50" rx="14" ry="32"/><path d="M18 50h64M23 34h54M23 66h54"/></g>`,
    '<linearGradient id="br" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c8dff"/><stop offset="1" stop-color="#2058e8"/></linearGradient>'),
  files: mark(`<rect width="100" height="100" rx="23" fill="url(#fl)"/>
    <path d="M40 70V34.5c0-1.6 1.1-2.9 2.6-3.2l22-4.6c1.9-.4 3.4 1 3.4 2.9v31.6" fill="none" stroke="#fff" stroke-width="5.5"/>
    <ellipse cx="33" cy="70.5" rx="8" ry="6.6" fill="#fff"/><ellipse cx="61" cy="64" rx="8" ry="6.6" fill="#fff"/>`,
    '<linearGradient id="fl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5fa2"/><stop offset="1" stop-color="#b8326f"/></linearGradient>'),
  automatic: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 3.5c.3 3.7 2.3 5.7 6 6-3.7.3-5.7 2.3-6 6-.3-3.7-2.3-5.7-6-6 3.7-.3 5.7-2.3 6-6z"/>
    <path d="M18 13c.2 2 1.1 2.9 3 3-1.9.1-2.8 1-3 3-.2-2-1.1-2.9-3-3 1.9-.1 2.8-1 3-3zM17.5 2.5c.1 1.3.8 2 2 2-1.2.1-1.9.8-2 2-.1-1.2-.8-1.9-2-2 1.2 0 1.9-.7 2-2z"/></svg>`,
};

// Spotify's Web Player wears Spotify's own mark.
logos.spotifyWeb = logos.spotify;

/** The places to choose from, in the menu's order. */
export const CHOICES = [
  { id: 'appleMusic', name: 'Apple Music' },
  { id: 'spotify', name: 'Spotify' },
  { id: 'unreleased', name: 'Unreleased' },
  { id: 'spotifyWeb', name: 'Spotify Web Player' },
  { id: 'youTubeMusic', name: 'YouTube Music' },
  { id: 'soundCloud', name: 'SoundCloud' },
];
