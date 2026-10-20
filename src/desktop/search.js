// Search from the desktop (SearchBar.swift, SongSearch.swift, SearchGrid.swift). The magnifier springs open into a
// glass bar as wide as the player's; typing searches Apple's catalog, whose results — Top Results, Artists, Albums,
// Songs, as Apple Music lays them out — take the cards' place on dark glass, rising in one after another, sliding to
// their new places as the search is refined, lifting under the pointer. A result picked plays in Spotify: it lifts
// and waits, breathing, until its song starts.
import { icons } from './icons.js';
import { glide } from '../shared/glide.js';

const PAUSE = 260;  // a search goes out once typing pauses
const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = (seconds) => (seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '');

export class Search {
  isOpen = false;
  query = '';
  phase = 'idle';         // idle | short | searching | found | nothing | failed
  results = { top: [], artists: [], albums: [], songs: [] };
  cells = new Map();      // key → element
  slots = [];             // { key, item, style, x, y, w, h }
  landing = null;         // the item picked, until its song starts
  selected = -1;          // the result chosen with the keys
  timer = 0;
  asked = 0;

  constructor({ api, host, bar, onChange, nowTrack }) {
    this.api = api;
    this.host = host;          // the grid's place, over the cards
    this.bar = bar;            // the search bar in the tools row
    this.onChange = onChange;  // the cards step back or come back
    this.nowTrack = nowTrack;
    this.host.innerHTML = '<div class="glass"></div><div class="scroll"><div class="content"></div></div><div class="note"></div>';
    this.scroll = host.querySelector('.scroll');
    this.content = host.querySelector('.content');
    this.note = host.querySelector('.note');
    bar.innerHTML = `<span class="mag">${icons.search}</span><input type="text" spellcheck="false" placeholder="Search songs, albums, artists">
      <span class="spin"></span><button class="clear" aria-label="Clear">${icons.clear}</button>`;
    this.input = bar.querySelector('input');
    this.input.addEventListener('input', () => this.type(this.input.value));
    this.input.addEventListener('keydown', (event) => this.key(event));
    bar.querySelector('.mag').addEventListener('click', () => this.open());
    bar.querySelector('.clear').addEventListener('click', () => this.clear());
    this.scroll.addEventListener('scroll', () => this.fade());
    glide(this.scroll);
    host.addEventListener('pointermove', (event) => this.hover(event.target.closest('.result')));
    host.addEventListener('pointerleave', () => this.hover(null));
    host.addEventListener('click', (event) => {
      const cell = event.target.closest('.result');
      if (cell && !this.landing) this.pick(cell.dataset.key);
    });
    // A song right-clicked: lined up where the song playing plays, from the app's menu (QueueMenu.swift).
    host.addEventListener('contextmenu', (event) => {
      const cell = event.target.closest('.result');
      const item = cell && !this.landing ? this.slots.find((s) => s.key === cell.dataset.key)?.item : null;
      if (item?.kind !== 'song') return;
      event.preventDefault();
      this.api.send('desk-queue-menu', item);
    });
    // Clicked away with nothing typed: the bar closes. With something typed the results stay, to be clicked.
    window.addEventListener('blur', () => { if (this.isOpen && !this.query.trim() && !this.landing) this.close(); });
  }

  /** The bar says where it searches: the site listened on, or Apple Music's catalog — for Spotify, just songs. */
  place(where) {
    const text = !where || where.kind === 'spotify' ? 'Search songs, albums, artists' : `Search ${where.name}`;
    if (this.input.placeholder !== text) this.input.placeholder = text;
    // Another source chosen with the search open: its words are searched again there — they went on searching
    // YouTube Music after SoundCloud was chosen (Mac, 2026-10-09).
    const kind = where?.kind || '';
    if (this.searchedIn != null && kind !== this.searchedIn && this.hasQuery && !this.landing) this.type(this.query);
    this.searchedIn = kind;
  }

  get hasQuery() { return Boolean(this.query.trim()); }
  /** The cards step back while there are results to show, or a picked one waits. */
  get showsGrid() { return this.hasQuery || Boolean(this.landing); }

  // ---- the bar ----

  open() {
    if (!this.isOpen) {
      this.isOpen = true;
      this.bar.classList.add('open');
      this.api.send('desk-keys', true);
      this.onChange();
    }
    setTimeout(() => this.input.focus(), 60);
  }

  /** Closes the bar and forgets what was typed; a picked result keeps waiting. */
  close() {
    clearTimeout(this.timer);
    // Search closed: the artist opened from it goes too.
    this.api.send('desk-close-artist');
    this.query = '';
    this.input.value = '';
    this.input.blur();
    if (this.isOpen) { this.isOpen = false; this.bar.classList.remove('open'); this.api.send('desk-keys', false); }
    this.phase = 'idle';
    this.bar.classList.remove('typed', 'busy');
    if (!this.landing) this.leave();
    this.onChange();
  }

  /** Empties the bar and keeps it open; with nothing typed, it closes. The artist opened from search goes either way. */
  clear() {
    this.api.send('desk-close-artist');
    if (!this.hasQuery) { this.close(); return; }
    clearTimeout(this.timer);
    this.query = '';
    this.input.value = '';
    this.phase = 'idle';
    this.bar.classList.remove('typed', 'busy');
    this.leave();
    this.onChange();
    this.input.focus();
  }

  type(text) {
    const had = this.hasQuery;
    this.query = text;
    const term = text.trim();
    this.bar.classList.toggle('typed', Boolean(term));
    if (had !== this.hasQuery) { if (!this.hasQuery) this.leave(); this.onChange(); }
    clearTimeout(this.timer);
    if (term.length < 2) {
      this.phase = term ? 'short' : 'idle';
      if (term) this.draw({ top: [], artists: [], albums: [], songs: [] });
      this.bar.classList.remove('busy');
      this.showNote();
      return;
    }
    this.phase = 'searching';
    this.bar.classList.add('busy');
    this.showNote();
    const turn = ++this.asked;
    this.timer = setTimeout(async () => {
      const found = await this.api.invoke('desk-search', term);
      if (turn !== this.asked || this.query.trim() !== term) return;
      this.bar.classList.remove('busy');
      if (!found) { this.phase = 'failed'; this.draw({ top: [], artists: [], albums: [], songs: [] }); }
      else {
        const empty = !found.top.length && !found.artists.length && !found.albums.length && !found.songs.length;
        this.phase = empty ? 'nothing' : 'found';
        this.draw(found);
      }
      this.showNote();
    }, PAUSE);
  }

  key(event) {
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    if (!this.slots.length) return;
    if (event.key === 'Enter') { event.preventDefault(); this.pick(this.slots[Math.max(this.selected, 0)].key); return; }
    const moves = { ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right' };
    const move = moves[event.key];
    if (!move || ((move === 'left' || move === 'right') && this.selected < 0)) return;
    event.preventDefault();
    if (this.selected < 0) { if (move === 'down') this.choose(0); return; }
    const here = this.slots[this.selected];
    let next = null;
    if (move === 'left') next = this.selected > 0 ? this.selected - 1 : null;
    else if (move === 'right') next = this.selected < this.slots.length - 1 ? this.selected + 1 : null;
    else {
      // The nearest result in the next line of results down or up.
      const below = move === 'down';
      const lines = this.slots.map((s, i) => ({ s, i })).filter(({ s }) => (below ? s.y > here.y + 1 : s.y < here.y - 1));
      if (lines.length) {
        const y = below ? Math.min(...lines.map(({ s }) => s.y)) : Math.max(...lines.map(({ s }) => s.y));
        next = lines.filter(({ s }) => s.y === y).sort((a, b) => Math.abs(a.s.x - here.x) - Math.abs(b.s.x - here.x))[0].i;
      } else if (!below) { this.choose(-1); return; }
    }
    if (next != null) this.choose(next);
  }

  choose(index) {
    this.selected = index;
    for (const [key, cell] of this.cells) cell.classList.toggle('chosen', index >= 0 && this.slots[index]?.key === key);
    const slot = this.slots[index];
    if (slot) {
      const top = slot.y - this.scroll.scrollTop, bottom = top + slot.h;
      if (top < 0) this.scroll.scrollBy({ top: top - 16, behavior: 'smooth' });
      else if (bottom > this.scroll.clientHeight) this.scroll.scrollBy({ top: bottom - this.scroll.clientHeight + 16, behavior: 'smooth' });
    }
  }

  // ---- the grid ----

  metrics(m) { this.m = m; if (this.results) this.layOut(false); }

  draw(results) {
    this.results = results;
    this.selected = -1;
    this.layOut(true);
  }

  /** Every result's place, section after section, top down (Apple Music's own order). */
  layOut(arriving) {
    const m = this.m;
    if (!m) return;
    const s = m.s, pad = 20 * s, inner = m.barWidth - 2 * pad, tileGap = 14 * s;
    const side = (inner - 5 * tileGap) / 6, caption = 38 * s, rowHeight = 48 * s, rowGap = 18 * s;
    const column = (inner - rowGap) / 2, sectionGap = 16 * s;
    let top = 16 * s;
    const slots = [], headers = [];
    const header = (title) => { headers.push({ title, y: top }); top += 28 * s; };
    const tiles = (items, section) => {
      if (!items?.length) return;
      header(section);
      items.slice(0, 6).forEach((item, i) => slots.push({ key: `${section}|${item.kind}|${item.id}`, item, style: item.kind === 'artist' ? 'round' : 'tile',
        x: pad + i * (side + tileGap), y: top, w: side, h: side + caption }));
      top += side + caption + sectionGap;
    };
    const rows = (items, section) => {
      const shown = (items || []).slice(0, 8);
      if (!shown.length) return;
      header(section);
      shown.forEach((item, i) => slots.push({ key: `${section}|${item.kind}|${item.id}`, item, style: 'row',
        x: pad + (i % 2) * (column + rowGap), y: top + Math.floor(i / 2) * rowHeight, w: column, h: rowHeight }));
      top += Math.ceil(shown.length / 2) * rowHeight + sectionGap;
    };
    tiles(this.results.top, 'Top Results');
    tiles(this.results.artists, 'Artists');
    tiles(this.results.albums, 'Albums');
    rows(this.results.songs, 'Songs');
    this.slots = slots;
    this.content.style.height = `${Math.max(top - sectionGap + 26 * s, 0)}px`;

    // Section titles.
    for (const old of this.content.querySelectorAll('.section')) old.remove();
    for (const h of headers) {
      const el = document.createElement('div');
      el.className = 'section';
      el.textContent = h.title;
      Object.assign(el.style, { left: `${pad + 2 * s}px`, top: `${h.y}px` });
      this.content.appendChild(el);
    }
    // Results: those still here slide to their new places, new ones rise in one after another, the rest sink away.
    const wanted = new Set(slots.map((sl) => sl.key));
    for (const [key, cell] of this.cells) {
      if (wanted.has(key)) continue;
      this.cells.delete(key);
      cell.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: `translateY(${8 * s}px) scale(0.96)` }], { duration: 200, easing: 'ease-in' })
        .finished.then(() => cell.remove(), () => cell.remove());
    }
    let fresh = 0;
    for (const slot of slots) {
      let cell = this.cells.get(slot.key);
      const isNew = !cell;
      if (isNew) { cell = this.cell(slot); this.cells.set(slot.key, cell); this.content.appendChild(cell); }
      Object.assign(cell.style, { left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.w}px`, height: `${slot.h}px` });
      if (isNew && arriving) {
        cell.animate([{ opacity: 0, transform: `translateY(${12 * s}px) scale(0.97)` }, { opacity: 1, transform: 'none' }],
          { duration: 380, delay: Math.min(fresh++, 14) * 22, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.1)', fill: 'backwards' });
      }
    }
    this.fade();
    this.markPlaying();
  }

  /** One result: a cover with its title and line beneath (a circle for an artist), or a row with a small cover. */
  cell(slot) {
    const { item, style } = slot;
    const el = document.createElement('div');
    el.className = `result ${style}`;
    el.dataset.key = slot.key;
    const art = item.art ? `<img src="${escape(item.art)}" draggable="false" loading="lazy">` : '';
    const line = item.kind === 'artist' ? 'Artist'
      : style === 'row' ? (item.album ? `${item.artist} · ${item.album}` : item.artist)
      : item.kind === 'song' ? (item.artist ? `Song · ${item.artist}` : 'Song') : (item.artist ? `Album · ${item.artist}` : 'Album');
    if (style === 'row') {
      el.innerHTML = `<div class="art">${art}<span class="play">${icons.playSmall}</span></div>
        <div class="words"><b>${escape(item.title)}</b><span>${escape(line)}</span></div><span class="time">${time(item.duration)}</span>`;
    } else {
      el.innerHTML = `<div class="art">${art}<span class="disc">${icons.playSmall}</span></div>
        <div class="words"><b>${escape(item.title)}</b><span>${escape(line)}</span></div>`;
    }
    const img = el.querySelector('img');
    if (img) { img.style.opacity = '0'; img.onload = () => { img.style.opacity = ''; }; }
    return el;
  }

  hover(cell) {
    const key = cell?.dataset.key ?? null;
    if (key === this.hovered) return;
    this.hovered = key;
    for (const [k, c] of this.cells) c.classList.toggle('lit', k === key);
  }

  /** The song playing stands out among the results. */
  markPlaying() {
    const track = this.nowTrack();
    // The same song as CatalogPlayer.isSame tells it: the title, versions' additions cut off, and the same artist — one
    // name starting the other, or the same first artist however the others are joined ("Lil Tecca ve NAV").
    const plain = (t) => { let x = String(t || '').toLowerCase(); for (const m of [' (', ' [', ' - ']) { const i = x.indexOf(m); if (i >= 0) x = x.slice(0, i); } return x.trim(); };
    const lead = (a) => { let x = String(a || '').toLowerCase(); for (const m of [',', ' & ', ' feat.', ' ft.', ' x ', ' with ', ' ve ', ' und ', ' et ', ' y ', ' e ']) { const i = x.indexOf(m); if (i >= 0) x = x.slice(0, i); } return x.trim(); };
    const sameArtist = (a, b) => { a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase(); return a.startsWith(b) || b.startsWith(a) || (Boolean(lead(a)) && lead(a) === lead(b)); };
    for (const slot of this.slots) {
      const on = slot.item.kind === 'song' && track && plain(slot.item.title) === plain(track.title) && sameArtist(track.artist, slot.item.artist);
      this.cells.get(slot.key)?.classList.toggle('playing', Boolean(on));
    }
  }

  /** The top edge melts only once scrolled; the bottom one while more waits below. */
  fade() {
    const sc = this.scroll;
    const top = sc.scrollTop > 1, bottom = sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1;
    const edge = 28 * (this.m?.s || 1);
    sc.style.webkitMaskImage = sc.style.maskImage = `linear-gradient(to bottom, ${top ? 'transparent' : '#000'} 0, #000 ${edge}px, #000 calc(100% - ${edge}px), ${bottom ? 'transparent' : '#000'} 100%)`;
  }

  /** A line in the middle when there is nothing to show; faint shapes breathing while the first results come. */
  showNote() {
    const text = { short: 'Keep typing…', nothing: 'Nothing found', failed: 'Search can’t be reached right now' }[this.phase] || '';
    this.note.textContent = text;
    this.note.classList.toggle('shown', Boolean(text) && !this.landing);
    this.host.classList.toggle('ghosts', this.phase === 'searching' && !this.slots.length);
  }

  /** The results sink away after the text was cleared, before the grid goes. */
  leave() {
    clearTimeout(this.timer);
    this.asked++;
    this.results = { top: [], artists: [], albums: [], songs: [] };
    this.phase = 'idle';
    this.layOut(false);
    this.showNote();
  }

  // ---- playing what was picked ----

  /** A result picked: the bar closes, the tile rises and melts into the panel in the middle where the song waits
   *  (the app shows it, StartingPanel.swift), everything else sinks away. */
  async pick(key) {
    const slot = this.slots.find((s) => s.key === key);
    if (!slot) return;
    const item = slot.item;
    // An artist opens their page over the player; search stays beneath it.
    if (item.kind === 'artist') { this.api.send('desk-open-artist', item); return; }
    this.landing = { item, key, startedFrom: this.nowTrack()?.id ?? null };
    const cell = this.cells.get(key);
    for (const [k, c] of this.cells) {
      if (k === key) continue;
      c.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    }
    this.content.querySelectorAll('.section').forEach((h) => h.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }));
    // The bar closes and gives the keys back.
    this.query = '';
    this.input.value = '';
    this.bar.classList.remove('typed', 'busy');
    if (this.isOpen) { this.isOpen = false; this.bar.classList.remove('open'); this.api.send('desk-keys', false); this.input.blur(); }
    this.note.classList.remove('shown');
    this.onChange();
    this.api.invoke('desk-search-play', item);
    this.finishLanding();
  }

  /** The song playing changed: when it is the one picked (or any new song, for an album or artist), the tile goes. */
  trackChanged() {
    this.markPlaying();
    const landing = this.landing;
    if (!landing?.pressed) return;
    const track = this.nowTrack();
    if (track && track.id !== landing.startedFrom) this.finishLanding();
  }

  finishLanding() {
    clearTimeout(this.landingEnds);
    if (!this.landing) return;
    const cell = this.cells.get(this.landing.key);
    this.landing = null;
    cell?.animate([{ opacity: 1, transform: 'scale(1.06)' }, { opacity: 0, transform: 'scale(1.1) translateY(-10px)' }], { duration: 350, easing: 'ease-in', fill: 'forwards' });
    setTimeout(() => { if (!this.hasQuery && !this.landing) { this.leave(); this.onChange(); } }, 300);
  }
}
