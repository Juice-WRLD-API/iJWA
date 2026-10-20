// What the app says, kept in a small file beside its settings (iBaila.log), so a problem on someone's PC can be
// read afterwards. The pages' own messages and errors go there too.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let file = null;
function write(level, parts) {
  try {
    if (!file) {
      file = path.join(app.getPath('userData'), 'iBaila.log');
      // Starts afresh once it passes half a megabyte.
      try { if (fs.statSync(file).size > 512 * 1024) fs.unlinkSync(file); } catch { /* no file yet */ }
    }
    const text = parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack : JSON.stringify(p))).join(' ');
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch { /* nowhere to write */ }
}

function install() {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...parts) => { original(...parts); write(level, parts); };
  }
  process.on('uncaughtException', (error) => write('crash', [error]));
  process.on('unhandledRejection', (error) => write('crash', [error]));
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') write(`page-${event.level}`, [`${event.message} (${event.sourceId}:${event.lineNumber})`]);
    });
    contents.on('render-process-gone', (_e, details) => write('page-gone', [details]));
  });
}

module.exports = { install, write };
