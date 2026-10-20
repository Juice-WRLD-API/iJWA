// Presses Windows eats. iJWA's desktop windows never take the keys, and Chromium answers Windows' "activate on
// this click?" for such a window with "no, and eat the click" — at times, the press goes and only the release and
// the moves after it arrive (seen in the test machine, 2026-10-09). Each window is watched: a release, or a pointer
// held down and moving, with no press heard before it, gets its press handed to the page again where it was — a click
// whole, or the press a drag goes on from.
const { isMoving } = require('./drag');

/** Watches the windows of `parts` ([() => BrowserWindow]), each as it is made. */
function watch(parts) {
  const hooked = new WeakSet();
  const hook = (win) => {
    hooked.add(win);
    let pressed = false, lostSince = 0;
    win.webContents.on('input-event', (_e, input) => {
      if (input.type === 'mouseDown') { pressed = true; lostSince = 0; return; }
      let lost = false;
      if (input.type === 'mouseUp') { lost = !pressed; pressed = false; }
      else if (input.type === 'mouseMove' && !pressed && !isMoving() && (input.modifiers || []).some((m) => /leftbuttondown/i.test(m))) {
        lostSince = lostSince || Date.now();
        lost = Date.now() - lostSince > 250;
      }
      if (!lost || win.isDestroyed()) return;
      lostSince = 0;
      const at = { x: input.x, y: input.y, button: 'left', clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...at });
      if (input.type === 'mouseUp') win.webContents.sendInputEvent({ type: 'mouseUp', ...at });
      pressed = input.type !== 'mouseUp';
    });
  };
  setInterval(() => {
    for (const part of parts) {
      const win = part();
      if (win && !win.isDestroyed() && !hooked.has(win)) hook(win);
    }
  }, 1000);
}

module.exports = { watch };
