// Starts the audio meter: the PC's own sound (WASAPI loopback, through Chromium) or, for previews,
// a made-up song with a kick drum, so the light can be seen move without anything playing.

export async function startMeter(source, onValue) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  await context.audioWorklet.addModule(new URL('./meter-worklet.js', import.meta.url).href);
  const meter = new AudioWorkletNode(context, 'meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  meter.port.onmessage = (event) => onValue(event.data);
  // Pulled by the graph but silent: the meter's output goes nowhere that can be heard.
  const mute = context.createGain();
  mute.gain.value = 0;
  meter.connect(mute).connect(context.destination);

  if (source === 'synth') {
    synth(context, meter);
    return context;
  }
  // The system's sound: the main process answers this request with the screen's loopback audio. Listened to only
  // while music plays (`listen`), and taken afresh when the sound moves to another output (headphones plugged in) or
  // the capture ends by itself.
  let stream = null, input = null, wanted = true, starting = null, settle = 0;
  const stop = () => {
    input?.disconnect(); input = null;
    stream?.getTracks().forEach((track) => track.stop()); stream = null;
  };
  const capture = () => {
    if (starting) return starting;
    starting = (async () => {
      stop();
      const taken = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      taken.getVideoTracks().forEach((track) => track.stop());
      if (!wanted) { taken.getTracks().forEach((track) => track.stop()); return; }
      stream = taken;
      input = context.createMediaStreamSource(taken);
      input.connect(meter);
      taken.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
        if (wanted && stream === taken) { console.warn('[audio] capture ended: taken again'); setTimeout(capture, 1000); }
      }));
      await context.resume();
    })().catch((error) => console.error('[audio] capture failed:', error.message)).finally(() => { starting = null; });
    return starting;
  };
  navigator.mediaDevices.addEventListener('devicechange', () => {
    clearTimeout(settle);
    settle = setTimeout(() => { if (wanted) { console.warn('[audio] the outputs changed: listening afresh'); capture(); } }, 1200);
  });
  await capture();
  context.listen = (on) => {
    if (on === wanted) return;
    wanted = on;
    if (on) { capture(); return; }
    // The meter falls to silence before the sound stops being heard, so the light comes to rest, not to a halt.
    stop();
    setTimeout(() => { if (!wanted) context.suspend(); }, 800);
  };
  return context;
}

/** 118 beats a minute: a kick on every beat, hats between, a soft pad; a quiet bar every 8 bars. */
function synth(context, into) {
  const bpm = 118, beat = 60 / bpm;
  const bus = context.createGain();
  bus.gain.value = 0.9;
  bus.connect(into);
  const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const pad = context.createOscillator();
  const padGain = context.createGain();
  pad.type = 'sawtooth'; pad.frequency.value = 196;
  padGain.gain.value = 0.05;
  pad.connect(padGain).connect(bus); pad.start();

  const kick = (time, strength) => {
    const o = context.createOscillator(), g = context.createGain();
    o.frequency.setValueAtTime(150, time);
    o.frequency.exponentialRampToValueAtTime(48, time + 0.12);
    g.gain.setValueAtTime(strength, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
    o.connect(g).connect(bus); o.start(time); o.stop(time + 0.35);
  };
  const hat = (time) => {
    const s = context.createBufferSource(), g = context.createGain(), f = context.createBiquadFilter();
    s.buffer = noise; f.type = 'highpass'; f.frequency.value = 7000;
    g.gain.setValueAtTime(0.12, time); g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    s.connect(f).connect(g).connect(bus); s.start(time); s.stop(time + 0.06);
  };
  let n = 0, next = context.currentTime + 0.1;
  const schedule = () => {
    while (next < context.currentTime + 0.4) {
      const bar = Math.floor(n / 4) % 8, quiet = bar === 7;
      if (!quiet) kick(next, 1);
      hat(next + beat / 2);
      next += beat; n++;
    }
  };
  setInterval(schedule, 100); schedule();
}
