// The song playing, standing out of its list as a lens of glass (PlayingGlass.swift, one for one): a frosted pane with
// the song on it, magnified a touch as through a lens; light pooling at its top middle and caught all along its top
// edge; a finer line of light just inside; a glow in the song's colors along its foot; and eighteen slices of glass
// behind it, each at its own depth and each a little wider than the one before, so the glass swells out evenly on every
// side like a dome. It comes straight out toward you, centered, and its shadow falls on the list under it.
//
// Built the first time its row plays, and only for the one song playing. Used by the album beside the player
// (desktop.js) and the artist page (artist.js).

/** How far the glass comes out toward you, and how much the song under it is magnified. */
const LIFT = 10;
const MAGNIFY = 1.025;
/** The glass's thickness, the slices it's built of, and how far its dome swells out beyond the pane, all round. */
const DEPTH = 18;
const SLICES = 18;
const SWELL = 5;
/** Where the row puts its cover and words, so the glass takes the song over from the row in the very same place. */
const LAYOUT = { padding: 10, cover: 40, gap: 12, coverRadius: 7, titleSize: 13.5, lineSize: 11.5 };

const RISE = 'cubic-bezier(0.3, 1.4, 0.5, 1)';
const EASE_IN = 'cubic-bezier(0.42, 0, 1, 1)';
const STYLE = `
.pg-row { position: relative; }
.pg-row > :not(.pg) { transition: opacity 0.2s ease-out 0.14s; }
.pg-row.pg-up > :not(.pg) { opacity: 0; transition: opacity 0.18s ease-out; }
.pg-row.pg-up { z-index: 2; background: transparent !important; box-shadow: none !important; }
.pg { position: absolute; left: 0; top: 0; pointer-events: none; }
.pg > * , .pg-stage > * { position: absolute; box-sizing: border-box; }
.pg-floor { background: rgba(0, 0, 0, 0.5); }
.pg-stage { transform-style: preserve-3d; transform: translateZ(0); transition: transform 0.3s ${EASE_IN}; }
.pg.standing .pg-stage { transition: transform 0.7s ${RISE}; }
.pg-glass, .pg-floor { opacity: 0; transition: opacity 0.25s; }
.pg.standing .pg-glass, .pg.standing .pg-floor { opacity: 1; transition: opacity 0.35s; }
.pg-face { opacity: 0; transition: opacity 0.2s 0.12s, transform 0.3s ${EASE_IN}; }
.pg.standing .pg-face { opacity: 1; transition: opacity 0.18s, transform 0.7s ${RISE}; }
.pg-ring { border-style: solid; border-color: transparent; background-origin: border-box; background-clip: border-box;
  -webkit-mask: linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
.pg-face > * { position: absolute; white-space: nowrap; line-height: 1.2; }
.pg-cover { overflow: hidden; background: rgba(255, 255, 255, 0.1) center / cover no-repeat; }
.pg-scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.38); }
.pg-bar { position: absolute; bottom: 0; background: #fff; transform-origin: 50% 100%; transform: scaleY(var(--h)); }
.pg.running .pg-bar { animation: pg-beat var(--d) ease-in-out var(--delay) infinite alternate backwards; }
@keyframes pg-beat { from { transform: scaleY(var(--h)); } to { transform: scaleY(1); } }
.pg-title { display: flex; align-items: center; color: #fff; font-weight: 700; }
.pg-title b { font-weight: 700; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pg-badge { flex: none; display: grid; place-items: center; background: rgba(255, 255, 255, 0.62); color: rgba(0, 0, 0, 0.8); font-weight: 900; }
.pg-line { color: rgba(255, 255, 255, 0.72); overflow: hidden; text-overflow: ellipsis; }
.pg-time { color: rgba(255, 255, 255, 0.7); text-align: right; font-variant-numeric: tabular-nums; }
`;

function addStyle() {
  if (document.getElementById('playing-glass-style')) return;
  const style = document.createElement('style');
  style.id = 'playing-glass-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
}

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rgba = ([r, g, b], a) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
const blend = (a, b, f) => a.map((v, i) => v * (1 - f) + b[i] * f);
const WHITE = [255, 255, 255];

export class PlayingGlass {
  /** The glass under `row`'s own cover and words, which give way to it while it stands. */
  constructor(row) {
    addStyle();
    this.row = row;
    this.root = null;
    this.standing = false;
    this.wanted = null;
    this.built = null;
    this.shown = null;
    this.tinted = null;
    this.resized = new ResizeObserver(() => this.apply(false));
    this.resized.observe(row);
  }

  /** `face`: { title, line, time, explicit, cover }; `colors`: the song's two colors, [r, g, b] 0…255, or none. */
  update({ playing, running, face, colors, s }) {
    this.wanted = { playing, running, face, colors, s };
    this.apply(true);
  }

  apply(animated) {
    const w = this.wanted;
    if (!w) return;
    // No layers at all until its row first plays.
    if (!w.playing && !this.root) return;
    const size = { width: this.row.offsetWidth, height: this.row.offsetHeight };
    if (size.width < 2 || size.height < 2) return;
    if (!this.root) this.make();
    this.build(size, w.s);
    this.show(w.face);
    this.tint(w.colors);
    this.root.classList.toggle('running', Boolean(w.running && w.playing));
    this.stand(w.playing, animated && this.row.isConnected);
  }

  make() {
    const root = document.createElement('div');
    root.className = 'pg';
    root.innerHTML = `<div class="pg-floor"></div><div class="pg-stage"><div class="pg-back pg-glass"></div><div class="pg-pane pg-glass"></div>
      <div class="pg-face"><div class="pg-cover"><div class="pg-scrim"></div></div><div class="pg-title"><b></b><span class="pg-badge">E</span></div>
      <div class="pg-line"></div><div class="pg-time"></div></div><div class="pg-sheen pg-glass"></div><div class="pg-inner pg-glass"></div>
      <div class="pg-light pg-ring pg-glass"></div><div class="pg-foot pg-ring pg-glass"></div><div class="pg-halo pg-glass"></div></div>`;
    this.row.insertBefore(root, this.row.firstChild);
    this.row.classList.add('pg-row');
    this.root = root;
    const $ = (name) => root.querySelector(`.pg-${name}`);
    this.parts = { floor: $('floor'), stage: $('stage'), back: $('back'), pane: $('pane'), face: $('face'), cover: $('cover'), scrim: $('scrim'),
      title: $('title'), badge: $('badge'), line: $('line'), time: $('time'), sheen: $('sheen'), inner: $('inner'), light: $('light'),
      foot: $('foot'), halo: $('halo') };
    this.slices = [];
  }

  /** Lays the slab out over a row of this size, once per size. */
  build(size, s) {
    const key = `${size.width}x${size.height}@${s}`;
    if (this.built === key) return;
    this.built = key;
    const p = this.parts;
    const px = (v) => `${v}px`;
    const place = (el, x, y, w, h) => Object.assign(el.style, { left: px(x), top: px(y), width: px(w), height: px(h) });
    const slab = { width: size.width + 8 * s, height: size.height + 6 * s };
    const radius = 14 * s;
    const far = slab.width * 2.2;
    Object.assign(this.root.style, { width: px(size.width), height: px(size.height), perspective: px(far),
      perspectiveOrigin: `${size.width / 2}px ${size.height / 2}px` });
    place(p.stage, (size.width - slab.width) / 2, (size.height - slab.height) / 2, slab.width, slab.height);
    this.root.style.setProperty('--lift', px(LIFT * s));
    p.stage.style.transform = this.standing ? `translateZ(${LIFT * s}px)` : 'translateZ(0)';

    // The glass behind the pane, in slices lit less the deeper they lie: round like a dome, steep near the pane and
    // flattening out toward the back. Deeper slices are drawn smaller by the perspective, so each is made that much
    // larger to show the same swell on every side.
    for (const slice of this.slices) slice.remove();
    this.slices = [];
    for (let index = 0; index < SLICES; index++) {
      const depth = (index + 1) / SLICES;
      const out = SWELL * s * Math.sqrt(depth);
      const grow = 1 + DEPTH * s * depth / far;
      const dx = ((slab.width + 2 * out) * grow - slab.width) / 2;
      const dy = ((slab.height + 2 * out) * grow - slab.height) / 2;
      const slice = document.createElement('div');
      slice.className = 'pg-slice pg-glass';
      place(slice, -dx, -dy, slab.width + 2 * dx, slab.height + 2 * dy);
      Object.assign(slice.style, { borderRadius: px(radius + out), border: `${1.4 * s}px solid ${rgba(WHITE, 0.3 - 0.22 * depth)}`,
        transform: `translateZ(${-DEPTH * s * depth}px)` });
      p.stage.insertBefore(slice, p.pane);
      this.slices.push(slice);
    }
    const backGrow = 1 + DEPTH * s / far;
    const bx = ((slab.width + 2 * SWELL * s) * backGrow - slab.width) / 2;
    const by = ((slab.height + 2 * SWELL * s) * backGrow - slab.height) / 2;
    place(p.back, -bx, -by, slab.width + 2 * bx, slab.height + 2 * by);
    Object.assign(p.back.style, { borderRadius: px(radius + SWELL * s), background: rgba(WHITE, 0.05), transform: `translateZ(${-DEPTH * s}px)` });

    // The front pane: a milky film of glass; light pooling at its top middle, as on a lens.
    for (const el of [p.pane, p.sheen, p.face]) { place(el, 0, 0, slab.width, slab.height); el.style.borderRadius = px(radius); }
    p.pane.style.background = rgba(WHITE, 0.13);
    Object.assign(p.sheen.style, { overflow: 'hidden', transform: 'translateZ(0.5px)',
      background: 'radial-gradient(ellipse 60% 160% at 50% 0%, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0.08) 45%, rgba(255, 255, 255, 0) 100%)' });

    // The bevel: bright along the top and the near edge, dying away round the far ones; a finer line just inside.
    place(p.light, 0, 0, slab.width, slab.height);
    Object.assign(p.light.style, { borderRadius: px(radius), borderWidth: px(0.9 * s), transform: 'translateZ(0.7px)',
      backgroundImage: 'linear-gradient(to bottom, #fff 0%, rgba(255, 255, 255, 0.7) 18%, rgba(255, 255, 255, 0.14) 50%, rgba(255, 255, 255, 0.06) 80%, rgba(255, 255, 255, 0.34) 100%)' });
    const inset = 3 * s;
    place(p.inner, inset - 0.5 * s, inset - 0.5 * s, slab.width - 2 * inset + s, slab.height - 2 * inset + s);
    Object.assign(p.inner.style, { borderRadius: px(radius - inset + 0.5 * s), border: `${s}px solid ${rgba(WHITE, 0.14)}`, transform: 'translateZ(0.6px)' });

    // The foot glows in the song's colors: along its edge, and a lip of light along its bottom.
    place(p.foot, 0, 0, slab.width, slab.height);
    Object.assign(p.foot.style, { borderRadius: px(radius), borderWidth: px(s), transform: 'translateZ(0.75px)' });
    place(p.halo, radius - s, slab.height - 1.5 * s, slab.width - 2 * radius + 2 * s, 2 * s);
    Object.assign(p.halo.style, { borderRadius: px(s), transform: 'translateZ(0.8px)' });

    // Its shadow, lying on the list under it, a little toward the far side.
    place(p.floor, (size.width - slab.width) / 2, (size.height - slab.height) / 2 + 10 * s, slab.width, slab.height);
    Object.assign(p.floor.style, { borderRadius: px(radius), filter: `blur(${16 * s}px)` });

    p.face.style.transform = this.standing ? `translateZ(0.3px) scale(${MAGNIFY})` : 'translateZ(0.3px)';
    this.slab = slab;
    this.s = s;
    this.shown = null;
    this.tinted = null;
  }

  /** Puts the song on the pane, where the row shows it, so the row and the glass line up as one gives way to the other. */
  show(song) {
    const key = JSON.stringify(song);
    if (!this.slab || key === this.shown) return;
    this.shown = key;
    const { slab, s } = this;
    const p = this.parts;
    const px = (v) => `${v}px`;
    const left = (LAYOUT.padding + 4) * s;
    const side = LAYOUT.cover * s;
    Object.assign(p.cover.style, { left: px(left), top: px((slab.height - side) / 2), width: px(side), height: px(side),
      borderRadius: px(LAYOUT.coverRadius * s), backgroundImage: song.cover ? `url("${String(song.cover).replace(/"/g, '%22')}")` : 'none' });
    // Four bars on the cover, moving while the song plays.
    p.scrim.innerHTML = '';
    const width = 2.6 * s, gap = 2.2 * s, tall = 15 * s, total = 4 * width + 3 * gap;
    [[0.35, 0.42], [0.55, 0.55], [0.3, 0.37], [0.45, 0.6]].forEach(([h, d], index) => {
      const bar = document.createElement('i');
      bar.className = 'pg-bar';
      Object.assign(bar.style, { left: px(side / 2 - total / 2 + index * (width + gap)), bottom: px(side / 2 - tall / 2), width: px(width),
        height: px(tall), borderRadius: px(width / 2) });
      bar.style.setProperty('--h', h);
      bar.style.setProperty('--d', `${d}s`);
      bar.style.setProperty('--delay', `${index * 0.11}s`);
      p.scrim.appendChild(bar);
    });

    const textLeft = left + side + LAYOUT.gap * s;
    const timeWidth = song.time ? 46 * s : 0;
    const room = Math.max(slab.width - textLeft - timeWidth - (LAYOUT.padding + 12) * s, 10 * s);
    const hasLine = Boolean(song.line);
    p.title.querySelector('b').textContent = song.title || '';
    Object.assign(p.title.style, { left: px(textLeft), top: px(hasLine ? slab.height / 2 - 17 * s : slab.height / 2 - 9 * s),
      maxWidth: px(room), height: px(18 * s), fontSize: px(LAYOUT.titleSize * s), gap: px(5 * s) });
    p.badge.style.display = song.explicit ? '' : 'none';
    Object.assign(p.badge.style, { width: px(13 * s), height: px(13 * s), borderRadius: px(3 * s), fontSize: px(8.5 * s) });
    p.line.textContent = song.line || '';
    p.line.style.display = hasLine ? '' : 'none';
    Object.assign(p.line.style, { left: px(textLeft), top: px(slab.height / 2 + s), width: px(room), height: px(15 * s), fontSize: px(LAYOUT.lineSize * s) });
    p.time.textContent = song.time || '';
    Object.assign(p.time.style, { left: px(slab.width - timeWidth - (LAYOUT.padding + 4) * s), top: px(slab.height / 2 - 7 * s),
      width: px(timeWidth), height: px(15 * s), fontSize: px(11.5 * s) });
  }

  /** The song's colors along the foot and in the glass behind. */
  tint(colors) {
    const key = JSON.stringify(colors || null);
    if (!this.slab || key === this.tinted) return;
    this.tinted = key;
    const first = colors?.[0] || WHITE;
    const second = colors?.[1] || first;
    const mixed = blend(first, second, 0.5);
    const p = this.parts;
    p.foot.style.backgroundImage = `linear-gradient(to top, ${rgba(mixed, 1)} 0%, ${rgba(mixed, 0.35)} 35%, ${rgba(mixed, 0)} 70%)`;
    p.halo.style.background = rgba(second, 0.85);
    p.halo.style.boxShadow = `0 0 ${20 * this.s}px ${rgba(second, 1)}`;
    this.slices.forEach((slice, index) => {
      const depth = (index + 1) / this.slices.length;
      slice.style.borderColor = rgba(blend(WHITE, first, 0.25 + 0.45 * depth), 0.34 - 0.24 * depth);
    });
  }

  /** Rises out of its row — straight toward you, the song under it swelling as under a lens, springing a little past —
   *  or sinks back flat into it. */
  stand(up, animated) {
    if (up === this.standing) return;
    this.standing = up;
    const p = this.parts;
    const go = () => {
      this.root.classList.toggle('standing', up);
      this.row.classList.toggle('pg-up', up);
      p.stage.style.transform = up ? `translateZ(${LIFT * this.s}px)` : 'translateZ(0)';
      p.face.style.transform = up ? `translateZ(0.3px) scale(${MAGNIFY})` : 'translateZ(0.3px)';
    };
    if (!animated) {
      for (const el of this.root.querySelectorAll('*')) el.style.transition = 'none';
      this.root.style.transition = 'none';
      go();
      void this.root.offsetWidth;
      for (const el of this.root.querySelectorAll('*')) el.style.transition = '';
      return;
    }
    // Just made: drawn flat once, so it rises from there.
    void this.root.offsetWidth;
    requestAnimationFrame(go);
  }
}
