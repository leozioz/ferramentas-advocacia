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

  // Papel digitalizado tem sujeira na margem (sombra, furo, dobra) que vira "| : ; i" no começo e no fim
  // das linhas, e carimbos/timbres que viram letras sem sentido. Tira o lixo das pontas e as linhas ruins.
  const NOISE = /^[|:;!¡'"`´*~_=\\/\]\[{}()<>»«ijlvI1.,—–-]{1,2}$/;
  function cleanLines(raw, width) {
    const out = [];
    for (const l of raw) {
      let ws = (l.words || []).filter((w) => w.text.trim() && !/^[|¦]+$/.test(w.text));
      while (ws.length && NOISE.test(ws[0].text) && ws[0].confidence < 90) ws.shift();
      while (ws.length && NOISE.test(ws[ws.length - 1].text) && ws[ws.length - 1].confidence < 90) ws.pop();
      if (!ws.length) continue;
      const text = ws.map((w) => w.text).join(' ').replace(/\s+([,.;:!?)])/g, '$1').trim();
      const conf = ws.reduce((a, w) => a + w.confidence * w.text.length, 0) / ws.reduce((a, w) => a + w.text.length, 0);
      const letters = (text.match(/[A-Za-zÀ-ú0-9]/g) || []).length;
      if (conf < 60 || letters < text.length * 0.5) continue;
      out.push({ text, x0: ws[0].bbox.x0, x1: ws[ws.length - 1].bbox.x1, y0: Math.min(...ws.map((w) => w.bbox.y0)), y1: Math.max(...ws.map((w) => w.bbox.y1)) });
    }
    return out;
  }

  // Remonta os parágrafos pela geometria: recuo na primeira linha, espaço maior entre linhas,
  // ou linha anterior curta terminada em ponto.
  function toParagraphs(lines, width) {
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
    const right = med(lines.map((l) => l.x1));
    const h = med(lines.map((l) => l.y1 - l.y0)) || 10;
    const paras = [];
    let cur = null, prev = null;
    for (const l of lines) {
      // linhas do mesmo parágrafo quase se encostam (a caixa de uma invade a da outra)
      const gap = prev ? l.y0 - prev.y1 : 0;
      const novo = !cur || gap > h * 0.4 || gap < -h || l.x0 > prev.x0 + width * 0.03
        || (/[.:!?]$/.test(prev.text) && prev.x1 < right - width * 0.08);
      if (novo) paras.push(cur = { text: l.text });
      else cur.text = /-$/.test(cur.text) && /^[a-zà-ú]/.test(l.text) ? cur.text.slice(0, -1) + l.text : cur.text + ' ' + l.text;
      prev = l;
    }
    return paras.map((p) => p.text).filter((t) => (t.match(/[A-Za-zÀ-ú0-9]/g) || []).length >= 3);
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
      const lines = cleanLines(data.lines || [], img.width);
      const paragraphs = lines.length ? toParagraphs(lines, img.width)
        : (data.paragraphs || []).map((p) => p.text.replace(/-\n(?=[a-zà-ú])/g, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
      return { text: data.text || '', paragraphs, words, lines };
    } finally { onProg = null; }
  }

  window.OCR = { recognize };
})();
