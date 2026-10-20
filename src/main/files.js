// A file from disk as an answer to a page, whole or the bytes it asks for: videos are read in pieces as they play.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' };

/** A file from disk, whole or the bytes a Range header asks for. */
function serveFile(file, request) {
  let size;
  try { size = fs.statSync(file).size; } catch { return new Response('Not found', { status: 404 }); }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const asked = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (!asked) return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  let start = asked[1] ? Number(asked[1]) : size - Number(asked[2]);
  let end = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1;
  if (!asked[1]) end = size - 1;
  if (start >= size || start < 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
  });
}

module.exports = { serveFile };
