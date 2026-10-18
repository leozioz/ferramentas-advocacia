// Worker de transcrição: Whisper (fala → texto). A voz de cada fala fica com js/voz-worker.js (CAM++).
// O modelo é baixado uma vez do Hugging Face e fica no cache do navegador.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;

let asr = null, asrKey = '';

async function gpuInfo() {
  try {
    if (!self.navigator.gpu) return null;
    const adapter = await self.navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return { f16: adapter.features.has('shader-f16') };
  } catch (e) { return null; }
}

const progress = (what) => (p) => self.postMessage({ type: 'progress', what, ...p });

async function loadAsr(model) {
  const gpu = await gpuInfo();
  const device = gpu ? 'webgpu' : 'wasm';
  const key = model + device;
  if (asrKey === key) return device;
  asr = null;
  const dtype = gpu
    ? { encoder_model: gpu.f16 && /large/.test(model) ? 'fp16' : 'fp32', decoder_model_merged: 'q4' }
    : 'q8';
  asr = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback: progress('asr') });
  asrKey = key;
  return device;
}

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'gpu') {
      self.postMessage({ type: 'gpu', id, gpu: await gpuInfo() });
    } else if (type === 'load') {
      self.postMessage({ type: 'ready', id, device: await loadAsr(data.model) });
    } else if (type === 'transcribe') {
      // max_new_tokens limita o "loop" do Whisper em trechos repetitivos ("Onde? Onde? Onde?…"),
      // que travava um trecho de 90 s por vários minutos. 30 s de fala rápida cabem em ~200 tokens.
      const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, task: data.task, max_new_tokens: 224 };
      if (data.language) opts.language = data.language;
      const out = await asr(data.audio, opts);
      const chunks = (out.chunks || []).map((c) => ({ start: c.timestamp[0], end: c.timestamp[1], text: c.text }));
      if (!chunks.length && out.text && out.text.trim()) chunks.push({ start: 0, end: data.audio.length / 16000, text: out.text });
      self.postMessage({ type: 'result', id, chunks });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id, message: (e && e.message) || String(e) });
  }
};
