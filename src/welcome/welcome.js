// The welcome's steps (WelcomeStep.all in Welcome.swift), for Windows: where iBaila lives, what it follows, and how
// to make it one's own. Next goes on; the last one's Start closes it for good. Without a license on this PC, a page
// asking for the key comes first (Welcome.swift's key page), and the steps follow it the first time.
const api = window.ibaila;

const signs = {
  // The taskbar, iBaila's icon rising from its corner.
  tray: '<svg viewBox="0 0 24 24"><rect x="2.5" y="15" width="19" height="5.5" rx="1.6"/><circle cx="17.5" cy="17.75" r="1.1"/><path d="M17.5 12V4.5M14.5 7.5l3-3 3 3"/></svg>',
  // A note.
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5.5l11-2.5v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/></svg>',
  // A key.
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M16.5 6.5l2.5 2.5M14 9l2 2"/></svg>',
  // A hand drawing a curve.
  hand: '<svg viewBox="0 0 24 24"><path d="M3 9c2.5-4 6-4 8 0s5.5 4 8 0"/><path d="M9 21v-6.5a1.5 1.5 0 0 1 3 0V17m0-3.5a1.5 1.5 0 0 1 3 0V17m0-2a1.5 1.5 0 0 1 3 0v2.5a4.5 4.5 0 0 1-4.5 4.5h-1.2a4 4 0 0 1-3.1-1.5L6 17.8a1.4 1.4 0 0 1 2.1-1.8L9 17"/></svg>',
};

const steps = [
  { sign: 'tray', title: 'iBaila lives by your clock',
    text: 'Click its icon at the bottom right of your screen for everything: the light, the player, the lyrics, the wallpaper.' },
  { sign: 'note', title: 'Play something',
    text: 'iBaila follows Spotify, Apple Music, YouTube Music and SoundCloud. The icon at the left of the player chooses where you listen.' },
  { sign: 'hand', title: 'Make it yours',
    text: 'Drag the player and the playlist anywhere, and put a video of your own on the desktop in Wallpaper.' },
];

const failures = {
  unknownKey: 'That key isn’t right. Check it against your purchase email.',
  usedElsewhere: 'This key is in use on another computer. Deactivate it there first, in iBaila’s General settings.',
  offline: 'Can’t reach the license server. Check your connection and try again.',
  other: 'Something went wrong. Try again in a moment.',
};

const pages = document.getElementById('pages');
const dots = document.getElementById('dots');
const next = document.getElementById('next');
let page = 0;
let asking = false;   // the key page shows
let working = false;
let welcomed = false;

function build(needsKey) {
  asking = needsKey;
  const keyPage = needsKey ? `<div class="page key"><div class="glow">${signs.key}</div><h1>Welcome to iBaila</h1>
    <p>Enter the license key from your purchase email.</p>
    <input id="key" type="text" placeholder="License key" spellcheck="false" autocomplete="off">
    <p class="failure" id="failure"></p>
    <p class="store">No key yet? <a id="store">Get iBaila</a></p></div>` : '';
  pages.innerHTML = keyPage + steps.map((step) => `<div class="page after"><div class="glow">${signs[step.sign]}</div>
    <h1>${step.title}</h1><p>${step.text}</p></div>`).join('');
  dots.innerHTML = steps.map(() => '<i></i>').join('');
  document.getElementById('store')?.addEventListener('click', () => api.send('open-store'));
  document.getElementById('key')?.addEventListener('input', () => { document.getElementById('failure').textContent = ''; });
  show();
  document.getElementById('key')?.focus();
}

function show() {
  const all = [...pages.querySelectorAll('.page')];
  const at = (asking ? 0 : all.length - steps.length) + page;
  all.forEach((el, i) => { el.classList.toggle('before', i < at); el.classList.toggle('after', i > at); });
  dots.classList.toggle('hidden', asking);
  dots.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i === page));
  next.textContent = asking ? (working ? 'Activating…' : 'Activate') : page + 1 < steps.length ? 'Next' : 'Start';
  next.disabled = working;
}

function finish() {
  document.body.classList.add('leaving');
  setTimeout(() => api.send('welcome-done'), 220);
}

async function activate() {
  const field = document.getElementById('key');
  if (working || !field.value.trim()) { field.focus(); return; }
  working = true;
  show();
  const failure = await api.invoke('license-activate', field.value);
  working = false;
  if (failure) {
    document.getElementById('failure').textContent = failures[failure] || failures.other;
    show();
    field.select();
    return;
  }
  // Active: the steps the first time, else iBaila simply starts.
  if (welcomed) { finish(); return; }
  asking = false;
  page = 0;
  show();
}

next.addEventListener('click', () => {
  if (asking) { activate(); return; }
  if (page + 1 < steps.length) { page += 1; show(); } else finish();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') next.click();
  // Without a key there is nothing to skip to.
  if (event.key === 'Escape' && !asking) finish();
});
api.invoke('welcome-hello').then((hello) => { welcomed = hello.welcomed; build(hello.needsKey); });
