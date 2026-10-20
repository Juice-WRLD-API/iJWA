// iBaila's license on Windows (License.swift): a key bought on Polar, activated on this one computer. The keys are the
// Mac's own, one activation each, so a key works on one Mac or one PC. Polar's license API is made for apps to call
// directly — "can be safely used on a public client" — so there is no server of ours.
//
// Activating binds the key to this PC: Polar keeps the activation with a condition only this PC meets — a hash of its
// MachineGuid, never the ID itself. The key and the activation are kept beside the settings, encrypted by Windows for
// this user. At each start the license is checked again, quietly: only Polar saying no — the key revoked, the
// activation gone — takes it away; no network is no answer, and changes nothing.
const { app, safeStorage } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Polar's ID for YoMilly (License.organizationID). Not a secret: the license API needs it and nothing more. */
const ORGANIZATION = '78cd6f7b-837d-4f24-b7af-4578415c0e97';
const API = 'https://api.polar.sh/v1/customer-portal/license-keys/';
/** Where a key is bought. */
const STORE = 'https://aestheticmac.com/ibaila';

/** A copy run from a folder of loose files — the test machine's, or `electron .` — runs without a key; every copy
 *  anyone installs is packed (app.asar), and asks for one. IBAILA_LICENSE=1 asks all the same, for trying it. */
const required = process.env.IBAILA_LICENSE === '1' || (app.isPackaged && __dirname.includes('app.asar'));

const file = () => path.join(app.getPath('userData'), 'license.bin');

function load() {
  try {
    const bytes = fs.readFileSync(file());
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(bytes) : bytes.toString('utf8'));
  } catch { return null; }
}

function store(saved) {
  const text = JSON.stringify(saved);
  try { fs.writeFileSync(file(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text)); }
  catch (error) { console.error('[license] not kept:', error.message); }
}

function forget() { try { fs.unlinkSync(file()); } catch { /* none */ } }

/** Only this PC meets it: its MachineGuid, hashed with iBaila's own salt (the Mac's, for its hardware ID). */
let device = null;
function deviceID() {
  if (device) return Promise.resolve(device);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { windowsHide: true }, (_error, out) => {
      const guid = (String(out || '').match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || '';
      device = crypto.createHash('sha256').update(`ibaila.yomilly.${guid}`).digest('hex').slice(0, 32);
      resolve(device);
    });
  });
}

/** What Polar shows the buyer for this activation, in their orders: the kind of computer and a few letters of its
 *  hash — no name of theirs. */
const label = (id) => `Windows PC · ${id.slice(0, 6)}`;

/** { ok, body } or { error: 'unknownKey' | 'usedElsewhere' | 'offline' | 'other' } */
async function call(action, body) {
  let response;
  try {
    response = await fetch(API + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `iBaila/${app.getVersion()} (Windows)` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch { return { error: 'offline' }; }
  const answer = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, body: answer };
  if (response.status === 404) return { error: 'unknownKey' };
  if (response.status === 403) {
    // Revoked, disabled or expired keys say so; otherwise the limit of one computer is met.
    const detail = String(answer.detail || '').toLowerCase();
    return { error: detail.includes('limit') || detail.includes('activation') ? 'usedElsewhere' : 'unknownKey' };
  }
  console.error(`[license] Polar ${action}: ${response.status}`);
  return { error: 'other' };
}

let saved = null;
let state = 'locked';
const listeners = new Set();

/** Read once the app is ready (Windows' encryption needs it). */
function start() {
  saved = load();
  state = !required || saved ? 'active' : 'locked';
}

function set(next) { state = next; for (const listener of listeners) listener(state); }

/** Activates `text` on this PC: null, or what went wrong. */
async function activate(text) {
  const key = String(text || '').trim();
  if (!required) { set('active'); return null; }
  if (!key) return 'unknownKey';
  const id = await deviceID();
  const answer = await call('activate', { key, organization_id: ORGANIZATION, label: label(id), conditions: { device: id } });
  if (answer.error) return answer.error;
  if (!answer.body.id) return 'other';
  saved = { key, activation: answer.body.id };
  store(saved);
  set('active');
  return null;
}

/** Lets this PC go, so the key can be activated on another computer: null, or what went wrong. */
async function deactivate() {
  if (!saved) return null;
  const answer = await call('deactivate', { key: saved.key, organization_id: ORGANIZATION, activation_id: saved.activation });
  if (answer.error && answer.error !== 'unknownKey') return answer.error;
  forget();
  saved = null;
  set('locked');
  return null;
}

/** Asks Polar whether the license still stands. Only a clear no takes it away. */
async function check() {
  if (!required || !saved) return;
  const id = await deviceID();
  const answer = await call('validate', { key: saved.key, organization_id: ORGANIZATION, activation_id: saved.activation, conditions: { device: id } });
  if (answer.error === 'unknownKey') {
    console.log('[license] the license was revoked or its activation is gone');
    forget();
    saved = null;
    set('locked');
  }
}

module.exports = {
  start, activate, deactivate, check, STORE,
  get state() { return state; },
  /** Whether this copy asks for a key at all, and holds one. */
  get held() { return required && Boolean(saved); },
  onChange: (listener) => listeners.add(listener),
};
