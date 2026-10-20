// Genius's songs for the song playing, in a list that scrolls, and a search of the user's own words above them,
// searched as it's typed (LyricsSearchMenu.swift; his ask, 2026-10-12: "yazdıkça arayamaz mı"): once the typing stops
// for 0.4 s, so a word typed asks Genius once, not once a letter; a search overtaken by more typing is dropped, and one
// made before is answered from memory. The songs found stay in sight while the next search runs.
const api = window.ijwa;
const $ = (s) => document.querySelector(s);
const field = $('#asked'), list = $('#list'), busy = $('#busy');
let first = '';
let hits = null;
const made = new Map();
let turn = 0;
let wait = 0;

const plain = (text) => text.trim().toLowerCase();
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function draw() {
  busy.classList.add('gone');
  if (!hits) { list.innerHTML = '<div class="spinner"></div>'; return; }
  if (!hits.length) { list.innerHTML = '<div class="none">Nothing found. Try the name the way Genius might write it.</div>'; return; }
  list.innerHTML = hits.map((hit, i) => `<button class="hit" data-i="${i}"><b>${escape(hit.title)}</b><span>${escape(hit.artist)}</span></button>`).join('');
}

async function look(text, now) {
  const key = plain(text);
  if (made.has(key)) { hits = made.get(key); draw(); return; }
  if (key.length < 2 && key !== plain(first)) return;
  const mine = ++turn;
  if (!now) {
    await new Promise((done) => { clearTimeout(wait); wait = setTimeout(done, 400); });
    if (mine !== turn) return;
  }
  if (hits) busy.classList.remove('gone');
  const found = await api.invoke('lyrics-search', key === plain(first) && !made.size ? null : text.trim());
  if (mine !== turn || !found) { if (mine === turn) busy.classList.add('gone'); return; }
  made.set(key, found);
  hits = found;
  draw();
}

api.listen('lyrics-search-open', (asked) => {
  first = asked || '';
  field.value = first;
  hits = null; made.clear(); turn++;
  draw();
  look(first, true);
  field.focus();
  field.select();
});
field.addEventListener('input', () => look(field.value, false));
field.addEventListener('keydown', (event) => { if (event.key === 'Escape') api.send('lyrics-search-close'); });
list.addEventListener('click', (event) => {
  const i = event.target.closest('.hit')?.dataset.i;
  if (i != null && hits?.[i]) api.send('lyrics-search-pick', hits[i].url);
});
$('#close').addEventListener('click', () => api.send('lyrics-search-close'));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') api.send('lyrics-search-close'); });
