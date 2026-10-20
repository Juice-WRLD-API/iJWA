// The cards as a ring (Deck.swift, CoverCarousel.swift, CardStack.swift). The player turns the ring; it never
// reorders it. Each card is a few layers of glass in the page, moved by springs; a card's picture is drawn once
// and only its transform and opacity change as it moves.
import { Spring, Glide, loop, feel } from './spring.js';

// ---- the ring ---------------------------------------------------------------------------------

export class Deck {
  constructor(cards, anchor) { this.cards = cards; this.anchor = anchor; }
  wrap(index) { const n = Math.max(this.cards.length, 1); return ((index % n) + n) % n; }
  /** How far round the ring a card sits from another: negative to the left. A card exactly opposite goes left. */
  offset(index, focus) {
    const n = this.cards.length;
    let step = this.wrap(index - focus);
    if (step > n / 2 || (n % 2 === 0 && step === n / 2)) step -= n;
    return step;
  }
  /** How many times round the ring a card is from where it started: a card that passes behind the ring starts
   *  a new lap, and so becomes a new card that fades away on one side and arrives on the other. */
  lap(index, turn) {
    const n = Math.max(this.cards.length, 1);
    return Math.round((this.offset(index, this.wrap(turn)) - (index - turn)) / n);
  }
}

/** The ring's turn, kept unwrapped, so every card keeps its identity and slides to its new place. */
export class Ring {
  turn = 0;
  lastStep = 0;
  keys = [];
  turnTo(focus, deck) {
    const keys = deck.cards.map((c) => c.key);
    if (!keys.length) return 0;
    if (keys.join('\n') !== this.keys.join('\n')) {
      const count = this.keys.length;
      if (count > 0) {
        const lap = Math.floor(this.turn / count);
        const middle = this.keys[((this.turn % count) + count) % count];
        const at = keys.indexOf(middle);
        this.turn = (at >= 0 ? at : focus) + lap * keys.length;
      } else {
        this.turn = focus;
      }
      this.keys = keys;
    }
    const step = deck.offset(focus, deck.wrap(this.turn));
    if (step !== 0) { this.turn += step; this.lastStep = step; }
    return this.turn;
  }
}

/** Where one card sits: the middle one faces forward, the others fan out to each side, each further one
 *  smaller, turned further away and a little darker. A hovered card grows, turns toward the viewer and comes
 *  to the front (DeskMetrics.swift, CardPlacement). */
export function placement(offset, hovered, shown, tilt, m) {
  const steps = Math.min(Math.abs(offset), 4);
  const side = offset < 0 ? -1 : 1;
  const spread = [0, 170, 276, 356, 420], scales = [1, 0.84, 0.72, 0.62, 0.54];
  const angles = [0, 30, 40, 46, 50], dims = [0, 0.12, 0.26, 0.38, 0.5];
  const p = {
    x: side * spread[steps] * m.s, y: 0, scale: scales[steps],
    // Each side card turns to face the middle: its outer edge comes toward the viewer.
    angle: -side * angles[steps] * (0.5 + tilt),
    dim: dims[steps], z: 100 - steps * 10, opacity: Math.abs(offset) > shown ? 0 : 1,
  };
  if (hovered === null || hovered !== offset) return p;
  p.scale *= offset === 0 ? 1.03 : 1.1;
  p.angle *= 0.45;
  p.dim = 0;
  p.y = -8 * m.s;
  // The outermost shown card grows in place: pushed outward it would pass the window's edge.
  p.x += offset === 0 || Math.abs(offset) >= shown ? 0 : side * 30 * m.s;
  p.z = 200;
  return p;
}

/** Every card close enough to the middle to be drawn, with its identity for this lap and where it sits. */
export function placements(deck, turn, hoveredKey, sideCards, tilt, m, leaving = 0) {
  if (!deck.cards.length) return [];
  const focus = deck.wrap(turn);
  const hoveredIndex = hoveredKey ? deck.cards.findIndex((c) => c.key === hoveredKey) : -1;
  const hovered = hoveredIndex >= 0 ? deck.offset(hoveredIndex, focus) : null;
  const out = [];
  deck.cards.forEach((card, index) => {
    const offset = deck.offset(index, focus);
    if (Math.abs(offset) > sideCards + 1 + leaving) return;
    out.push({ card, id: `${card.key}#${deck.lap(index, turn)}`, offset, place: placement(offset, hovered, sideCards, tilt, m),
      rest: placement(offset, null, sideCards, tilt, m) });
  });
  return out;
}

// ---- the cards on screen ----------------------------------------------------------------------

const TURN = feel(0.55, 0.16), HOVER = feel(0.34, 0.22), FADE = feel(0.3, 0), FOCUS = feel(0.62, 0.14);
// Folding away to the left, and back.
const FOLD = feel(0.5, 0), UNFOLD = feel(0.62, 0.12);

/** Where an album opened from its card stands, and its songs at its right: the two together in the middle
 *  (AlbumOpenLayout.swift). From the carousel's middle. */
export const ALBUM_TURN = 24;
export function albumLayout(m) {
  const seen = m.cardWidth * Math.cos(ALBUM_TURN * Math.PI / 180), gap = 34 * m.s;
  const panel = { width: 410 * m.s, height: m.cardHeight + 8 * m.s };
  const left = -(seen + gap + panel.width) / 2;
  return { cardX: left + seen / 2, panelX: left + seen + gap + panel.width / 2, panel };
}

/** The lyrics with their album's card (LyricsLayout, LyricsStage.swift): the card at the left, turned a little toward
 *  the words and floating, the words close at its right — nearer than an opened album's songs (his call, 2026-10-10). */
export const LYRICS_TURN = 16;
export function lyricsLayout(m) {
  const seen = m.cardWidth * Math.cos(LYRICS_TURN * Math.PI / 180), gap = 4 * m.s, width = 380 * m.s;
  const left = -(seen + gap + width) / 2;
  return { cardX: left + seen / 2, wordsX: left + seen + gap + width / 2, width };
}

/** The album opened: its card at the left, turned like the playlist beside the player — its far edge back, toward the
 *  songs listed at its right. Beside the lyrics, nearer them and turned a little less. */
function focusPlace(m, focus) {
  if (focus === 'lyrics') return { x: lyricsLayout(m).cardX, y: 0, scale: 1, angle: LYRICS_TURN, dim: 0, z: 300, opacity: 1 };
  return { x: albumLayout(m).cardX, y: 0, scale: 1, angle: ALBUM_TURN, dim: 0, z: 300, opacity: 1 };
}

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class CardView {
  constructor(stage, key) {
    this.key = key;
    this.root = document.createElement('div');
    this.root.className = 'card';
    this.root.dataset.key = key;
    this.root.innerHTML = `<div class="veil"><div class="floater"><div class="leaner"><div class="body"><div class="frost"></div><div class="shade"></div>
      <div class="tint"></div><div class="face"></div><div class="glare"></div><div class="dim"></div></div><div class="rim"></div></div></div></div>`;
    this.veil = this.root.querySelector('.veil');
    this.floater = this.root.querySelector('.floater');
    this.leaner = this.root.querySelector('.leaner');
    this.frost = this.root.querySelector('.frost');
    this.face = this.root.querySelector('.face');
    this.glare = this.root.querySelector('.glare');
    this.dimLayer = this.root.querySelector('.dim');
    stage.appendChild(this.root);
    this.x = new Spring(); this.y = new Spring(); this.scale = new Spring(1); this.angle = new Spring();
    this.opacity = new Spring(1); this.dim = new Spring();
    this.leanX = new Glide(); this.leanY = new Glide(); this.glareOn = new Glide(); this.glareX = new Glide(0.5); this.glareY = new Glide(0.5);
    this.receded = false;
    this.z = 0;
  }

  /** Its cover and words; while Spotify is asked to start it (`starting`), a turning ring and word of it. */
  show(card, image, m, starting = false) {
    const faceKey = `${card.title}|${card.line}|${image}|${m.s}|${starting}`;
    if (faceKey === this.faceKey) return;
    this.faceKey = faceKey;
    const cover = image ? `<img class="cover" src="${escape(image)}" draggable="false">` : `<div class="cover none"></div>`;
    this.face.innerHTML = `${cover}<div class="caption"><div class="title">${escape(card.title)}</div>${starting
      ? '<div class="line starting"><i class="spinner"></i>Starting in Spotify…</div>' : `<div class="line">${escape(card.line)}</div>`}</div>`;
    this.frost.style.backgroundImage = image ? `url("${image}")` : '';
    this.frost.classList.toggle('plain', !image);
  }

  place(p, spring) {
    if (this.z !== p.z) { this.z = p.z; this.root.style.zIndex = String(p.z); }
    this.x.to(p.x, spring); this.y.to(p.y, spring); this.scale.to(p.scale, spring); this.angle.to(p.angle, spring);
    this.opacity.to(p.opacity, spring); this.dim.to(p.dim, spring);
  }

  /** Leans toward the pointer and lights the glass where it points; null stands straight. */
  lean(spot) {
    if (spot) {
      this.leanX.to(spot.x * 6); this.leanY.to(spot.y * 6);
      this.glareX.to((spot.x + 1) / 2); this.glareY.to((spot.y + 1) / 2);
      if (this.glareOn.target !== 1) this.glareOn.to(1, 0.25);
    } else {
      this.leanX.to(0, 0.45); this.leanY.to(0, 0.45); this.glareOn.to(0, 0.45);
    }
  }

  /** Steps back into the distance and fades, or comes forward again, after `delay` seconds. */
  recede(away, delay, animated) {
    if (away === this.receded) return;
    this.receded = away;
    const to = away ? { transform: 'scale(0.78)', opacity: 0 } : { transform: 'scale(1)', opacity: 1 };
    if (!animated) { this.veil.getAnimations().forEach((a) => a.cancel()); Object.assign(this.veil.style, to); return; }
    const from = getComputedStyle(this.veil);
    const start = { transform: from.transform === 'none' ? 'scale(1)' : from.transform, opacity: from.opacity };
    Object.assign(this.veil.style, to);
    this.veil.animate([start, to], away
      ? { duration: 360, delay: delay * 1000, easing: 'cubic-bezier(0.5, 0, 0.75, 0.4)', fill: 'backwards' }
      : { duration: 600, delay: delay * 1000, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.08)', fill: 'backwards' });
  }

  /** Floating beside the lyrics (CardLayer.float): a slow rise and fall, tipping a little as it goes, as if on water —
   *  the compositor's own animation (desktop.css .floating), nothing for the page to do each frame. Stopped, it settles
   *  back from wherever it was. */
  float(on) {
    if (on === Boolean(this.floating)) return;
    this.floating = on;
    if (on) { this.root.classList.add('floating'); return; }
    const was = getComputedStyle(this.floater).transform;
    this.root.classList.remove('floating');
    if (was && was !== 'none') this.floater.animate([{ transform: was }, { transform: 'none' }], { duration: 400, easing: 'ease-out' });
  }

  shake() {
    this.root.animate([{ translate: '0px' }, { translate: '9px' }, { translate: '-8px' }, { translate: '6px' }, { translate: '-4px' }, { translate: '2px' }, { translate: '0px' }],
      { duration: 500, composite: 'add' });
  }

  tick(dt, depth) {
    let busy = false;
    for (const s of [this.x, this.y, this.scale, this.angle, this.opacity, this.dim, this.leanX, this.leanY, this.glareOn, this.glareX, this.glareY]) if (s.step(dt)) busy = true;
    this.root.style.transform = `translate(${this.x.value}px, ${this.y.value}px) perspective(${depth}px) rotateY(${this.angle.value}deg) scale(${this.scale.value})`;
    this.root.style.opacity = String(Math.max(0, Math.min(1, this.opacity.value)));
    this.dimLayer.style.opacity = String(Math.max(0, this.dim.value));
    this.leaner.style.transform = `perspective(${depth}px) rotateY(${this.leanX.value}deg) rotateX(${-this.leanY.value}deg)`;
    this.glare.style.opacity = String(this.glareOn.value);
    this.glare.style.background = `radial-gradient(circle at ${this.glareX.value * 100}% ${this.glareY.value * 100}%, rgba(255,255,255,0.18), rgba(255,255,255,0) 75%)`;
    return busy;
  }
}

export class CardStack {
  layers = new Map();   // id → CardView
  leaving = new Set();
  lastTurn = null;
  lastRefusals = 0;
  receded = false;
  folded = false;
  foldTurn = 0;   // each fold or unfold, so a card's late step never lands after the next one began
  leanedID = null;
  m = null;

  constructor(stage) { this.stage = stage; loop.add(this); }

  depth() { return Math.max(this.m.cardWidth, this.m.cardHeight) / 0.55; }

  show(cards, { turn, m, hoveredKey, refusedKey, refusals, receded, image, pendingKey = null, focusedKey = null, focus = 'album', floating = false, folded = false }) {
    this.m = m;
    // The card beside the lyrics folded away by the eye beside the tools: at the far left, turned edge-on as if closing
    // against it, gone; unfolding, it springs back out beside the words (CardStack.foldedTarget).
    const folding = folded !== this.folded;
    this.folded = folded;
    if (folding) this.foldTurn++;
    const foldTurn = this.foldTurn;
    const sign = (cards.find((c) => c.offset < 0)?.place.angle ?? 30) < 0 ? -1 : 1;
    const foldedPlace = (entry) => ({ ...entry.place, x: -m.width / 2 + m.cardWidth * 0.32, scale: 0.8, angle: sign * 82, opacity: 0 });
    const turned = this.lastTurn !== turn;
    this.lastTurn = turn;
    // An album opened: the nearest of its cards (a short shelf shows one album twice round the ring) stands at the left,
    // turned toward its songs, and the rest step away (CardStack.focusedKey).
    const focused = focusedKey == null ? null
      : cards.filter((c) => c.card.key === focusedKey).sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0]?.id ?? null;
    const refocused = focused !== this.focusedID || focus !== this.focus;
    this.focusedID = focused;
    this.focus = focus;
    const spring = refocused ? FOCUS : turned ? TURN : HOVER;
    // Stepped away: everything while search or the lyrics show, and all but the album opened.
    const away = (entry) => entry.id !== focused && (receded || focused != null);
    const ids = new Set(cards.map((c) => c.id));
    const fresh = this.layers.size === 0;

    for (const entry of cards) {
      let view = this.layers.get(entry.id);
      const existing = Boolean(view);
      if (!view) {
        view = new CardView(this.stage, entry.card.key);
        this.layers.set(entry.id, view);
        view.recede(away(entry) || fresh, 0, false);
      }
      this.leaving.delete(entry.id);
      view.show(entry.card, image(entry.card), m, entry.card.key === pendingKey);
      if (!existing && !fresh) {
        // New to a ring already there: it arrives from its own side.
        view.place({ ...entry.place, x: entry.place.x + (entry.offset < 0 ? -170 : 170) * m.s, opacity: 0 }, null);
      }
      const target = entry.id === focused ? (folded ? foldedPlace(entry) : focusPlace(m, focus)) : entry.place;
      if (folding && existing && entry.id === focused) {
        requestAnimationFrame(() => { if (this.foldTurn === foldTurn) view.place(target, folded ? FOLD : UNFOLD); });
      } else {
        view.place(target, fresh && !existing ? null : spring);
      }
      view.float(entry.id === focused && focus === 'lyrics' && floating);
    }
    if (fresh) for (const entry of cards) if (!away(entry)) this.layers.get(entry.id)?.recede(false, Math.abs(entry.offset) * 0.06, true);

    // Search or the lyrics opened or closed, or an album: the cards step back from the outside in, and come back from
    // the middle out.
    this.receded = receded;
    const farthest = Math.max(0, ...cards.map((c) => Math.abs(c.offset)));
    for (const entry of cards) {
      const view = this.layers.get(entry.id);
      if (!view || view.receded === away(entry)) continue;
      const rank = away(entry) ? farthest - Math.abs(entry.offset) : Math.abs(entry.offset);
      view.recede(away(entry), rank * 0.06, true);
    }

    for (const [id, view] of this.layers) {
      if (ids.has(id) || this.leaving.has(id)) continue;
      this.leaving.add(id);
      view.opacity.to(0, FADE);
      setTimeout(() => {
        if (!this.leaving.has(id)) return;
        this.leaving.delete(id);
        view.root.remove();
        this.layers.delete(id);
      }, 450);
    }

    // A refused album's card shakes its head, once per refusal.
    if (refusals !== this.lastRefusals) {
      this.lastRefusals = refusals;
      const entry = cards.find((c) => c.card.key === refusedKey);
      if (entry) this.layers.get(entry.id)?.shake();
    }
    if (this.leanedID && !cards.some((c) => c.id === this.leanedID && c.card.key === hoveredKey)) {
      this.layers.get(this.leanedID)?.lean(null);
      this.leanedID = null;
    }
    loop.wake();
  }

  lean(key, spot) {
    let id = null;
    if (key) for (const [cardID, view] of this.layers) if (view.key === key && !this.leaving.has(cardID)) id = cardID;
    if (this.leanedID && this.leanedID !== id) this.layers.get(this.leanedID)?.lean(null);
    this.leanedID = id;
    if (id) this.layers.get(id).lean(spot);
  }

  /** The card under a point in the page, front-most first, with where on it: -1...1 across and down. */
  hit(x, y) {
    let best = null;
    for (const [id, view] of this.layers) {
      if (this.leaving.has(id) || view.opacity.target < 0.5 || view.receded) continue;
      const r = view.root.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (!best || view.z > best.view.z) best = { view, r };
    }
    if (!best) return null;
    const { view, r } = best;
    return { key: view.key, spot: { x: Math.max(-1, Math.min(1, (x - (r.left + r.width / 2)) / (r.width / 2))), y: Math.max(-1, Math.min(1, (y - (r.top + r.height / 2)) / (r.height / 2))) } };
  }

  tick(dt) {
    if (!this.m) return false;
    const depth = this.depth();
    let busy = false;
    for (const view of this.layers.values()) if (view.tick(dt, depth)) busy = true;
    return busy;
  }
}
