// The glass bar under the cards (PlayerBar.swift): back, play, forward and repeat on the left; the song in the
// middle, a title too long to fit running along on its own, its progress a fine line beneath; lyrics and volume on the
// right, and beside the lyrics the desk cleared of all but iJWA (ClearDesk.swift). No shuffle and no list of songs:
// they took room for little (his call, 2026-10-10).
import { icons } from './icons.js';
import { logos, CHOICES } from './logos.js';

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const format = (seconds) => { const whole = Math.max(0, Math.floor(seconds)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`; };
const nowSeconds = () => performance.timeOrigin / 1000 + performance.now() / 1000;

export function clockSeconds(clock, at = nowSeconds()) {
  if (!clock) return 0;
  return clock.running ? clock.seconds + (at - clock.at) : clock.seconds;
}

function button(name, size, { quiet = false, label = '' } = {}) {
  return `<button class="bar-button${quiet ? ' quiet' : ''}" data-action="${name}" style="--size:${size}" aria-label="${label || name}"><span class="disc"></span><span class="glyph"></span></button>`;
}

export class Bar {
  state = {};
  showsLyrics = false;
  volumeOpen = false;

  constructor(host, actions) {
    this.host = host;
    this.actions = actions;
    host.innerHTML = `
      <div class="bar-glass"></div>
      <div class="bar-left"><button class="source-button" data-action="source"></button>${button('previous', 16)}${button('toggle', 22)}${button('next', 16)}${button('repeat', 13, { quiet: true })}</div>
      <div class="strip">
        <div class="strip-row">
          <button class="cover-button" data-action="open"><span class="cover-art"></span><span class="cover-arrow">${icons.arrowOut}</span></button>
          <div class="strip-texts"><div class="marquee title"><span></span></div><div class="marquee subtitle"><span></span></div></div>
          <div class="time-left"></div>
          <button class="heart" data-action="like" aria-label="Like">${icons.heart}${icons.heartFill}</button>
          <button class="more" data-action="more">${icons.ellipsis}</button>
        </div>
        <div class="progress"><div class="rail"></div><div class="fill"></div></div>
      </div>
      <div class="bar-right">${button('lyrics', 15)}${button('clear', 14, { label: 'Clear the desk' })}<div class="volume"><input type="range" min="0" max="1" step="0.01" value="0.5">${button('volume', 15)}</div></div>
      <div id="source-menu" class="hidden"><div class="menu-glass"></div>${CHOICES.map((c, i) => `<button class="source-row" data-choice="${c.id}" data-delay="${(CHOICES.length - i) * 35}ms">
        <span class="row-logo">${logos[c.id]}</span><span class="name">${c.name}</span><span class="tick">${icons.tick}</span></button>`).join('')}
        <div class="source-divider"></div>
        <button class="source-row" data-choice="" title="Whatever plays: Apple Music, Spotify, YouTube Music, SoundCloud"><span class="row-logo sparkles">${logos.automatic}</span>
        <span class="name">Automatic</span><span class="tick">${icons.tick}</span></button></div>`;
    this.glyph = (action) => host.querySelector(`[data-action="${action}"] .glyph`);
    this.glyph('previous').innerHTML = icons.backward;
    this.glyph('next').innerHTML = icons.forward;
    this.glyph('lyrics').innerHTML = icons.lyrics;
    this.glyph('clear').innerHTML = icons.moon;
    this.glyph('volume').innerHTML = icons.speaker2;
    this.title = host.querySelector('.marquee.title');
    this.subtitle = host.querySelector('.marquee.subtitle');
    this.cover = host.querySelector('.cover-art');
    this.timeLeft = host.querySelector('.time-left');
    this.progress = host.querySelector('.progress');
    this.fill = host.querySelector('.fill');
    this.slider = host.querySelector('.volume input');
    this.heart = host.querySelector('.heart');

    // The places to listen: open from the source button, closed by a choice, a click elsewhere, or the pointer
    // gone from both a moment.
    this.menu = host.querySelector('#source-menu');
    // It stands beside the bar, over the cards, where its glass can frost them.
    host.parentElement?.appendChild(this.menu);
    this.sourceButton = host.querySelector('.source-button');
    this.menu.addEventListener('click', (event) => {
      const row = event.target.closest('[data-choice]');
      if (!row) return;
      event.stopPropagation();
      this.actions.choose(row.dataset.choice || null);
      this.openMenu(false);
    });
    for (const el of [this.menu, this.sourceButton]) {
      el.addEventListener('pointerenter', () => clearTimeout(this.menuClosing));
      el.addEventListener('pointerleave', () => { clearTimeout(this.menuClosing); this.menuClosing = setTimeout(() => this.openMenu(false), 1200); });
    }
    window.addEventListener('pointerdown', (event) => {
      if (this.menuOpen && !event.target.closest('#source-menu, .source-button')) this.openMenu(false);
    }, true);
    host.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'source') { this.openMenu(!this.menuOpen); return; }
      if (action === 'lyrics') { this.showsLyrics = !this.showsLyrics; this.actions.panels(this.showsLyrics); this.paintToggles(); return; }
      if (action === 'volume') { this.toggleVolume(); return; }
      this.actions.control(action);
    });
    this.slider.addEventListener('input', () => {
      this.volumeTouched = true;
      this.paintVolume(Number(this.slider.value));
      clearTimeout(this.pendingVolume);
      this.pendingVolume = setTimeout(() => this.actions.control('volume', Number(this.slider.value)), 80);
    });
    const strip = host.querySelector('.strip');
    strip.addEventListener('pointerenter', () => { this.hovered = true; this.paintTime(); this.timeLeft.classList.add('shown'); this.progress.classList.add('thick'); });
    strip.addEventListener('pointerleave', () => { this.hovered = false; if (this.scrub == null) { this.timeLeft.classList.remove('shown'); this.progress.classList.remove('thick'); } });
    host.addEventListener('pointerenter', () => this.actions.control('read-modes'));
    this.progress.addEventListener('pointerdown', (event) => {
      if (!(this.state.track?.duration > 0)) return;
      this.progress.setPointerCapture(event.pointerId);
      this.dragTo(event);
    });
    this.progress.addEventListener('pointermove', (event) => { if (this.scrub != null) this.dragTo(event); });
    this.progress.addEventListener('pointerup', () => {
      if (this.scrub == null) return;
      const fraction = this.scrub;
      this.scrub = null;
      this.actions.control('seek', fraction);
      if (!this.hovered) { this.timeLeft.classList.remove('shown'); this.progress.classList.remove('thick'); }
      this.paintTime();
    });
    setInterval(() => { if (this.hovered || this.scrub != null) this.paintTime(); }, 1000);
  }

  openMenu(open) {
    this.menuOpen = open;
    clearTimeout(this.menuClosing);
    this.menu.classList.toggle('hidden', !open);
    this.sourceButton.classList.toggle('open', open);
    // Rising one after another, the lowest first; going all at once.
    this.menu.querySelectorAll('.source-row, .source-divider').forEach((row) => { row.style.transitionDelay = open ? row.dataset.delay || '0ms' : '0ms'; });
  }

  /** The bar's left end: the place chosen, else where the song plays; the menu's tick on the choice. */
  paintSource(mark, choice) {
    const key = `${mark?.kind || ''}|${choice || ''}`;
    if (key === this.sourceKey) return;
    this.sourceKey = key;
    this.sourceButton.innerHTML = mark?.kind && logos[mark.kind] ? `<span class="logo">${logos[mark.kind]}</span>` : `<span class="neutral">${icons.waveform}</span>`;
    this.sourceButton.title = choice ? `Listening to ${mark?.name || ''} only` : mark ? `Playing in ${mark.name}` : 'Choose where you listen';
    this.menu.querySelectorAll('[data-choice]').forEach((row) => row.classList.toggle('chosen', (row.dataset.choice || null) === (choice || null)));
  }

  dragTo(event) {
    const r = this.progress.getBoundingClientRect();
    this.scrub = Math.min(Math.max((event.clientX - r.left) / Math.max(r.width, 1), 0), 1);
    this.placeLine();
    this.paintTime();
  }

  /** The lyrics closed from outside: the lists' shelf took the middle. */
  closePanels() {
    if (!this.showsLyrics) return;
    this.showsLyrics = false;
    this.actions.panels(false);
    this.paintToggles();
  }

  update(state) {
    const before = this.state;
    this.state = state;
    this.paintSource(state.mark, state.choice);
    // The page's own loudness changed while the slider is open (moved on the page itself): the slider follows it.
    if (this.volumeOpen && typeof state.volume === 'number' && state.volume !== before?.volume && !this.volumeTouched) {
      this.slider.value = String(state.volume);
      this.paintVolume(state.volume);
    }
    const t = state.track;
    this.glyph('toggle').innerHTML = state.playing ? icons.pause : icons.play;
    this.glyph('repeat').innerHTML = state.repeat === 'one' ? icons.repeatOne : icons.repeat;
    this.host.querySelector('[data-action="repeat"]').classList.toggle('active', state.repeat && state.repeat !== 'off');
    const clear = this.host.querySelector('[data-action="clear"]');
    clear.classList.toggle('active', Boolean(state.isClear));
    clear.title = state.isClear ? 'Bring everything back' : 'Clear the desk';
    const title = t?.title || 'Not Playing';
    const subtitle = !t?.artist ? (t ? '' : 'Play something in Spotify or Apple Music') : t.album ? `${t.artist} — ${t.album}` : t.artist;
    if (title !== before.track?.title || subtitle !== this.subtitleText) {
      this.subtitleText = subtitle;
      this.title.firstChild.textContent = title;
      this.subtitle.firstChild.textContent = subtitle;
      requestAnimationFrame(() => { this.marquee(this.title); this.marquee(this.subtitle); });
    }
    this.title.classList.toggle('running', Boolean(state.playing));
    this.subtitle.classList.toggle('running', Boolean(state.playing));
    if (state.artwork !== before.artwork) this.cover.innerHTML = state.artwork ? `<img src="${escape(state.artwork)}" draggable="false">` : `<span class="no-art">${icons.note}</span>`;
    this.host.style.setProperty('--glow', state.glow || 'rgba(255,255,255,0.7)');
    this.paintLike(before);
    this.paintToggles();
    this.restartLine();
  }

  /** The heart (PlayerBar's LikeButton): there where the song can be liked, filled in its color when it is, beating
   *  once as it fills. */
  paintLike(before) {
    const heart = this.heart;
    heart.classList.toggle('shown', Boolean(this.state.canLike));
    heart.classList.toggle('liked', Boolean(this.state.liked));
    heart.setAttribute('aria-label', this.state.liked ? 'Liked' : 'Like');
    heart.title = this.state.liked ? 'Liked' : 'Like';
    if (this.state.liked && !before?.liked && before?.track?.id === this.state.track?.id) {
      heart.classList.remove('beat');
      void heart.offsetWidth;
      heart.classList.add('beat');
    }
  }

  tintLike(color) { this.host.style.setProperty('--like', color); }

  paintToggles() {
    this.host.querySelector('[data-action="lyrics"]').classList.toggle('active', this.showsLyrics);
    this.host.querySelector('[data-action="volume"]').classList.toggle('active', this.volumeOpen);
  }

  /** A title too long to fit runs along on its own, twice over with a gap, while the song plays. */
  marquee(box) {
    const span = box.firstChild;
    box.querySelectorAll('.copy').forEach((c) => c.remove());
    box.classList.remove('overflowing');
    const overflow = span.scrollWidth - box.clientWidth;
    if (overflow <= 1) return;
    const copy = span.cloneNode(true);
    copy.classList.add('copy');
    box.appendChild(copy);
    box.classList.add('overflowing');
    box.style.setProperty('--travel', `${span.scrollWidth + 40}px`);
    box.style.setProperty('--duration', `${(span.scrollWidth + 40) / 30}s`);
  }

  async toggleVolume() {
    this.volumeOpen = !this.volumeOpen;
    this.host.querySelector('.volume').classList.toggle('open', this.volumeOpen);
    this.paintToggles();
    if (this.volumeOpen) {
      this.volumeTouched = false;
      const reading = await this.actions.readVolume();
      if (reading != null && !this.volumeTouched) { this.slider.value = String(reading); this.paintVolume(reading); }
    }
  }

  paintVolume(value) {
    this.glyph('volume').innerHTML = value < 0.01 ? icons.speaker0 : value < 0.5 ? icons.speaker1 : icons.speaker2;
    this.slider.style.setProperty('--fill', `${value * 100}%`);
  }

  fraction() {
    const duration = this.state.track?.duration || 0;
    if (this.scrub != null) return this.scrub;
    return duration > 0 ? Math.min(Math.max(clockSeconds(this.state.clock) / duration, 0), 1) : 0;
  }

  placeLine() { const f = this.fraction(); this.fill.style.transform = `scaleX(${Math.max(f, 0.0001)})`; return f; }

  /** The line only moves when it would move by a whole pixel (every 0.25 to 1 s), and stops while paused. */
  restartLine() {
    clearTimeout(this.ticker);
    if (this.scrub != null) return;
    const fraction = this.placeLine();
    const duration = this.state.track?.duration || 0;
    if (!this.state.clock?.running || !(duration > 0) || fraction >= 1 || document.hidden) return;
    const pixels = Math.max(this.progress.clientWidth * devicePixelRatio, 1);
    const interval = Math.min(Math.max(duration / pixels, 0.25), 1) * 1000;
    const tick = () => { if (this.placeLine() < 1) this.ticker = setTimeout(tick, interval); };
    this.ticker = setTimeout(tick, interval);
  }

  paintTime() {
    const duration = this.state.track?.duration || 0;
    if (!(duration > 0)) { this.timeLeft.textContent = '--:--'; return; }
    this.timeLeft.textContent = this.scrub != null ? format(this.scrub * duration) : '-' + format(Math.max(duration - clockSeconds(this.state.clock), 0));
    this.timeLeft.classList.toggle('scrubbing', this.scrub != null);
  }
}

/** The player made small (MiniBar.swift): the song's cover, its name and artist, back, play and forward, on one
 *  capsule of glass where the bar was; the arrows at its end bring the whole player back. */
export class MiniBar {
  constructor(host, actions) {
    this.host = host;
    this.actions = actions;
    host.innerHTML = `<div class="bar-glass"></div>
      <div class="mini-art"></div>
      <div class="mini-texts"><div class="marquee title"><span></span></div><div class="marquee subtitle"><span></span></div></div>
      <div class="mini-buttons">${button('previous', 13)}${button('toggle', 17)}${button('next', 13)}</div>
      ${button('expand', 12, { quiet: true })}`;
    host.querySelector('[data-action="previous"] .glyph').innerHTML = icons.backward;
    host.querySelector('[data-action="next"] .glyph').innerHTML = icons.forward;
    host.querySelector('[data-action="expand"] .glyph').innerHTML = icons.expand;
    host.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'expand') actions.expand();
      else if (action) actions.control(action);
    });
    this.state = {};
  }

  update(state) {
    const before = this.state;
    this.state = state;
    this.host.querySelector('[data-action="toggle"] .glyph').innerHTML = state.playing ? icons.pause : icons.play;
    if (state.artwork !== before.artwork) this.host.querySelector('.mini-art').innerHTML = state.artwork ? `<img src="${escape(state.artwork)}" draggable="false">` : icons.note;
    const title = this.host.querySelector('.marquee.title'), subtitle = this.host.querySelector('.marquee.subtitle');
    const t = state.track?.title || 'Not Playing', a = state.track?.artist || '';
    if (t !== title.firstChild.textContent || a !== subtitle.firstChild.textContent) {
      title.firstChild.textContent = t;
      subtitle.firstChild.textContent = a;
      requestAnimationFrame(() => { Bar.prototype.marquee(title); Bar.prototype.marquee(subtitle); });
    }
    title.classList.toggle('running', Boolean(state.playing));
    subtitle.classList.toggle('running', Boolean(state.playing));
  }
}
