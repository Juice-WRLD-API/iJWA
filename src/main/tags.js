// A song file's names and picture, read from its own tags (FolderLibrary.swift's reading): ID3 in MP3s, the iTunes
// atoms in M4A/AAC files, Vorbis comments in FLAC. A file without them is named by its file's name, "Artist - Title"
// as people name songs, a track number in front let go.
const fs = require('fs');
const path = require('path');

const SONG_TYPES = new Set(['.mp3', '.m4a', '.aac', '.mp4', '.flac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.aif']);
const isSong = (file) => SONG_TYPES.has(path.extname(file).toLowerCase());

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return read < length ? buffer.subarray(0, read) : buffer;
}

// ---- ID3 ----

function decodeText(bytes, encoding) {
  if (!bytes.length) return '';
  let text;
  if (encoding === 1 || encoding === 2) {
    let body = bytes, bigEndian = encoding === 2;
    if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) { body = body.subarray(2); bigEndian = false; }
    else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) { body = body.subarray(2); bigEndian = true; }
    if (bigEndian) { body = Buffer.from(body); body.swap16(); }
    text = body.subarray(0, body.length - (body.length % 2)).toString('utf16le');
  } else text = bytes.toString(encoding === 3 ? 'utf8' : 'latin1');
  // Several values are joined by nothing in ID3v2.4: the first is the song's.
  return text.split('\u0000')[0].trim();
}

/** Where a string ends in a frame: one zero byte, or two on a 16-bit boundary for UTF-16. */
function textEnd(bytes, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    return bytes.length;
  }
  const i = bytes.indexOf(0, start);
  return i < 0 ? bytes.length : i;
}

function id3(fd) {
  const header = readAt(fd, 0, 10);
  if (header.length < 10 || header.toString('latin1', 0, 3) !== 'ID3') return null;
  const version = header[3];
  const size = (header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9];
  let tag = readAt(fd, 10, Math.min(size, 16 * 1024 * 1024));
  // The whole tag unsynchronised (ID3v2.3): FF 00 stands for FF.
  if (header[5] & 0x80 && version < 4) {
    const out = [];
    for (let i = 0; i < tag.length; i++) { out.push(tag[i]); if (tag[i] === 0xff && tag[i + 1] === 0) i++; }
    tag = Buffer.from(out);
  }
  let at = 0;
  // An extended header comes first, when the flags say so.
  if (header[5] & 0x40 && version >= 3) at = version === 4 ? ((tag[0] << 21) | (tag[1] << 14) | (tag[2] << 7) | tag[3]) : tag.readUInt32BE(0) + 4;
  const found = {};
  const short = version === 2;
  while (at + (short ? 6 : 10) <= tag.length) {
    const id = tag.toString('latin1', at, at + (short ? 3 : 4));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const length = short ? (tag[at + 3] << 16) | (tag[at + 4] << 8) | tag[at + 5]
      : version === 4 ? (tag[at + 4] << 21) | (tag[at + 5] << 14) | (tag[at + 6] << 7) | tag[at + 7] : tag.readUInt32BE(at + 4);
    const start = at + (short ? 6 : 10);
    const body = tag.subarray(start, start + length);
    at = start + length;
    if (!body.length) continue;
    const name = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TPE2: 'albumArtist', TP2: 'albumArtist' }[id];
    if (name && !found[name]) found[name] = decodeText(body.subarray(1), body[0]);
    if ((id === 'APIC' || id === 'PIC') && !found.picture) {
      const encoding = body[0];
      let i = 1;
      if (id === 'APIC') i = body.indexOf(0, 1) + 1; else i = 4;   // the picture's type: a name, or three letters
      const kind = body[i];
      i = textEnd(body, i + 1, encoding) + (encoding === 1 || encoding === 2 ? 2 : 1);
      // The front cover is the song's; any other picture only when there is no front cover.
      if (i < body.length) { const data = body.subarray(i); if (kind === 3 || !found.anyPicture) found[kind === 3 ? 'picture' : 'anyPicture'] = data; }
    }
  }
  found.picture = found.picture || found.anyPicture || null;
  delete found.anyPicture;
  return found;
}

function id3v1(fd, size) {
  if (size < 128) return null;
  const tail = readAt(fd, size - 128, 128);
  if (tail.toString('latin1', 0, 3) !== 'TAG') return null;
  const field = (start) => tail.subarray(start, start + 30).toString('latin1').split('\u0000')[0].trim();
  return { title: field(3), artist: field(33), album: field(63) };
}

// ---- MP4 ----

function mp4(fd, size) {
  // The top-level boxes, for the movie's ("moov"), wherever it lies.
  let at = 0, moov = null;
  while (at + 8 <= size) {
    const head = readAt(fd, at, 16);
    let length = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (length === 1) length = Number(head.readBigUInt64BE(8));
    else if (length === 0) length = size - at;
    if (length < 8) break;
    if (type === 'moov') { moov = readAt(fd, at + 8, Math.min(length - 8, 32 * 1024 * 1024)); break; }
    at += length;
  }
  if (!moov) return null;
  const boxes = (buffer, from = 0, to = buffer.length) => {
    const list = [];
    for (let i = from; i + 8 <= to;) {
      const length = buffer.readUInt32BE(i);
      if (length < 8 || i + length > to) break;
      list.push({ type: buffer.toString('latin1', i + 4, i + 8), start: i + 8, end: i + length });
      i += length;
    }
    return list;
  };
  const find = (list, type) => list.find((b) => b.type === type);
  const udta = find(boxes(moov), 'udta');
  const meta = udta && find(boxes(moov, udta.start, udta.end), 'meta');
  // "meta" holds four bytes of version and flags before its boxes.
  const ilst = meta && find(boxes(moov, meta.start + 4, meta.end), 'ilst');
  if (!ilst) return {};
  const found = {};
  for (const item of boxes(moov, ilst.start, ilst.end)) {
    const data = find(boxes(moov, item.start, item.end), 'data');
    if (!data) continue;
    const value = moov.subarray(data.start + 8, data.end);
    const key = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumArtist' }[item.type];
    if (key) found[key] = value.toString('utf8').trim();
    if (item.type === 'covr' && !found.picture) found.picture = value;
  }
  return found;
}

// ---- FLAC ----

function flac(fd) {
  if (readAt(fd, 0, 4).toString('latin1') !== 'fLaC') return null;
  const found = {};
  let at = 4;
  for (let blocks = 0; blocks < 64; blocks++) {
    const head = readAt(fd, at, 4);
    if (head.length < 4) break;
    const last = head[0] & 0x80, type = head[0] & 0x7f, length = (head[1] << 16) | (head[2] << 8) | head[3];
    if (type === 4 || type === 6) {
      const body = readAt(fd, at + 4, length);
      if (type === 4) {
        let i = 4 + body.readUInt32LE(0);
        const count = body.readUInt32LE(i); i += 4;
        for (let n = 0; n < count && i + 4 <= body.length; n++) {
          const size = body.readUInt32LE(i); i += 4;
          const entry = body.toString('utf8', i, i + size); i += size;
          const eq = entry.indexOf('=');
          const key = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist' }[entry.slice(0, eq).toUpperCase()];
          if (key && !found[key]) found[key] = entry.slice(eq + 1).trim();
        }
      } else if (!found.picture) {
        let i = 4;
        const mime = body.readUInt32BE(i); i += 4 + mime;
        const description = body.readUInt32BE(i); i += 4 + description + 16;
        const size = body.readUInt32BE(i); i += 4;
        found.picture = body.subarray(i, i + size);
      }
    }
    at += 4 + length;
    if (last) break;
  }
  return found;
}

// ---- the file ----

/** A file's name as a song's: "03 - Ezhel - Alo.mp3" is Alo, by Ezhel. */
function fromName(file) {
  let name = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  name = name.replace(/^\d{1,3}\s*[-.)_]?\s+/, '');
  const dash = name.indexOf(' - ');
  return dash > 0 ? { title: name.slice(dash + 3).trim(), artist: name.slice(0, dash).trim() } : { title: name, artist: '' };
}

/** `{ title, artist, album, picture }` of a song file; `picture` (bytes) only when asked for. */
function read(file, withPicture = false) {
  let fd = null, found = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const type = path.extname(file).toLowerCase();
    if (type === '.mp3' || type === '.aac' || type === '.wav' || type === '.aiff' || type === '.aif') found = id3(fd) || id3v1(fd, size);
    else if (type === '.m4a' || type === '.mp4') found = mp4(fd, size);
    else if (type === '.flac') found = flac(fd);
  } catch { /* unreadable: named by its file */ } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
  const named = fromName(file);
  return {
    title: found?.title || named.title,
    artist: found?.artist || found?.albumArtist || named.artist,
    album: found?.album || '',
    picture: withPicture ? found?.picture || null : undefined,
  };
}

module.exports = { read, isSong, SONG_TYPES };
