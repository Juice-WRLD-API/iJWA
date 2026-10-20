// The sound of the song playing, for timing its words on this computer (iBaila's lyrics sync): the page's own audio
// file, fetched whole as the page fetches its parts, decoded by the browser — every format it plays — and made 16 kHz
// mono, kept in the page until iBaila has taken it in pieces. Nothing is saved; it's gone once taken. Handed to the
// page whole (chrome.scripting): nothing outside the function is seen there.
//
// ask: { what: 'prepare' } → { samples, seconds } or { error }
//      { what: 'chunk', from, count } → { data } (base64, 16-bit little-endian samples)
//      { what: 'clear' } → { done }

export async function pageAudio(site, ask) {
  try { return await answer(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }

  async function answer() {
    if (ask.what === 'chunk') {
      const pcm = window.__ibailaAudio;
      if (!pcm) return { error: 'nothing prepared' };
      const part = new Uint8Array(pcm.buffer, ask.from * 2, Math.max(0, Math.min(ask.count, pcm.length - ask.from)) * 2);
      let text = '';
      for (let i = 0; i < part.length; i += 0x8000) text += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
      return { data: btoa(text) };
    }
    if (ask.what === 'clear') { window.__ibailaAudio = null; return { done: true }; }

    const fetched = site === 'soundCloud' ? await soundCloud() : await youTube();
    if (fetched.error) return fetched;
    // Decoded at 16 kHz straight away (the context's rate), then made mono.
    const context = new OfflineAudioContext(1, 16000 * 60, 16000);
    const audio = await context.decodeAudioData(fetched.data);
    const mono = new Int16Array(audio.length);
    const channels = [...Array(audio.numberOfChannels).keys()].map((c) => audio.getChannelData(c));
    for (let i = 0; i < audio.length; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i];
      mono[i] = Math.max(-1, Math.min(1, sum / channels.length)) * 32767;
    }
    window.__ibailaAudio = mono;
    return { samples: mono.length, seconds: audio.duration };
  }

  // YouTube and YouTube Music: the audio stream the player fetches in parts, asked for whole — the latest one as long
  // as the song playing.
  async function youTube() {
    const video = document.querySelector('video');
    const length = video && isFinite(video.duration) ? video.duration : 0;
    const streams = performance.getEntriesByType('resource').map((e) => e.name)
      .filter((n) => n.includes('googlevideo.com/videoplayback') && /mime=audio/.test(n))
      .map((n) => new URL(n));
    const own = streams.filter((u) => !length || Math.abs(Number(u.searchParams.get('dur') || 0) - length) < 2.5);
    const url = own[own.length - 1];
    if (!url) return { error: 'no audio stream seen' };
    const size = Number(url.searchParams.get('clen') || 0);
    for (const key of ['rn', 'rbuf', 'ump', 'srfvp', 'range']) url.searchParams.delete(key);
    url.searchParams.set('range', `0-${size ? size - 1 : 199999999}`);
    const response = await fetch(url.toString(), { credentials: 'include' });
    if (!response.ok) return { error: `audio stream answered ${response.status}` };
    return { data: await response.arrayBuffer() };
  }

  // SoundCloud: the stream the player asked SoundCloud for (its API's media address, client and authorization in it),
  // asked again; then its file, or its playlist's parts joined.
  async function soundCloud() {
    const asked = performance.getEntriesByType('resource').map((e) => e.name)
      .filter((n) => /api-v2\.soundcloud\.com\/media\/.*\/stream\/(hls|progressive)/.test(n));
    const media = asked[asked.length - 1];
    if (!media) return { error: 'no stream seen' };
    const located = await (await fetch(media)).json();
    if (!located || !located.url) return { error: 'no stream address' };
    if (/\/progressive/.test(media)) return { data: await (await fetch(located.url)).arrayBuffer() };
    const playlist = await (await fetch(located.url)).text();
    const base = located.url;
    const parts = [];
    const init = playlist.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (init) parts.push(new URL(init[1], base).toString());
    if (/#EXT-X-KEY:METHOD=(?!NONE)/.test(playlist)) return { error: 'stream is encrypted' };
    for (const line of playlist.split('\n')) if (line && !line.startsWith('#')) parts.push(new URL(line.trim(), base).toString());
    const buffers = [];
    for (let i = 0; i < parts.length; i += 6) {
      buffers.push(...await Promise.all(parts.slice(i, i + 6).map(async (p) => new Uint8Array(await (await fetch(p)).arrayBuffer()))));
    }
    const total = buffers.reduce((sum, b) => sum + b.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const b of buffers) { joined.set(b, at); at += b.length; }
    return { data: joined.buffer };
  }
}
