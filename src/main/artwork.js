// Song artwork kept on disk, so the cards and the list still have their pictures after a restart. One file per
// album: songs of an album share it. Pages reach a file as ibaila://app/artwork/<name>: the pages' own origin, so
// they can read a picture's colors.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const folder = () => path.join(app.getPath('userData'), 'artwork');

/** The file name an album's artwork is kept under. */
function keyFor(song) {
  const album = (song.album || song.title || '').trim().toLowerCase();
  const artist = (song.artist || '').trim().toLowerCase();
  return crypto.createHash('sha1').update(`${artist}|${album}`).digest('hex').slice(0, 20) + '.jpg';
}

/** Saves a picture (bytes), shrunk to 512 pixels at most; answers its file name. */
function save(song, bytes) {
  try {
    let image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (Math.max(width, height) > 512) image = image.resize(width >= height ? { width: 512, quality: 'best' } : { height: 512, quality: 'best' });
    const name = keyFor(song);
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), name), image.toJPEG(90));
    return name;
  } catch { return null; }
}

function has(name) { return Boolean(name) && fs.existsSync(path.join(folder(), name)); }
function file(name) { return path.join(folder(), path.basename(name)); }
/** How wide a kept picture is, in pixels (0 when there is none). */
function widthOf(name) { try { return name ? nativeImage.createFromPath(file(name)).getSize().width : 0; } catch { return 0; } }
/** A kept picture's page address; a picture saved again under its name gets a new one, so pages show the new one. */
function url(name) {
  if (!name) return null;
  let version = 0;
  try { version = Math.round(fs.statSync(file(name)).mtimeMs); } catch { /* not there */ }
  return `ibaila://app/artwork/${name}?v=${version}`;
}

function remove(name) { try { fs.unlinkSync(file(name)); } catch { /* gone already */ } }

/** Lets go of every picture no song shows any more. */
function removeAll(except) {
  try { for (const name of fs.readdirSync(folder())) if (!except.has(name)) remove(name); } catch { /* no folder yet */ }
}

module.exports = { keyFor, save, has, file, url, widthOf, remove, removeAll, folder };
