// The lyric styles to choose from, as the lights are (LyricsStyle.Look in LightSettings.swift), each with the face
// it's set in until another is picked for it: every style keeps its own (his ask, 2026-10-11: "hepsine kendi default
// fontunu… hepsine ayrı font seçimi").
export const LYRIC_LOOKS = [
  { id: 'fisheye', title: 'Fisheye', face: 'Georgia' },
  { id: 'spread', title: 'Spread', face: 'Georgia' },
  { id: 'karaoke', title: 'Karaoke', face: 'Segoe' },
  { id: 'typewriter', title: 'Typewriter', face: 'Courier' },
  { id: 'neon', title: 'Neon', face: 'BahnschriftWide' },
  { id: 'echo', title: 'Echo', face: 'Franklin' },
  { id: 'glitch', title: 'Glitch', face: 'ArialBlack' },
  { id: 'cinema', title: 'Cinema', face: 'PalatinoItalic' },
];

export const lyricLookOf = (id) => LYRIC_LOOKS.find((l) => l.id === id) || LYRIC_LOOKS[0];

/** The face of `look` in the desktop's settings: the one picked for it, else its own. The single face picked before
 *  styles had their own was the fisheye's, all there was then. */
export function lyricFontFor(desktop, look) {
  const picked = desktop?.lyricsFonts?.[look];
  if (picked) return picked;
  if (look === 'fisheye' && desktop?.lyricsFont) return desktop.lyricsFont;
  return lyricLookOf(look).face;
}
