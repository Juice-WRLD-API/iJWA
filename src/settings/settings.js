// The settings (SettingsPanel.swift). Every change reaches the app at once; the groups open one at a time so the
// panel never grows past the screen, and the one left open is open next time.
import { beatOf, hsbToRgb } from '../light/engine.js';
import { FACES } from '../desktop/wordblock.js';
import { lyricLookOf, lyricFontFor } from '../desktop/lyriclooks.js';
import { lookOf, PLACES } from '../light/looks.js';

const api = window.ibaila;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let style = null;
let hello = null;

// ---- reading and writing a setting by its path ("desktop.size") ----

const valueOf = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), style);
function change(path, value) {
  const keys = path.split('.');
  const patch = keys.reduceRight((inner, key) => ({ [key]: inner }), value);
  // Kept here too, so what depends on it shows at once.
  let o = style;
  keys.slice(0, -1).forEach((k) => { o[k] = { ...(o[k] || {}) }; o = o[k]; });
  o[keys[keys.length - 1]] = value;
  api.setStyle(patch);
  refresh();
}

// ---- the parts ----

const icon = (paths) => `<svg viewBox="0 0 24 24">${paths}</svg>`;
const ICONS = {
  light: icon('<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
  colors: icon('<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-1.1-.9-1.5-.9-2.6 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'),
  desktop: icon('<rect x="4" y="7" width="16" height="11" rx="2"/><path d="M7 4h10"/>'),
  wallpaper: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.5 4.5 2.5-4.5 2.5z"/>'),
  lyrics: icon('<path d="M4 6h16v10H9l-4 3.5V16H4z"/><path d="M8 10h8M8 13h5"/>'),
  clock: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  playlist: icon('<path d="M4 6h12M4 11h12M4 16h7"/><circle cx="17.5" cy="16.5" r="2.5"/><path d="M20 16.5V9"/>'),
  displays: icon('<rect x="2.5" y="5" width="12" height="9" rx="1.5"/><rect x="9.5" y="9" width="12" height="9" rx="1.5"/>'),
  general: icon('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  // The taskbar's corner, its icon in a ring.
  tray: icon('<path d="M3 18.5h18"/><circle cx="16" cy="12" r="3.6"/><circle cx="16" cy="12" r="1.2"/><path d="M5 15l2-2 2 2"/>'),
};
const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>';
const MONITOR = '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" class="mark"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

const toggle = (key) => `<label class="switch"><input type="checkbox" data-key="${key}"><i></i></label>`;
const toggleRow = (title, key) => `<div class="line"><span class="grow">${title}</span>${toggle(key)}</div>`;
const slider = (title, key, min = 0, max = 1) => `<div class="slider"><span class="name">${title}</span><input type="range" min="${min}" max="${max}" step="0.01" data-key="${key}"></div>`;
const segments = (title, key, choices) => `<div class="picker"><span>${title}</span><div class="segments" data-key="${key}">${
  choices.map(([value, label]) => `<button data-value='${JSON.stringify(value)}'>${label}</button>`).join('')}</div></div>`;
/** A titled block with its own switch: its settings show only while it is on (or always, with `keeps`). */
const block = (title, key, inside, keeps = false) => `<div class="block${keeps ? ' keeps' : ''}" data-switch="${key}">
  <div class="top"><span class="label">${title}</span>${toggle(key)}</div><div class="inside">${inside}</div></div>`;
const lockRow = (key, which) => `<div class="line"><span>Lock position</span>${toggle(key)}<span class="grow"></span>
  <button class="button" data-action="reset" data-which="${which}">Reset Position</button></div>`;

function groups() {
  return [
    ['light', 'Light', block('Edge Light', 'isOn', `
      <div class="line"><span class="grow">Light</span>
        <button class="button" data-action="choose-light"><span id="light-name"></span> ${CHEVRON}</button></div>
      ${segments('Place', 'place', PLACES.map((p) => [p.id, p.title]))}
      ${toggleRow('Only on the desktop', 'onlyOnDesktop')}
      ${segments('Animation', 'motion', [['flow', 'Flow'], ['still', 'Still'], ['music', 'Music Sync']])}
      <div class="music" data-show="music">
        <div class="line"><span class="label grow">Music</span><div class="meter">${'<i></i>'.repeat(14)}</div></div>
        ${slider('Sensitivity', 'sensitivity')}${slider('Reaction', 'reaction')}${slider('Smoothness', 'smoothness')}
      </div>
      <div data-still-dims>${slider('Tail Length', 'tailLength')}</div>
      ${slider('Thickness', 'thickness')}${slider('Glow', 'glow')}
      <div data-still-dims>${slider('Particles', 'particles')}</div>`)],
    ['colors', 'Colors', `
      ${segments('Colors', 'twoColors', [[false, '1 Color'], [true, '2 Colors']])}
      ${toggleRow('Use artwork colors', 'useArtworkColors')}
      <div class="wheels">${wheel('Primary', 'primary')}${wheel('Secondary', 'secondary')}</div>`],
    ['desktop', 'Desktop', block('Desktop Player', 'desktop.isOn', `
      ${slider('Size', 'desktop.size')}${slider('Tilt', 'desktop.tilt')}${slider('Glass Brightness', 'desktop.glassBrightness')}${slider('Frost', 'desktop.frost')}
      ${segments('Albums each side', 'desktop.sideCards', [[1, '1'], [2, '2'], [3, '3']])}
      ${lockRow('desktop.locked', 'desktop')}`)],
    ['wallpaper', 'Wallpaper', `
      ${block('Live Wallpaper', 'wallpaper.isOn', `
        <p class="note">While a song plays, the desktop shows its music video, its album's moving cover or its artist's video from Apple Music. Songs without one keep your desktop video or wallpaper.</p>
        <div class="storage"><div class="grow"><div>Saved videos</div><div class="note">Up to 500 MB, oldest go first</div></div>
          <span class="size" id="clip-size"></span><button class="button" data-action="clear-clips">Clear</button></div>`)}
      ${block('Desktop Video', 'wallpaper.videoIsOn', `
        <p class="note">A video of your own on the desktop, playing without sound. A song's video comes over it, and it comes back when the song pauses.</p>
        <div class="video"><div class="thumb" id="video-thumb">${icon('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v12M17 6v12"/>')}</div>
          <span class="name" id="video-name"></span><button class="button" data-action="choose-video">Choose…</button></div>`, true)}
      <div data-show="dim">${slider('Dim', 'wallpaper.darkness')}</div>`],
    ['lyrics', 'Lyrics', `<div class="line"><span class="grow">Style</span>
        <button class="button" data-action="choose-lyrics"><span id="lyrics-look-name"></span> ${CHEVRON}</button></div>
      <span class="label" id="lyrics-font-label">Font</span><div class="fonts">${FACES.map((f) =>
      `<button data-font="${f.key}" style='font: ${f.css.replace('{size}', '17')}'>${escape(f.name)}</button>`).join('')}</div>`],
    ['clock', 'Clock', block('Desktop Clock', 'clock.isOn', `
      ${slider('Size', 'clock.size')}${slider('Height', 'clock.stretch')}${slider('Weight', 'clock.weight')}${slider('Glass Color', 'clock.tint')}
      ${toggleRow('Artwork color', 'clock.useArtworkColor')}${toggleRow('Show date', 'clock.showDate')}
      ${lockRow('clock.locked', 'clock')}`)],
    ['playlist', 'Playlist', block('Desktop Playlist', 'playlist.isOn', `
      ${segments('Side', 'playlist.side', [['left', 'Left'], ['right', 'Right']])}
      ${slider('Tilt', 'playlist.tilt')}${slider('Size', 'playlist.size')}
      ${segments('Songs shown', 'playlist.rows', [[4, '4'], [6, '6'], [8, '8'], [10, '10'], [12, '12']])}
      ${lockRow('playlist.locked', 'playlist')}`)],
    ['tray', 'Tray Icon', block('Artwork Icon', 'tray.artworkIcon', `
      ${segments('Shape', 'tray.shape', [['rounded', 'Rounded'], ['circle', 'Circle']])}
      ${toggleRow('Light ring', 'tray.ring')}
      <div data-show="ring">${slider('Ring Thickness', 'tray.ringThickness')}${slider('Ring Glow', 'tray.ringGlow')}
        ${toggleRow('Pulse with the beat', 'tray.ringPulse')}
        <p class="note" data-show="pulse-note">Beats are heard while the light is set to Music Sync.</p></div>`)],
    ['displays', 'Displays', `<p class="note">iBaila lives on the displays you choose: the light and the live wallpaper go with it.</p>
      <div id="displays" style="display:flex;flex-direction:column;gap:8px"></div>`],
    ['general', 'General', `
      <span class="label">Energy</span>
      ${toggleRow('Save energy on battery', 'energy.saveOnBattery')}
      ${toggleRow('Hold still in Energy saver', 'energy.stillInLowPower')}
      ${toggleRow('Rest when I’m away', 'energy.restWhenAway')}
      ${toggleRow('Step aside in full-screen apps', 'energy.hideInFullScreen')}
      ${toggleRow('Optimized mode', 'energy.optimize')}
      <p class="note">Uses less memory: the light is drawn at a lower resolution, fewer covers are kept and live wallpapers play smaller videos.</p>
      <hr style="margin:2px 0">
      <div class="line"><span class="grow">Start with Windows</span><label class="switch"><input type="checkbox" id="login"><i></i></label></div>
      <hr style="margin:2px 0">
      <div class="line"><span class="grow">Browser Extension<span class="note" style="display:block" id="extension-note"></span></span>
        <button class="button" data-action="install-extension" id="extension-install">Install…</button></div>
      <p class="note" id="extension-steps" hidden></p>
      ${hello?.licensed ? `<hr style="margin:2px 0">
      <div class="line"><span class="grow">License<span class="note" style="display:block">Active on this PC</span></span>
        <button class="button" data-action="license-move">Deactivate…</button></div>` : ''}
      <hr style="margin:2px 0">
      <div class="foot"><span class="version" id="version"></span><button class="button" data-action="check-updates">Check for Updates…</button></div>
      <div class="foot"><span></span><button class="button" data-action="quit">Quit iBaila</button></div>`],
  ];
}

function wheel(title, key) {
  return `<div class="wheel" data-wheel="${key}"><span class="label">${title}</span>
    <div class="disc"><canvas width="248" height="248"></canvas><div class="knob"></div></div>
    <div class="bright"><span>☼</span><input type="range" min="0.1" max="1" step="0.01" data-bright="${key}"><span style="font-size:13px">☀</span></div></div>`;
}

// ---- building the panel ----

function build() {
  const open = (() => { try { return localStorage.getItem('openGroup') ?? 'light'; } catch { return 'light'; } })();
  $('#groups').innerHTML = groups().map(([id, title, body]) => `<div class="group${id === open ? ' open' : ''}" data-group="${id}">
    <button class="head"><span class="icon">${ICONS[id]}</span><span class="title">${title}</span><span class="chevron">${CHEVRON}</span></button>
    <div class="body">${body}</div></div>`).join('');
  $$('.wheel canvas').forEach(drawDisc);
  drawDisplays();
}

/** The hue and saturation disc: hue clockwise from three o'clock, saturation climbing quickly away from the white middle. */
function drawDisc(canvas) {
  const g = canvas.getContext('2d');
  const side = canvas.width, r = side / 2;
  const image = g.createImageData(side, side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const dx = x - r, dy = y - r, d = Math.hypot(dx, dy) / r;
    const i = (y * side + x) * 4;
    if (d > 1) { image.data[i + 3] = 0; continue; }
    let hue = Math.atan2(dy, dx) / (2 * Math.PI); if (hue < 0) hue += 1;
    const [cr, cg, cb] = hsbToRgb({ hue, saturation: Math.pow(d, 0.55), brightness: 1 });
    image.data[i] = cr * 255; image.data[i + 1] = cg * 255; image.data[i + 2] = cb * 255;
    image.data[i + 3] = d > 0.985 ? (1 - d) / 0.015 * 255 : 255;
  }
  g.putImageData(image, 0, 0);
}

function drawDisplays() {
  const host = $('#displays');
  if (!host || !hello) return;
  const hidden = new Set(style?.hiddenDisplays || []);
  host.innerHTML = hello.displays.map((d) => `<button class="display${hidden.has(d.label) ? '' : ' on'}" data-display="${escape(d.label)}">
    ${MONITOR}<span class="grow" style="text-align:left">${escape(d.label)}</span>${CHECK}</button>`).join('');
}

/** Every control shows the setting it stands for. */
function refresh() {
  if (!style) return;
  for (const input of $$('input[data-key]')) {
    const value = valueOf(input.dataset.key);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (document.activeElement !== input || !input.matches(':active')) input.value = String(value ?? 0);
    if (input.type === 'range') input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  }
  for (const group of $$('.segments')) {
    const value = valueOf(group.dataset.key);
    for (const b of $$('button', group)) b.classList.toggle('on', JSON.stringify(value) === b.dataset.value);
  }
  for (const b of $$('.block')) b.classList.toggle('off', !valueOf(b.dataset.switch));
  const lightName = $('#light-name');
  if (lightName) lightName.textContent = lookOf(style.look).title;
  $$('[data-show="music"]').forEach((el) => el.classList.toggle('hidden', style.motion !== 'music'));
  $$('[data-still-dims]').forEach((el) => { el.style.opacity = style.motion === 'still' ? 0.4 : 1; el.style.pointerEvents = style.motion === 'still' ? 'none' : ''; });
  $$('[data-show="ring"]').forEach((el) => el.classList.toggle('hidden', style.tray?.ring === false));
  $$('[data-show="pulse-note"]').forEach((el) => el.classList.toggle('hidden', !(style.tray?.ringPulse !== false && style.motion !== 'music')));
  $$('[data-show="dim"]').forEach((el) => el.classList.toggle('hidden', !(style.wallpaper?.isOn || style.wallpaper?.videoIsOn)));
  $('#hidden-player').classList.toggle('hidden', !(style.isEnabled && style.desktop && !style.desktop.isOn));
  for (const w of $$('.wheel')) {
    const color = valueOf(w.dataset.wheel);
    const knob = $('.knob', w);
    const angle = color.hue * 2 * Math.PI, distance = Math.pow(color.saturation, 1 / 0.55) * 62;
    knob.style.left = `${62 + Math.cos(angle) * distance}px`; knob.style.top = `${62 + Math.sin(angle) * distance}px`;
    knob.style.background = `rgb(${hsbToRgb(color).map((v) => Math.round(v * 255)).join(',')})`;
    $('canvas', w).style.filter = `brightness(${color.brightness})`;
    const bright = $('[data-bright]', w);
    if (!bright.matches(':active')) bright.value = color.brightness;
    bright.style.setProperty('--fill', `${((bright.value - 0.1) / 0.9) * 100}%`);
    if (w.dataset.wheel === 'secondary') w.classList.toggle('dimmed', !style.twoColors);
  }
  // Each style keeps its own face.
  const look = lyricLookOf(style.desktop?.lyricsLook);
  const face = lyricFontFor(style.desktop, look.id);
  if ($('#lyrics-look-name')) $('#lyrics-look-name').textContent = look.title;
  if ($('#lyrics-font-label')) $('#lyrics-font-label').textContent = `Font for ${look.title}`;
  $$('[data-font]').forEach((b) => b.classList.toggle('on', b.dataset.font === face));
  const video = style.wallpaper?.video;
  const name = $('#video-name');
  if (name) {
    name.textContent = video ? video.split('/').pop() : 'No video yet';
    name.classList.toggle('none', !video);
    const thumb = $('#video-thumb');
    if (video && thumb.dataset.video !== video) {
      thumb.dataset.video = video;
      thumb.innerHTML = `<video muted preload="metadata" src="ibaila://app/desktop-video/${video.split('/').map(encodeURIComponent).join('/')}#t=1"></video>`;
    }
  }
  drawDisplays();
}

// ---- what the controls do ----

document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.dataset.key && input.type === 'range') change(input.dataset.key, Number(input.value));
  if (input.dataset.bright) change(input.dataset.bright, { ...valueOf(input.dataset.bright), brightness: Number(input.value) });
});
document.addEventListener('change', (event) => {
  const input = event.target;
  if (input.dataset.key && input.type === 'checkbox') {
    change(input.dataset.key, input.checked);
    // Switched on with no video yet: choosing one is the next thing to do.
    if (input.dataset.key === 'wallpaper.videoIsOn' && input.checked && !style.wallpaper.video) chooseVideo();
  }
  if (input.id === 'login') api.invoke('login-item', input.checked);
});
document.addEventListener('click', async (event) => {
  const head = event.target.closest('.group > .head');
  if (head) {
    const group = head.parentElement;
    const opening = !group.classList.contains('open');
    $$('.group').forEach((g) => g.classList.remove('open'));
    if (opening) group.classList.add('open');
    try { localStorage.setItem('openGroup', opening ? group.dataset.group : ''); } catch { /* not kept */ }
    return;
  }
  const segment = event.target.closest('.segments button');
  if (segment) { change(segment.parentElement.dataset.key, JSON.parse(segment.dataset.value)); return; }
  const font = event.target.closest('[data-font]');
  if (font) {
    const look = lyricLookOf(style.desktop?.lyricsLook).id;
    change('desktop.lyricsFonts', { ...(style.desktop?.lyricsFonts || {}), [look]: font.dataset.font });
    return;
  }
  const display = event.target.closest('[data-display]');
  if (display) {
    const hidden = new Set(style.hiddenDisplays || []);
    const name = display.dataset.display;
    if (hidden.has(name)) hidden.delete(name); else hidden.add(name);
    change('hiddenDisplays', [...hidden]);
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'show-player') change('desktop.isOn', true);
  if (action === 'choose-light') api.send('open-light-picker');
  if (action === 'choose-lyrics') api.send('open-lyric-picker');
  if (action === 'reset') api.send('reset-position', event.target.closest('[data-action]').dataset.which);
  if (action === 'choose-video') chooseVideo();
  if (action === 'clear-clips') { const { bytes } = await api.invoke('wall-clear'); showStorage(bytes); }
  if (action === 'quit') api.send('quit');
  if (action === 'close') api.send('settings-close');
  if (action === 'license-move') api.send('license-move');
  if (action === 'check-updates') api.send('check-updates');
  if (action === 'install-extension') {
    const { page } = await api.invoke('install-extension');
    const steps = $('#extension-steps');
    steps.textContent = `Two steps in your browser: paste ${page} in the address bar (it's copied) and turn on Developer mode, then drag the “Browser Extension” folder that just opened onto that page.`;
    steps.hidden = false;
  }
});

async function chooseVideo() {
  const name = await api.invoke('wall-choose-video');
  if (name) { style.wallpaper = { ...style.wallpaper, video: name, videoIsOn: true }; refresh(); }
}

// Dragging on a color wheel picks the color under the pointer.
document.addEventListener('pointerdown', (event) => {
  const disc = event.target.closest('.wheel .disc');
  if (!disc) return;
  const key = disc.parentElement.dataset.wheel;
  const pick = (e) => {
    const box = disc.getBoundingClientRect();
    const dx = e.clientX - box.left - box.width / 2, dy = e.clientY - box.top - box.height / 2;
    let hue = Math.atan2(dy, dx) / (2 * Math.PI); if (hue < 0) hue += 1;
    const saturation = Math.pow(Math.min(Math.hypot(dx, dy) / (box.width / 2), 1), 0.55);
    change(key, { hue, saturation, brightness: valueOf(key).brightness });
  };
  disc.setPointerCapture(event.pointerId);
  pick(event);
  const move = (e) => pick(e);
  disc.addEventListener('pointermove', move);
  disc.addEventListener('pointerup', () => disc.removeEventListener('pointermove', move), { once: true });
});

function showStorage(bytes) {
  const size = $('#clip-size');
  if (!size) return;
  size.textContent = bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  const clear = $('[data-action="clear-clips"]');
  if (clear) clear.disabled = bytes === 0;
}

// The meter jumps with every beat the light hears, after the user's sensitivity, in the light's own colors.
const lit = { value: 0 };
api.onMeter?.((meter) => {
  if (!style || style.motion !== 'music') return;
  lit.value = beatOf(style, meter.punch || 0) * 14;
});
(function drawMeter() {
  requestAnimationFrame(drawMeter);
  const bars = $$('.meter i');
  if (!bars.length || !style) return;
  const from = hsbToRgb(style.primary), to = style.twoColors ? hsbToRgb(style.secondary) : from;
  bars.forEach((bar, i) => {
    const t = i / (bars.length - 1);
    const rgb = from.map((v, k) => Math.round((v + (to[k] - v) * t) * 255));
    bar.style.background = i < lit.value ? `rgb(${rgb.join(',')})` : '';
  });
  lit.value *= 0.9;
})();

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') api.send('settings-close'); });

/** Which browsers have the extension now: "On in Chrome", or what it does for someone who hasn't added it. */
function showExtension(browsers) {
  const note = $('#extension-note');
  if (!note) return;
  const names = { chrome: 'Chrome', edge: 'Edge', opera: 'Opera', brave: 'Brave', vivaldi: 'Vivaldi' };
  note.textContent = browsers.length ? `On in ${browsers.map((b) => names[b] || b).join(' and ')}`
    : 'Plays YouTube Music, SoundCloud and Spotify in your open tab';
  // Added: nothing more to do.
  const install = $('#extension-install');
  if (install) install.hidden = browsers.length > 0;
  if (browsers.length && $('#extension-steps')) $('#extension-steps').hidden = true;
}
api.listen('extension-browsers', showExtension);
api.listen('settings-leaving', () => $('#panel').classList.add('leaving'));
api.listen('settings-arriving', () => { const p = $('#panel'); p.classList.remove('leaving'); p.style.animation = 'none'; void p.offsetWidth; p.style.animation = ''; });
api.onStyle((next) => { style = next; refresh(); });

api.invoke('settings-hello').then((first) => {
  hello = first;
  style = first.style;
  if (first.accent) {
    document.documentElement.style.setProperty('--accent', first.accent);
    // Dark ink on a light accent, white on a dark one.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(first.accent.slice(i, i + 2), 16));
    document.documentElement.style.setProperty('--accent-ink', 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0b0b0c' : '#ffffff');
  }
  build();
  refresh();
  $('#login').checked = first.openAtLogin;
  showExtension(first.extension || []);
  $('#version').textContent = `Version ${first.version}`;
  showStorage(first.clipBytes);
});
