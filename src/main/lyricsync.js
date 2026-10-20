// Untimed words (Genius's) timed to the song itself, on this computer (his ask, 2026-10-12: leaks' lyrics on time, with
// no paid service, on Mac and Windows alike). A port of LyricsSync.swift. The song's sound is had from its page
// (extension.audio), heard by Whisper — whisper.cpp, run as iBaila's own helper, with a model the user chose to
// download — and the words heard are matched in order to the lyrics (lyricsync-align.js, the Mac's matching to the
// letter). The result is kept (syncedlyrics.js): from then on the song's words come timed.
//
// The helpers are whisper.cpp built for Windows from the same source as the Mac's (resources/whisper/VERSION), with
// nothing of Visual C++'s to install: a fresh Windows 11 has all they need.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { unpacked } = require('./unpacked');
const align = require('./lyricsync-align');

const log = (...words) => console.log('[lyrics sync]', ...words);

// ---- the model ----

const MODEL_NAME = 'ggml-small-q5_1.bin';
const MODEL_SIZE = 190085487;
const MODEL_SOURCE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin';
const model = () => path.join(require('electron').app.getPath('userData'), 'Models', MODEL_NAME);
const helper = (name) => unpacked(path.join(__dirname, '../../resources/whisper', name));

function isInstalled() {
  try { return fs.statSync(model()).size === MODEL_SIZE; } catch { return false; }
}

/** Whether the user was asked once about the download; asked only once, at their first search for lyrics. */
function wasAsked() { return Boolean(require('./settings').get().lyricsSyncAsked); }
function setAsked(on) { require('./settings').set({ lyricsSyncAsked: Boolean(on) }); }

/** Downloads the model, telling how far it is (0…1): whether it arrived whole. */
async function download(progress) {
  const file = model();
  const part = `${file}.download`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const response = await fetch(MODEL_SOURCE);
    if (response.status !== 200 || !response.body) return false;
    const total = Number(response.headers.get('content-length')) || MODEL_SIZE;
    const out = fs.createWriteStream(part);
    let got = 0;
    for await (const chunk of response.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((done) => out.once('drain', done));
      progress(got / Math.max(total, MODEL_SIZE));
    }
    await new Promise((done, fail) => out.end((error) => (error ? fail(error) : done())));
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
  } catch (error) {
    log('model not downloaded:', error.message);
    try { fs.rmSync(part, { force: true }); } catch { /* gone */ }
    return false;
  }
  log('voice model downloaded:', isInstalled() ? 'whole' : 'not whole');
  return isInstalled();
}

// ---- timing ----

/** Times `lyrics` (untimed lines) to the song the browser page plays: every word timed, with what was heard (kept, so
 *  another version of the words can be timed again without listening), or why not.
 *  { timed, heard, voiced, length } or { why }. */
async function time(lyrics, page = undefined) {
  if (!isInstalled()) return { why: "the voice model isn't downloaded" };
  const lines = lyrics.lines.map((line) => line.text.trim()).filter(Boolean);
  if (!lines.length) return { why: 'no words' };
  const { samples, why } = await require('./extension').extension.audio(page);
  if (!samples) return { why };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ibaila-sync-'));
  try {
    const sound = path.join(folder, 'song.wav');
    fs.writeFileSync(sound, wav(samples));
    const started = Date.now();
    let heard = await hear(sound, folder);
    if (!heard) return { why: "Whisper didn't answer" };
    const voiced = await voices(sound);
    heard = await rehear(heard, voiced, samples, folder);
    log(`heard ${heard.length} words, ${voiced.length} stretches of voice, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const length = samples.length / 2 / 16000;
    return { timed: align.align(lines, heard, voiced, length), heard, voiced, length };
  } finally {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* left for Windows to clear */ }
  }
}

/** Whisper skips stretches of a song: taking a rapped intro for music, it wrote "(upbeat music)" and went on 30 s
 *  later (Plottin', Pop Star — Lil Mosey, 2026-10-12). A gap of over 8 s with no word heard where the voice detector
 *  heard someone is heard again on its own, from where the voice starts (LyricsSync.rehear; the choosing and the
 *  merging are lyricsync-align.js's, the Mac's to the letter): this hears each piece. */
function rehear(heard, voiced, samples, folder) {
  return align.rehear(heard, voiced, samples.length, async (from, to, first, last) => {
    // Half a second of quiet after it, so its last word isn't cut.
    const piece = path.join(folder, 'again.wav');
    fs.writeFileSync(piece, wav(Buffer.concat([samples.subarray(first, last), Buffer.alloc(16000)])));
    const again = await hear(piece, folder, 'again', from);
    if (again) log(`heard ${again.length} words again at ${from.toFixed(1)} s`);
    return again;
  });
}

/** 16 kHz mono 16-bit samples as a WAV file. */
function wav(samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

const run = (file, args, options = {}) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000, ...options },
    (error, stdout, stderr) => resolve({ error, out: `${stdout || ''}${stderr || ''}` }));
});

/** Whisper's words for the sound in `file`, each with when it starts; null when it didn't answer. */
async function hear(file, folder, name = 'heard', offset = 0) {
  const cli = helper('whisper-cli.exe');
  if (!fs.existsSync(cli)) { log("whisper-cli isn't in the app"); return null; }
  const output = path.join(folder, name);
  const threads = String(Math.max(os.cpus().length - 2, 2));
  const args = ['-m', model(), '-f', file, '-l', 'auto', '-dtw', 'small', '-nfa', '-ojf', '-of', output, '-np', '-t', threads];
  const heard = async (extra) => {
    try { fs.rmSync(`${output}.json`, { force: true }); } catch { /* none */ }
    const { error } = await run(cli, [...args, ...extra]);
    if (error) { log(`whisper failed${extra.length ? ' on the processor too' : ''}:`, error.message); return null; }
    try { return align.wordsFromWhisper(fs.readFileSync(`${output}.json`), offset); } catch { return null; }
  };
  // On the graphics card where there's one (Vulkan); a card whose driver fails it — one too old, a broken one, none
  // the test PC could show — is left out, and the same heard again on the processor alone.
  if (!gpuFailed) {
    const words = await heard([]);
    if (words) return words;
    gpuFailed = true;
    log('heard again without the graphics card');
  }
  return heard(['-ng']);
}
/** The graphics card failed Whisper once: not tried again until iBaila starts again. */
let gpuFailed = false;

/** Where someone sings in the sound in `file`, by Silero's voice detector (shipped with iBaila, 0.9 MB): it misses much
 *  singing, but tells a lone beat from a voice — where the words Whisper couldn't make out may go. */
async function voices(file) {
  const vad = helper('whisper-vad-speech-segments.exe');
  const silero = helper('ggml-silero-v5.1.2.bin');
  if (!fs.existsSync(vad) || !fs.existsSync(silero)) return [];
  const { out } = await run(vad, ['-vm', silero, '-f', file]);
  return align.voicesFromOutput(out);
}

module.exports = { isInstalled, wasAsked, setAsked, download, time, MODEL_SIZE };
