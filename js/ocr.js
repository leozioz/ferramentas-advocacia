// OCR (reconhecimento de texto em imagens) com Tesseract, no navegador. Usado pelo conversor
// (foto → PDF pesquisável, PDF escaneado → Markdown) e pela leitura de atas escaneadas.
// O "dicionário" de português (~15 MB) é baixado uma vez e fica no cache do navegador.
(() => {
  let workerP = null, onProg = null;

  function getWorker() {
    if (!workerP) {
      workerP = Tesseract.createWorker('por', 1, {
        logger: (m) => { if (onProg && m.status === 'recognizing text') onProg(m.progress); },
      }).catch((e) => { workerP = null; throw e; });
    }
    return workerP;
  }

  // Reduz fotos muito grandes (celular, 4000 px) para acelerar; 2500 px no maior lado ainda lê letra pequena.
  function prepare(source) {
    const w = source.width, h = source.height, max = 2500;
    if (Math.max(w, h) <= max && source instanceof HTMLCanvasElement) return source;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  // Retorna o texto, os parágrafos e as palavras com a posição (em pixels da imagem original).
  async function recognize(source, onProgress) {
    const img = prepare(source);
    const k = source.width / img.width;
    const worker = await getWorker();
    onProg = onProgress || null;
    try {
      const { data } = await worker.recognize(img);
      const words = (data.words || []).filter((w) => w.text.trim() && w.confidence > 20).map((w) => ({
        text: w.text, x0: w.bbox.x0 * k, y0: w.bbox.y0 * k, x1: w.bbox.x1 * k, y1: w.bbox.y1 * k,
      }));
      const paragraphs = (data.paragraphs || []).map((p) => p.text.replace(/-\n(?=[a-zà-ú])/g, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
      return { text: data.text || '', paragraphs, words };
    } finally { onProg = null; }
  }

  window.OCR = { recognize };
})();
