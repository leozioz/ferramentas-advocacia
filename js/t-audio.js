// Áudio: decodifica vídeo/áudio para 16 kHz mono, filtro de ruído opcional e cortes em pontos de silêncio.
export const SR = 16000;

export async function decodeTo16k(file) {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, SR, SR);
  let audio;
  try { audio = await ctx.decodeAudioData(buf); }
  catch (e) { throw new Error('Não foi possível ler o áudio deste arquivo. Formatos mais seguros: MP4, MP3, M4A, WAV, WEBM.'); }
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const n = audio.length, out = new Float32Array(n), ch = audio.numberOfChannels;
  for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return out;
}

// Filtro básico: corta graves (ruído de ar-condicionado, batidas), agudos acima da voz,
// comprime a dinâmica e normaliza o volume.
export async function cleanAudio(samples) {
  const ctx = new OfflineAudioContext(1, samples.length, SR);
  const b = ctx.createBuffer(1, samples.length, SR);
  b.copyToChannel(samples, 0);
  const src = ctx.createBufferSource(); src.buffer = b;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.7;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -32; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
  src.connect(hp); hp.connect(lp); lp.connect(comp); comp.connect(ctx.destination);
  src.start();
  const out = (await ctx.startRendering()).getChannelData(0);
  let peak = 0; for (let i = 0; i < out.length; i += 4) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.01) { const g = 0.95 / peak; for (let i = 0; i < out.length; i++) out[i] *= g; }
  return out;
}

function rms(a, s, e) { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / Math.max(1, e - s)); }

// Divide em fatias de ~90 s (o progresso anda com mais frequência), cortando no trecho mais silencioso perto de cada limite.
export function slicePoints(samples, target = 90, search = 6) {
  const pts = [0];
  const win = Math.floor(0.1 * SR);
  let pos = 0;
  while (samples.length - pos > (target + search) * SR) {
    const center = pos + target * SR;
    let best = center, bestE = Infinity;
    for (let s = center - search * SR; s < center + search * SR; s += win) {
      const e = rms(samples, s, s + win);
      if (e < bestE) { bestE = e; best = s + Math.floor(win / 2); }
    }
    pts.push(best); pos = best;
  }
  pts.push(samples.length);
  return pts;
}

export function isSilent(samples, s, e) { return rms(samples, s, e) < 0.004; }
