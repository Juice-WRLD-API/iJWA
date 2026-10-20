// The user's lists, opened from the playlist's title and shown where the cards are, as search's results are (PlaylistShelf
// in PlaylistPanel.swift, SearchGrid's shelf): Continue Playing and the lists of where they listen — the site's own,
// with their covers — then their folders, a section each, covers in rows of six. A pick shows it in the playlist; the
// one shown glows. Opened at once with what is kept; lists read meanwhile slide in.
const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** What a list with no picture of its own shows: its symbol, white, on warm colors — the same for the same list. */
const SYMBOLS = {
  infinity: '<path d="M7.5 8.5c-2 0-3.5 1.6-3.5 3.5s1.5 3.5 3.5 3.5c3 0 6-7 9-7 2 0 3.5 1.6 3.5 3.5S18.5 15.5 16.5 15.5c-3 0-6-7-9-7z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="#fff"/>',
  list: '<path d="M5 7h10M5 11h10M5 15h6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M17 13v6.2a2 2 0 1 1-1.4-1.9V11l4-1v2.2z" fill="#fff"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="#fff"/>',
  plus: '<path d="M12 6v12M6 12h12" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  // The Queue (SF Symbols' list.number): a numbered list.
  listNumber: '<path d="M10 7h9M10 12h9M10 17h9" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M4.6 5.6 6 4.8v4.4M4.4 14.2a1.3 1.3 0 0 1 2.5.4c0 .9-2.5 1.9-2.5 3.2h2.6" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
};
// Gold to rose and their neighbours; never purple.
const WARM = [['#f2b33d', '#e8566c'], ['#f59e52', '#d9465f'], ['#e8c46b', '#f59061'], ['#f28482', '#f6bd60'], ['#e87051', '#f5a766']];
function cover(entry, drawn = false) {
  if (entry.art && !drawn) return `<img src="${escape(entry.art)}" draggable="false" loading="lazy">`;
  const pick = entry.symbol === 'plus' ? ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.07)']
    : entry.symbol === 'infinity' ? WARM[0] : entry.symbol === 'heart' ? WARM[1]
      : WARM[[...entry.id].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) & 0xffff, 0) % WARM.length];
  return `<span class="symbol" style="background:linear-gradient(135deg, ${pick[0]}, ${pick[1]})"><svg viewBox="0 0 24 24">${SYMBOLS[entry.symbol] || SYMBOLS.list}</svg></span>`;
}

export class Lists {
  content = null;   // { sections: [{ title, entries: [{ id, title, line, art, symbol }], note }], chosen }
  cells = new Map();
  m = null;

  constructor({ api, host, onChange }) {
    this.api = api;
    this.host = host;
    this.onChange = onChange;
    host.innerHTML = `<div class="glass"></div><div class="scroll"><div class="content"></div></div>
      <button class="lists-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    this.scroll = host.querySelector('.scroll');
    this.inner = host.querySelector('.content');
    host.querySelector('.lists-close').addEventListener('click', () => api.send('lists-close'));
    host.addEventListener('pointermove', (event) => this.hover(event.target.closest('.result')));
    host.addEventListener('pointerleave', () => this.hover(null));
    host.addEventListener('click', (event) => {
      const cell = event.target.closest('.result');
      if (cell) api.send('lists-pick', cell.dataset.id);
    });
    host.addEventListener('contextmenu', (event) => {
      const cell = event.target.closest('.result');
      if (cell) { event.preventDefault(); api.send('lists-menu', cell.dataset.id); }
    });
    this.scroll.addEventListener('scroll', () => this.fade());
    api.listen('lists', (content) => this.show(content));
  }

  get isOpen() { return Boolean(this.content); }

  metrics(m) { this.m = m; if (this.content) this.layOut(false); }

  show(content) {
    this.content = content;
    this.host.classList.toggle('hidden', !content);
    if (content) this.layOut(true);
    else {
      // Closed: built afresh next time, so its covers rise in again.
      this.scroll.scrollTop = 0;
      for (const cell of this.cells.values()) cell.remove();
      this.cells.clear();
    }
    this.onChange();
  }

  /** Each section's covers in rows of six, as many rows as it takes; a section with none says why. */
  layOut(arriving) {
    const m = this.m;
    if (!m || !this.content) return;
    const s = m.s, pad = 20 * s, inner = m.barWidth - 2 * pad, tileGap = 14 * s;
    const side = (inner - 5 * tileGap) / 6, caption = 38 * s, lineGap = 12 * s, sectionGap = 16 * s;
    let top = 16 * s;
    const slots = [], headers = [], notes = [];
    for (const section of this.content.sections) {
      headers.push({ title: section.title, y: top });
      top += 28 * s;
      section.entries.forEach((entry, i) => slots.push({ key: `${section.title}|${entry.id}`, entry,
        x: pad + (i % 6) * (side + tileGap), y: top + Math.floor(i / 6) * (side + caption + lineGap), w: side, h: side + caption }));
      const rows = Math.ceil(section.entries.length / 6);
      top += rows ? rows * (side + caption) + (rows - 1) * lineGap + sectionGap : sectionGap;
      if (section.note) { notes.push({ text: section.note, y: top - sectionGap + (rows ? 4 * s : 0) }); top += 18 * s + (rows ? 4 * s : 0); }
    }
    this.inner.style.height = `${Math.max(top - sectionGap + 26 * s, 0)}px`;
    for (const old of this.inner.querySelectorAll('.section, .lists-note')) old.remove();
    for (const h of headers) {
      const el = document.createElement('div');
      el.className = 'section';
      el.textContent = h.title;
      Object.assign(el.style, { left: `${pad + 2 * s}px`, top: `${h.y}px` });
      this.inner.appendChild(el);
    }
    for (const n of notes) {
      const el = document.createElement('div');
      el.className = 'lists-note';
      el.textContent = n.text;
      Object.assign(el.style, { left: `${pad + 2 * s}px`, top: `${n.y}px`, right: `${pad}px` });
      this.inner.appendChild(el);
    }
    // Lists still here slide to their new places; new ones rise in one after another; the rest sink away.
    const wanted = new Set(slots.map((sl) => sl.key));
    for (const [key, cell] of this.cells) {
      if (wanted.has(key)) continue;
      this.cells.delete(key);
      cell.remove();
    }
    let fresh = 0;
    for (const slot of slots) {
      let cell = this.cells.get(slot.key);
      const isNew = !cell;
      if (isNew) {
        cell = document.createElement('div');
        cell.className = 'result tile';
        cell.dataset.id = slot.entry.id;
        cell.innerHTML = `<div class="art">${cover(slot.entry)}</div><div class="words"><b>${escape(slot.entry.title)}</b><span>${escape(slot.entry.line)}</span></div>`;
        const img = cell.querySelector('img');
        // A cover that won't come: its symbol on warm colors instead.
        if (img) { img.style.opacity = '0'; img.onload = () => { img.style.opacity = ''; }; img.onerror = () => { img.outerHTML = cover(slot.entry, true); }; }
        this.cells.set(slot.key, cell);
        this.inner.appendChild(cell);
      }
      Object.assign(cell.style, { left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.w}px`, height: `${slot.h}px` });
      cell.classList.toggle('shown-list', slot.entry.id === this.content.chosen);
      if (isNew && arriving) {
        cell.animate([{ opacity: 0, transform: `translateY(${12 * s}px) scale(0.97)` }, { opacity: 1, transform: 'none' }],
          { duration: 380, delay: Math.min(fresh++, 14) * 22, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.1)', fill: 'backwards' });
      }
    }
    this.fade();
  }

  hover(cell) {
    const id = cell?.dataset.id ?? null;
    for (const c of this.cells.values()) c.classList.toggle('lit', c.dataset.id === id);
  }

  fade() {
    const sc = this.scroll;
    const top = sc.scrollTop > 1, bottom = sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1;
    const edge = 28 * (this.m?.s || 1);
    sc.style.webkitMaskImage = sc.style.maskImage = `linear-gradient(to bottom, ${top ? 'transparent' : '#000'} 0, #000 ${edge}px, #000 calc(100% - ${edge}px), ${bottom ? 'transparent' : '#000'} 100%)`;
  }
}
