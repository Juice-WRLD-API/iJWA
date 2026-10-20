// iJWA's helpers in one PowerShell (agents.ps1), each in a runspace of its own: what Windows says plays (smtc.ps1),
// Spotify and Apple Music (spotify-agent.ps1), the browsers (web-agent.ps1). A PowerShell apiece held 35–45 MB each
// (measured 2026-10-09). Lines go both ways as "<helper>\t<line>".
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { unpacked } = require('./unpacked');

const helpers = new Map(); // name → { line(text), ended() }
let child = null;
let started = new Set();   // the helpers this PowerShell runs

function host() {
  if (process.platform !== 'win32') return null;
  if (child && child.exitCode === null) return child;
  const made = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', unpacked(path.join(__dirname, 'agents.ps1'))],
    { windowsHide: true });
  made.stdin.setDefaultEncoding('utf8');
  readline.createInterface({ input: made.stdout }).on('line', (line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return;
    const name = line.slice(0, tab), text = line.slice(tab + 1);
    if (text === '{"ended":true}') { started.delete(name); helpers.get(name)?.ended(); return; }
    helpers.get(name)?.line(text);
  });
  made.stderr.setEncoding('utf8');
  made.stderr.on('data', (text) => console.error('[helpers]', String(text).trim().slice(0, 400)));
  made.on('exit', (code) => {
    if (child !== made) return;
    console.log('[helpers] the PowerShell ended', code);
    child = null;
    const were = started;
    started = new Set();
    for (const name of were) helpers.get(name)?.ended();
  });
  child = made;
  return child;
}

/** What `name` says, line by line, and when it ends. */
function listen(name, line, ended) { helpers.set(name, { line, ended }); }

/** Hands `text` to helper `name`, started if it isn't running; false where there are no helpers (not Windows). */
function send(name, text) {
  const to = host();
  if (!to || !to.stdin.writable) return false;
  started.add(name);
  to.stdin.write(`${name}\t${text}\n`);
  return true;
}

/** Ends helper `name` (one held up in a long step): the next line starts it afresh. */
function restart(name) {
  if (!started.has(name)) return;
  started.delete(name);
  if (child && child.stdin.writable) child.stdin.write(`${name}\trestart\n`);
}

function stop() { if (child) { child.kill(); child = null; } }

module.exports = { listen, send, restart, stop };
