// Song covers from the web, kept on disk: a list shown again has its pictures at once, and pages reach a cover as
// ibaila://app/cover/<name> — their own origin, so they can read its colors. A cover not on disk yet is fetched the
// moment it is asked for (or warmed earlier), once however many ask.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP = 800; // covers kept on disk; the oldest go first
const folder = () => path.join(app.getPath('userData'), 'covers');
const remotes = new Map();   // name → web address
const fetching = new Map();  // name → Promise<Buffer|null>
let tidied = false;

const nameOf = (link) => crypto.createHash('sha1').update(link).digest('hex').slice(0, 24) + '.jpg';

/** The page address for a cover on the web (an address of the app's own passes through). */
function local(link) {
  if (!link || !/^https?:/.test(link)) return link || null;
  const name = nameOf(link);
  remotes.set(name, link);
  return `ibaila://app/cover/${name}`;
}

/** Fetches a cover onto disk before any page asks for it. */
function warm(link) {
  if (!link || !/^https?:/.test(link)) return;
  const name = nameOf(link);
  remotes.set(name, link);
  bytes(name);
}

function bytes(name) {
  const file = path.join(folder(), name);
  if (fs.existsSync(file)) return Promise.resolve(null);
  if (fetching.has(name)) return fetching.get(name);
  const link = remotes.get(name);
  if (!link) return Promise.resolve(null);
  const run = (async () => {
    try {
      const response = await net.fetch(link, { signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) { console.log('[covers]', response.status, link); return null; }
      const data = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(folder(), { recursive: true });
      fs.writeFileSync(file, data);
      tidy();
      return data;
    } catch (error) { console.log('[covers]', link, error.message); return null; } finally { fetching.delete(name); }
  })();
  fetching.set(name, run);
  return run;
}

/** Serves ibaila://app/cover/<name>: from disk, else fetched now. */
async function serve(name) {
  name = path.basename(name);
  const file = path.join(folder(), name);
  if (fs.existsSync(file)) return new Response(fs.readFileSync(file), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000' } });
  const data = await bytes(name);
  if (data) return new Response(data, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000' } });
  if (fs.existsSync(file)) return new Response(fs.readFileSync(file), { headers: { 'Content-Type': 'image/jpeg' } });
  return new Response('Not found', { status: 404 });
}

/** Once a run: lets the oldest covers go past KEEP. */
function tidy() {
  if (tidied) return;
  tidied = true;
  setTimeout(() => {
    try {
      const files = fs.readdirSync(folder()).map((n) => ({ n, t: fs.statSync(path.join(folder(), n)).mtimeMs })).sort((a, b) => b.t - a.t);
      // Optimized mode keeps a quarter as many.
      const keep = require('./settings').get().energy?.optimize ? KEEP / 4 : KEEP;
      for (const { n } of files.slice(keep)) fs.unlinkSync(path.join(folder(), n));
    } catch { /* next run */ }
  }, 30000);
}

module.exports = { local, warm, serve };
