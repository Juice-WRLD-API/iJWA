// Music playing in two places at once (SourceChooser.swift): each player with its mark, its name and its song. The one
// picked plays on and iJWA follows it; the others pause. "Keep all playing" leaves them be.
import { logos } from '../desktop/logos.js';

const api = window.ijwa;
const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const panel = document.getElementById('panel');

function show(players) {
  if (!players?.length) { panel.classList.add('hidden'); return; }
  panel.querySelector('.head b').textContent = players.length === 2 ? 'Music is playing in two places' : `Music is playing in ${players.length} places`;
  document.getElementById('tiles').innerHTML = players.map((p) => `<button class="tile" data-app="${escape(p.app)}">
    <span class="logo">${logos[p.kind] || logos.browser}</span><b>${escape(p.name)}</b>
    <span class="song">${escape(p.title)}</span><span class="artist">${escape(p.artist)}</span></button>`).join('');
  requestAnimationFrame(() => {
    panel.classList.remove('hidden');
    const r = panel.getBoundingClientRect();
    api.send('chooser-size', { width: Math.ceil(r.width) + 40, height: Math.ceil(r.height) + 40 });
  });
}

document.getElementById('tiles').addEventListener('click', (event) => {
  const tile = event.target.closest('[data-app]');
  if (tile) api.send('chooser-keep', tile.dataset.app);
});
document.getElementById('keep-all').addEventListener('click', () => api.send('chooser-keep', null));
api.listen('chooser-players', show);
api.invoke('chooser-hello').then(show);
