// The welcome's steps (WelcomeStep.all in Welcome.swift), for Windows: where iJWA lives, what it follows, and how
// to make it one's own. Next goes on; the last one's Start closes it for good.
const api = window.ijwa;

const signs = {
  // The taskbar, iJWA's icon rising from its corner.
  tray: '<svg viewBox="0 0 24 24"><rect x="2.5" y="15" width="19" height="5.5" rx="1.6"/><circle cx="17.5" cy="17.75" r="1.1"/><path d="M17.5 12V4.5M14.5 7.5l3-3 3 3"/></svg>',
  // A note.
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5.5l11-2.5v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/></svg>',
  // A hand drawing a curve.
  hand: '<svg viewBox="0 0 24 24"><path d="M3 9c2.5-4 6-4 8 0s5.5 4 8 0"/><path d="M9 21v-6.5a1.5 1.5 0 0 1 3 0V17m0-3.5a1.5 1.5 0 0 1 3 0V17m0-2a1.5 1.5 0 0 1 3 0v2.5a4.5 4.5 0 0 1-4.5 4.5h-1.2a4 4 0 0 1-3.1-1.5L6 17.8a1.4 1.4 0 0 1 2.1-1.8L9 17"/></svg>',
};

const steps = [
  { sign: 'tray', title: 'iJWA lives by your clock',
    text: 'Click its icon at the bottom right of your screen for everything: the light, the player, the lyrics, the wallpaper.' },
  { sign: 'note', title: 'Play something',
    text: 'iJWA follows Spotify, Apple Music, YouTube Music and SoundCloud. The icon at the left of the player chooses where you listen.' },
  { sign: 'hand', title: 'Make it yours',
    text: 'Drag the player and the playlist anywhere, and put a video of your own on the desktop in Wallpaper.' },
];

const pages = document.getElementById('pages');
const dots = document.getElementById('dots');
const next = document.getElementById('next');
let page = 0;

function build() {
  pages.innerHTML = steps.map((step) => `<div class="page after"><div class="glow">${signs[step.sign]}</div>
    <h1>${step.title}</h1><p>${step.text}</p></div>`).join('');
  dots.innerHTML = steps.map(() => '<i></i>').join('');
  show();
}

function show() {
  const all = [...pages.querySelectorAll('.page')];
  all.forEach((el, i) => { el.classList.toggle('before', i < page); el.classList.toggle('after', i > page); });
  dots.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i === page));
  next.textContent = page + 1 < steps.length ? 'Next' : 'Start';
}

function finish() {
  document.body.classList.add('leaving');
  setTimeout(() => api.send('welcome-done'), 220);
}

next.addEventListener('click', () => {
  if (page + 1 < steps.length) { page += 1; show(); } else finish();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') next.click();
  if (event.key === 'Escape') finish();
});
build();
