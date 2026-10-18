// Fbank no padrão Kaldi (o que os modelos de voz WeSpeaker e 3D-Speaker esperam):
// 16 kHz, janela de 25 ms a cada 10 ms, Povey, pré-ênfase 0,97, FFT de 512, 80 faixas mel (20 Hz–8 kHz),
// log da potência e média subtraída (CMN). Retorna { data: Float32Array(T*80), frames: T }.
const SR = 16000, LEN = 400, SHIFT = 160, NFFT = 512, BINS = 80, LOW = 20, HIGH = 8000;
const mel = (f) => 1127 * Math.log(1 + f / 700);

const WINDOW = Float32Array.from({ length: LEN }, (_, n) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (LEN - 1)), 0.85));

// pesos das faixas mel (como em kaldi MelBanks): para cada faixa, primeiro bin e pesos
const BANKS = (() => {
  const mLow = mel(LOW), mHigh = mel(HIGH), delta = (mHigh - mLow) / (BINS + 1);
  const banks = [];
  for (let m = 0; m < BINS; m++) {
    const l = mLow + m * delta, c = l + delta, r = c + delta;
    let first = -1; const w = [];
    for (let i = 0; i < NFFT / 2; i++) {
      const mf = mel((SR * i) / NFFT);
      if (mf > l && mf < r) {
        if (first < 0) first = i;
        w.push(mf <= c ? (mf - l) / (c - l) : (r - mf) / (r - c));
      } else if (first >= 0) break;
    }
    banks.push({ first, w: Float32Array.from(w) });
  }
  return banks;
})();

// FFT radix-2 in-place (re, im)
const REV = (() => { const r = new Uint16Array(NFFT); const bits = Math.log2(NFFT); for (let i = 0; i < NFFT; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
const COS = Float32Array.from({ length: NFFT / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / NFFT));
const SIN = Float32Array.from({ length: NFFT / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / NFFT));
function fft(re, im) {
  for (let i = 0; i < NFFT; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let s = 0; s < NFFT; s += size) for (let k = 0; k < half; k++) {
      const wr = COS[k * step], wi = SIN[k * step], a = s + k, b = a + half;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

export function fbank(samples) {
  const T = samples.length < LEN ? 0 : 1 + Math.floor((samples.length - LEN) / SHIFT);
  const out = new Float32Array(T * BINS);
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT), frame = new Float32Array(LEN);
  for (let t = 0; t < T; t++) {
    let mean = 0;
    for (let i = 0; i < LEN; i++) { frame[i] = samples[t * SHIFT + i] * 32768; mean += frame[i]; }
    mean /= LEN;
    for (let i = 0; i < LEN; i++) frame[i] -= mean;
    for (let i = LEN - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
    frame[0] -= 0.97 * frame[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < LEN; i++) re[i] = frame[i] * WINDOW[i];
    fft(re, im);
    for (let m = 0; m < BINS; m++) {
      const { first, w } = BANKS[m];
      let e = 0;
      for (let k = 0; k < w.length; k++) { const i = first + k; e += w[k] * (re[i] * re[i] + im[i] * im[i]); }
      out[t * BINS + m] = Math.log(Math.max(e, 1.1920928955078125e-7));
    }
  }
  // CMN: tira a média de cada faixa ao longo do tempo
  for (let m = 0; m < BINS; m++) {
    let s = 0; for (let t = 0; t < T; t++) s += out[t * BINS + m];
    s /= Math.max(1, T);
    for (let t = 0; t < T; t++) out[t * BINS + m] -= s;
  }
  return { data: out, frames: T };
}
