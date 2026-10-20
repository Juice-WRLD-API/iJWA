// Smooth wheel scrolling for a scrolling list: a mouse wheel's notch glides instead of jumping, and a trackpad's many
// small steps run on as one motion. The list eases toward where the wheel has sent it, a sixth of the way each frame.
export function glide(element, { notch = 0.6 } = {}) {
  let target = element.scrollTop;
  let running = false;
  const most = () => element.scrollHeight - element.clientHeight;
  const step = () => {
    const now = element.scrollTop;
    const next = now + (target - now) * 0.2;
    if (Math.abs(target - next) < 0.5) { element.scrollTop = target; running = false; return; }
    element.scrollTop = next;
    requestAnimationFrame(step);
  };
  element.addEventListener('wheel', (event) => {
    if (most() <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Lines (a wheel set to scroll lines) and pages become pixels; a notch is about a row and a half.
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? element.clientHeight : 1;
    const delta = event.deltaY * unit * (Math.abs(event.deltaY * unit) >= 50 ? notch : 1);
    if (!running) target = element.scrollTop;
    target = Math.min(Math.max(target + delta, 0), most());
    if (!running) { running = true; requestAnimationFrame(step); }
  }, { passive: false });
  // A scroll made some other way (keys, dragging the bar) is where the next glide starts from.
  element.addEventListener('scroll', () => { if (!running) target = element.scrollTop; });
}
