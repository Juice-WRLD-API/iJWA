// Songs' and artists' names, made comparable (SpotifyLookup.swift): what versions add to a title, case, accents,
// punctuation; "Kayıp Kalp" and "KAYIP KALP" are one.

/** A title without its "(feat. …)", "[Remix]" or " - Single" tail — every bracket, a leading one too. */
const bare = (text) => String(text || '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/ - (Single|EP)$/i, '').trim();

/** Case, accents and punctuation gone, the tail kept: "FREAKED OUT (Slowed)" isn't "FREAKED OUT". */
const whole = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** For comparing: no tail either. */
const simple = (text) => whole(bare(text));

/** The first of the artists a song credits; YouTube Music joins them in the browser's language ("ve", "und"). */
function lead(artist) {
  let name = String(artist || '');
  for (const mark of [',', ' & ', ' feat.', ' ft.', ' x ', ' with ', ' ve ', ' und ', ' et ', ' y ', ' e ']) {
    const at = name.toLowerCase().indexOf(mark);
    if (at >= 0) name = name.slice(0, at);
  }
  return name.trim();
}

/** The song playing is the one asked for, by its words — either way round, as a page's title may hold its singer
 *  ("Back In Chicago - Juice WRLD"): the playing words must hold all of the asked title, never the other way about. */
function matches(track, title) {
  const wanted = simple(title);
  if (!track || wanted.length < 2) return false;
  return [track.title, `${track.artist} ${track.title}`, `${track.title} ${track.artist}`].map(simple)
    .some((shown) => shown === wanted || shown.includes(wanted));
}

/** The same song (CatalogPlayer.isSame): the same title, versions' additions cut off ("(feat. …)", " - Remastered"),
 *  and the same artist — one name starting the other, or the same first artist however the others are joined to them:
 *  Music in Turkish says "Lil Tecca ve NAV" for "Lil Tecca & NAV" (Mac, 2026-10-10). */
function plainTitle(title) {
  let text = String(title || '').toLowerCase();
  for (const mark of [' (', ' [', ' - ']) { const at = text.indexOf(mark); if (at >= 0) text = text.slice(0, at); }
  return text.trim();
}
function same(title, artist, song) {
  if (!song || plainTitle(title) !== plainTitle(song.title)) return false;
  const told = String(artist || '').toLowerCase(), listed = String(song.artist || '').toLowerCase();
  if (told.startsWith(listed) || listed.startsWith(told)) return true;
  const first = lead(told);
  return Boolean(first) && first === lead(listed);
}

module.exports = { bare, whole, simple, lead, matches, same, plainTitle };
