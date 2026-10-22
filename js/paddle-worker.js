// OCR com PaddleOCR (PP-OCRv5: detecção de linhas + leitura com o modelo latino, que tem os acentos do
// português), em segundo plano com onnxruntime-web. Os modelos (~13 MB) vêm do Hugging Face na
// primeira vez e ficam no cache do navegador. Nada sai do computador: a imagem só passa por aqui.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.logLevel = 'error';

const HF = 'https://huggingface.co/PaddlePaddle/';
const DET = HF + 'PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx';
const REC = HF + 'latin_PP-OCRv5_mobile_rec_onnx/resolve/main/';
const UNCLIP = 0.4; // quanto a caixa cresce em volta da mancha detectada (fração da altura)

async function baixar(url, tipo) {
  const cache = await caches.open('paddle-ocr');
  let r = await cache.match(url);
  if (!r) { r = await fetch(url); if (!r.ok) throw new Error('Falha ao baixar o modelo de OCR'); await cache.put(url, r.clone()); }
  return tipo === 'texto' ? r.text() : new Uint8Array(await r.arrayBuffer());
}

let modelosP = null;
function modelos() {
  if (!modelosP) {
    modelosP = (async () => {
      const [det, rec, yml] = await Promise.all([baixar(DET), baixar(REC + 'inference.onnx'), baixar(REC + 'inference.yml', 'texto')]);
      // dicionário de caracteres: lista "  - x" depois de character_dict; índice 0 é o "vazio" do CTC
      const dict = yml.split('character_dict:')[1].split('\n').filter((l) => /^\s*- /.test(l))
        .map((l) => { const c = l.replace(/^\s*- /, ''); return /^'.*'$/.test(c) ? c.slice(1, -1).replace(/''/g, "'") : /^".*"$/.test(c) ? JSON.parse(c) : c; });
      const opts = { executionProviders: ['wasm'] };
      return {
        det: await ort.InferenceSession.create(det, opts),
        rec: await ort.InferenceSession.create(rec, opts),
        chars: ['', ...dict, ' '],
      };
    })().catch((e) => { modelosP = null; throw e; });
  }
  return modelosP;
}

function tela(W, H) {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  return [c, ctx];
}

// Detecção: mapa de probabilidade de "aqui tem texto"; cada mancha vira uma caixa de linha.
async function detectar(m, img) {
  const k = Math.min(1, 1920 / Math.max(img.width, img.height));
  const W = Math.max(32, Math.round(img.width * k / 32) * 32), H = Math.max(32, Math.round(img.height * k / 32) * 32);
  const [, ctx] = tela(W, H);
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data, n = W * H;
  const t = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) { // ordem BGR
    t[i] = (d[i * 4 + 2] / 255 - mean[0]) / std[0];
    t[n + i] = (d[i * 4 + 1] / 255 - mean[1]) / std[1];
    t[2 * n + i] = (d[i * 4] / 255 - mean[2]) / std[2];
  }
  const out = await m.det.run({ [m.det.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, H, W]) });
  const prob = out[m.det.outputNames[0]].data;
  const seen = new Uint8Array(n), boxes = [], stack = [];
  const sx = img.width / W, sy = img.height / H;
  for (let s = 0; s < n; s++) {
    if (seen[s] || prob[s] <= 0.3) continue;
    let sum = 0;
    const pts = [];
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % W;
      sum += prob[p]; pts.push(p);
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= n || seen[q] || prob[q] <= 0.3) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        seen[q] = 1; stack.push(q);
      }
    }
    if (pts.length < 10 || sum / pts.length < 0.6) continue;
    // folha escaneada fica um pouco torta: acha a inclinação da linha (em coordenadas da imagem)
    let mx = 0, my = 0;
    for (const p of pts) { mx += (p % W) * sx; my += Math.floor(p / W) * sy; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0;
    for (const p of pts) { const dx = (p % W) * sx - mx, dy = Math.floor(p / W) * sy - my; sxx += dx * dx; sxy += dx * dy; }
    const ang = Math.atan(sxx ? sxy / sxx : 0), cos = Math.cos(ang), sin = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of pts) {
      const dx = (p % W) * sx - mx, dy = Math.floor(p / W) * sy - my;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const len = u1 - u0 + sx, alt = v1 - v0 + sy;
    if (alt < 3 || len < 3) continue;
    const off = Math.min((len * alt * 1.5) / (2 * (len + alt)), alt * UNCLIP);
    const cx = mx + ((u0 + u1) / 2) * cos - ((v0 + v1) / 2) * sin, cy = my + ((u0 + u1) / 2) * sin + ((v0 + v1) / 2) * cos;
    const L = len + 2 * off, A = alt + 2 * off;
    const hw = (Math.abs(L * cos) + Math.abs(A * sin)) / 2, hh = (Math.abs(L * sin) + Math.abs(A * cos)) / 2;
    boxes.push({ cx, cy, ang, L, A, x0: Math.max(0, cx - hw), x1: Math.min(img.width, cx + hw), y0: Math.max(0, cy - hh), y1: Math.min(img.height, cy + hh) });
  }
  return boxes;
}

// Leitura de uma linha: recorta girando para ficar reta, altura 48 px, decodificação CTC
async function ler(m, img, b) {
  const W = Math.max(16, Math.min(3200, Math.ceil((48 * b.L) / b.A / 8) * 8)), H = 48;
  const [, ctx] = tela(W, H);
  ctx.scale(W / b.L, H / b.A);
  ctx.translate(b.L / 2, b.A / 2);
  ctx.rotate(-b.ang);
  ctx.translate(-b.cx, -b.cy);
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data, n = W * H;
  const t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    t[i] = (d[i * 4 + 2] / 255 - 0.5) / 0.5;
    t[n + i] = (d[i * 4 + 1] / 255 - 0.5) / 0.5;
    t[2 * n + i] = (d[i * 4] / 255 - 0.5) / 0.5;
  }
  const out = await m.rec.run({ [m.rec.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, H, W]) });
  const o = out[m.rec.outputNames[0]], [, T, C] = o.dims, p = o.data;
  let text = '', conf = 0, cnt = 0, last = 0;
  for (let i = 0; i < T; i++) {
    let best = 0, bp = -1;
    for (let c = 0; c < C; c++) if (p[i * C + c] > bp) { bp = p[i * C + c]; best = c; }
    if (best !== 0 && best !== last) { text += m.chars[best] || ''; conf += bp; cnt++; }
    last = best;
  }
  return { text: text.trim(), conf: cnt ? (conf / cnt) * 100 : 0 };
}

// Linhas com posição e confiança (0 a 100), no mesmo formato usado com o Tesseract
async function reconhecer(img, progresso) {
  const m = await modelos();
  const boxes = await detectar(m, img);
  const lidas = [];
  for (let i = 0; i < boxes.length; i++) {
    const r = await ler(m, img, boxes[i]);
    if (r.text) lidas.push({ ...boxes[i], ...r });
    progresso((i + 1) / boxes.length);
  }
  // caixas na mesma altura formam uma linha (texto com espaço grande às vezes vem partido)
  lidas.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const linhas = [];
  for (const b of lidas) {
    const cy = (b.y0 + b.y1) / 2;
    const l = linhas.find((x) => cy > x.y0 && cy < x.y1 && Math.abs((x.y0 + x.y1) / 2 - cy) < (b.y1 - b.y0) * 0.5);
    if (l) { l.partes.push(b); l.y0 = Math.min(l.y0, b.y0); l.y1 = Math.max(l.y1, b.y1); }
    else linhas.push({ y0: b.y0, y1: b.y1, partes: [b] });
  }
  return linhas.map((l) => {
    l.partes.sort((a, b) => a.x0 - b.x0);
    const len = l.partes.reduce((a, p) => a + p.text.length, 0);
    return {
      partes: l.partes.map((p) => ({ text: p.text, x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 })),
      text: l.partes.map((p) => p.text).join(' '),
      conf: l.partes.reduce((a, p) => a + p.conf * p.text.length, 0) / len,
      x0: l.partes[0].x0, x1: l.partes[l.partes.length - 1].x1, y0: l.y0, y1: l.y1,
    };
  }).filter((l) => l.conf >= 50).sort((a, b) => a.y0 - b.y0);
}

self.onmessage = async ({ data: { id, img } }) => {
  try {
    const lines = await reconhecer(img, (p) => self.postMessage({ id, progresso: p }));
    self.postMessage({ id, lines });
  } catch (e) {
    self.postMessage({ id, erro: String((e && e.message) || e) });
  } finally { img.close(); }
};
