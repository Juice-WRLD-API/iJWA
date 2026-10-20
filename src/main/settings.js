// The light's settings, kept in one small file in the app's folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  isEnabled: true, isOn: true, twoColors: true, motion: 'music',
  onlyOnDesktop: false,  // the light shown only while the desktop (or iBaila) is in front
  look: 'snake', place: 'all', // which light, and where round the screen (LightStyle.Look, LightStyle.Place)
  thickness: 0.1, glow: 0.7, particles: 0.4, tailLength: 1.0,
  primary: { hue: 0.74, saturation: 0.68, brightness: 1 },
  secondary: { hue: 0.54, saturation: 0.9, brightness: 1 },
  useArtworkColors: true, sensitivity: 0.5, reaction: 0.6, smoothness: 0.5,
  // The desktop player (DesktopStyle in LightSettings.swift).
  desktop: {
    isOn: true,
    size: 0.45,            // 0...1: from 80% to 125% of the design's size
    tilt: 0.5,             // 0...1: how far the side cards turn away
    sideCards: 2,          // cards shown on each side of the middle one, 1...3
    glassBrightness: 0.6,  // 0...1: from plain glass to bright milky glass
    frost: 0.35,           // 0...1: how blurred the wallpaper looks through the cards' glass
    locked: false,         // stays put when dragged
    mini: false,           // made small: only a capsule with the song and back, play, forward
    hidesLyricsCard: false, // with the lyrics open, their album card folded away to the left by the eye beside the tools
    place: null,           // [x, y]: the player's center as fractions of its display's usable area
    lyricsFont: 'Georgia', // the face picked before each style had its own: now the fisheye's (lyriclooks.js)
    lyricsLook: 'fisheye', // the lyric style (LYRIC_LOOKS in lyriclooks.js)
    lyricsFonts: {},       // the face picked for each style, by its id; a style not picked for is set in its own
  },
  // The playlist panel beside it (PlaylistStyle in LightSettings.swift).
  playlist: {
    isOn: true,
    side: 'left',          // stands at the left of the desktop, its covers' edge nearest
    tilt: 1.0,             // 0...1: how far the list turns away, from 10 to 45 degrees
    size: 0.4,             // 0...1: from 80% to 130% of the design's size
    rows: 8,               // songs shown at once, 4...12; the rest scroll
    locked: false,
    place: null,
  },
  // Songs start 15 seconds in, past their intro.
  general: { startLater: false },
  // What the light and the wallpaper give up to save energy (EnergyStyle in LightSettings.swift).
  // stillInLowPower: the light holds still while Windows' Energy saver is on; optimize: Optimized mode — less memory.
  energy: { saveOnBattery: true, stillInLowPower: true, restWhenAway: true, hideInFullScreen: false, optimize: false },
  // The icon by the clock (DockStyle in LightSettings.swift): the playing song's artwork, in a ring of the light's colors.
  tray: { artworkIcon: true, shape: 'rounded', ring: true, ringThickness: 0.5, ringGlow: 0.6, ringPulse: true },
  // Displays the light and the live wallpaper keep off, by name.
  hiddenDisplays: [],
  // The live wallpaper (WallpaperStyle in LightSettings.swift).
  wallpaper: {
    isOn: true,            // songs' clips: the music video, the album's moving cover or the artist's video
    darkness: 0.5,         // 0...1: how much the picture is darkened, so the glass and icons over it read well
    videoIsOn: false,      // the user's own video on the desktop, beneath songs' clips
    video: null,           // that video, as kept in iBaila's folder: "<id>/<file name>"
  },
  // The clock on the desktop (ClockStyle in LightSettings.swift).
  clock: {
    isOn: true,
    size: 0.5,             // 0...1: how tall the digits stand
    stretch: 0.55,         // 0...1: how far the digits stretch up, as the Lock Screen's clock does
    weight: 0.3,           // 0...1: from hairline to bold digits
    tint: 0.45,            // 0...1: how much color the glass takes
    useArtworkColor: true, // the glass takes the color of the song's artwork while one plays
    showDate: true,
    locked: false,
    place: null,
  },
};
const NESTED = ['desktop', 'playlist', 'clock', 'wallpaper', 'general', 'energy', 'tray'];

const file = () => path.join(app.getPath('userData'), 'settings.json');
let current = null;
let pending = null;

/** Whether there were no settings yet when iBaila started: a fresh install. */
let fresh = false;

function load() {
  let text = null;
  try { text = fs.readFileSync(file(), 'utf8'); } catch { fresh = true; }
  try {
    if (text == null) throw new Error('none yet');
    // Saved by Notepad or PowerShell, the file may start with a byte-order mark, which JSON.parse refuses: an
    // unreadable file came up as the defaults, saved over it (Isaac's report, 2026-10-11).
    const saved = JSON.parse(text.replace(/^\uFEFF/, ''));
    // The light was first made thicker (0.42, then 0.2) than it should stand by default: a reach nobody moved goes
    // to the new one, and is kept so.
    if ((saved.revision || 0) < 3 && [0.42, 0.2].includes(saved.thickness)) { saved.thickness = DEFAULTS.thickness; saved.revision = 3; setTimeout(save, 0); }
    current = { ...DEFAULTS, ...saved };
    for (const key of NESTED) current[key] = { ...DEFAULTS[key], ...(saved[key] || {}) };
  } catch (error) {
    // A file there that can't be read is kept aside before anything is saved over it.
    if (text != null) {
      try { fs.copyFileSync(file(), `${file()}.bad`); } catch { /* kept as it is */ }
      console.error('Settings unreadable, kept as settings.json.bad:', error.message);
    }
    current = { ...DEFAULTS };
    for (const key of NESTED) current[key] = { ...DEFAULTS[key] };
  }
  return current;
}
function isFresh() { get(); return fresh; }
function get() { return current || load(); }
function set(patch) {
  const before = get();
  current = { ...before, ...patch };
  for (const key of NESTED) current[key] = { ...before[key], ...(patch[key] || {}) };
  clearTimeout(pending);
  pending = setTimeout(save, 400); // a dragged slider changes it 60 times a second
  return current;
}
function save() {
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(current, null, 2)); }
  catch (error) { console.error('Settings not saved:', error); }
}
module.exports = { get, set, save, isFresh, DEFAULTS };
