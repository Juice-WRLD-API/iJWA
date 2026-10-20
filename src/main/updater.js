// Updates (Updater.swift's Sparkle, on Windows): iJWA's releases on GitHub (rapperasistan/ibaila-windows, nothing
// but installers) are asked at start and once a day. A new version downloads quietly — only the parts that changed —
// and then asks to restart; left for later, it is installed the next time iJWA quits.
const { app, dialog } = require('electron');

/** Only an installed copy updates itself: the test machine's loose files and `electron .` don't. */
const installed = app.isPackaged && __dirname.includes('app.asar');

let updater = null;
let asked = false;      // Check for Updates… was pressed: its answer is shown, even "up to date"
let offered = null;     // the version already offered

function strip(notes) {
  const text = Array.isArray(notes) ? notes.map((n) => n.note).join('\n') : String(notes || '');
  return text.replace(/<li>/gi, '• ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}

async function offer(info) {
  if (offered === info.version) return;
  offered = info.version;
  const notes = strip(info.releaseNotes);
  const { response } = await dialog.showMessageBox({ type: 'info', title: 'iJWA', noLink: true, buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
    message: `iJWA ${info.version} is ready`, detail: `${notes ? `${notes}\n\n` : ''}Restart iJWA to use it.` });
  if (response === 0) setImmediate(() => updater.quitAndInstall(true, true));
}

function start() {
  if (!installed) return;
  updater = require('electron-updater').autoUpdater;
  updater.logger = { info: (m) => console.log('[update]', m), warn: (m) => console.warn('[update]', m), error: (m) => console.error('[update]', m), debug() {} };
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', (info) => { asked = false; offer(info); });
  updater.on('update-not-available', () => {
    if (!asked) return;
    asked = false;
    dialog.showMessageBox({ type: 'info', title: 'iJWA', noLink: true, buttons: ['OK'], message: 'You’re up to date', detail: `iJWA ${app.getVersion()} is the newest version.` });
  });
  updater.on('error', (error) => {
    if (!asked) return;
    asked = false;
    dialog.showMessageBox({ type: 'warning', title: 'iJWA', noLink: true, buttons: ['OK'], message: 'iJWA couldn’t check for updates',
      detail: 'Check your connection and try again in a moment.' });
    console.error('[update]', error?.message);
  });
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 30 * 1000);
  setInterval(check, 24 * 60 * 60 * 1000);
}

/** Check for Updates…: asked now, and answered either way. A version downloaded already is offered again. */
function checkNow() {
  if (!updater) {
    dialog.showMessageBox({ type: 'info', title: 'iJWA', noLink: true, buttons: ['OK'], message: 'You’re up to date', detail: `iJWA ${app.getVersion()} is the newest version.` });
    return;
  }
  asked = true;
  offered = null;
  updater.checkForUpdates().catch(() => {});
}

module.exports = { start, checkNow };
