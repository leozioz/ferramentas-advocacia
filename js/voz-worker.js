// Worker da impressão digital de voz com modelos ONNX do sherpa-onnx (WeSpeaker / 3D-Speaker), no processador.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs';
import { fbank } from './fbank.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = 1;
let session = null, loaded = '';

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'load') {
      if (loaded !== data.url) {
        const buf = await (await fetch(data.url)).arrayBuffer();
        session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
        loaded = data.url;
      }
      self.postMessage({ type: 'ready', id, inputs: session.inputNames, outputs: session.outputNames });
    } else if (type === 'embed') {
      const vecs = [];
      for (let i = 0; i < data.clips.length; i++) {
        const clip = data.clips[i];
        if (!clip) { vecs.push(null); continue; }
        const f = fbank(clip);
        if (f.frames < 10) { vecs.push(null); continue; }
        const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', f.data, [1, f.frames, 80]) };
        const res = await session.run(feeds);
        vecs.push(Array.from(res[session.outputNames[0]].data));
        if (i % 10 === 0) self.postMessage({ type: 'embedProgress', id, done: i + 1, total: data.clips.length });
      }
      self.postMessage({ type: 'embeddings', id, vecs });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id, message: (e && e.message) || String(e) });
  }
};
