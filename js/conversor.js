(() => {
const $ = (id) => document.getElementById(id);
const items = [];        // {id, file|null, name, kind:'pdf'|'md', size, status, out:Blob, outName, md, error, sample}
let selected = null, busy = false, nextId = 1;

/* ---------- utilidades ---------- */
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const kindOf = (name) => /\.pdf$/i.test(name) ? 'pdf' : /\.(md|markdown|txt)$/i.test(name) ? 'md' : /\.(jpe?g|png)$/i.test(name) ? 'img' : null;
const baseOf = (name) => name.replace(/\.[^.]+$/, '');
const decode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

let dlPromise;
function getDownloads() {
  if (!window.claude || !window.claude.use) return Promise.resolve(undefined); // fora do visualizador: usa link comum
  return dlPromise || (dlPromise = window.claude.use('downloads'));
}
async function saveFile(filename, blob) {
  const dl = await getDownloads();
  if (dl === undefined) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return;
  }
  if (dl === null) { toast('Este visualizador não permite baixar arquivos.'); return; }
  try { await dl.save({ filename, data: blob }); toast('Arquivo salvo: ' + filename); }
  catch (e) {
    if (e && e.code === 'declined') return;
    if (e && e.code === 'rate_limited') toast('Já existe um pedido de download aberto. Conclua-o e tente de novo.');
    else toast('Não foi possível salvar: ' + (e && e.message || 'erro desconhecido'));
  }
}

/* ---------- PDF → Markdown ---------- */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

function groupLines(textItems) {
  const its = textItems.filter((i) => i.str !== undefined && i.transform).map((i) => {
    const t = i.transform;
    return { str: i.str, x: t[4], y: t[5], w: i.width, size: Math.round((Math.hypot(t[2], t[3]) || i.height || 10) * 10) / 10 };
  }).filter((i) => i.str.length);
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of its) {
    const ln = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2, it.size * 0.45));
    if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let text = '', end = null, best = null;
    ln.cells = [''];
    for (const it of ln.items) {
      if (end !== null && it.str.trim() && it.x - end > it.size * 1.6) ln.cells.push('');
      if (end !== null && it.x - end > it.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      text += it.str; ln.cells[ln.cells.length - 1] += ' ' + it.str;
      if (it.str.trim()) end = it.x + it.w;
      if (it.str.trim() && (!best || it.str.length > best.str.length)) best = it;
    }
    ln.text = text.replace(/\s+/g, ' ').trim();
    ln.cells = ln.cells.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
    ln.x = ln.items[0].x;
    ln.size = best ? best.size : ln.items[0].size;
  }
  return lines.filter((l) => l.text).sort((a, b) => b.y - a.y);
}

const BULLET = /^[•●○◦▪■□►▸‣⁃·\-–—*]\s+/;
const NUMBERED = /^(\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;

// Fração da página ocupada pela maior imagem (0 a 1), seguindo as transformações do PDF
async function imageCoverage(page) {
  const O = pdfjsLib.OPS, ops = await page.getOperatorList();
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const imgOps = new Set([O.paintImageXObject, O.paintJpegXObject, O.paintInlineImageXObject, O.paintImageMaskXObject].filter((x) => x !== undefined));
  let m = [1, 0, 0, 1, 0, 0], max = 0;
  const stack = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === O.save || fn === O.paintFormXObjectBegin) { stack.push(m); if (fn === O.paintFormXObjectBegin && args && args[0]) m = mul(args[0], m); }
    else if (fn === O.restore || fn === O.paintFormXObjectEnd) m = stack.pop() || m;
    else if (fn === O.transform) m = mul(args, m);
    else if (imgOps.has(fn)) max = Math.max(max, Math.abs(m[0] * m[3] - m[1] * m[2]));
  }
  const [x0, y0, x1, y1] = page.view;
  return max / Math.abs((x1 - x0) * (y1 - y0));
}

// Timbre e rodapé do escritório se repetem em toda página digitalizada (cada vez lidos um pouco
// diferente pelo OCR): tira as linhas que aparecem, parecidas, em metade ou mais das páginas. Tira
// também o carimbo de assinatura eletrônica do tribunal, inteiro ou em pedaços.
function dropRepeated(ocrPages) {
  const STAMP = /verificadocs|confira autenticidade|assinado eletronicamente|informando \d{6,}|bonsembiante|biante campana|^\W*\w{0,6}\s*p?ágina \d+\s*\/\s*\d+/i;
  const grams = (s) => { const t = s.toLowerCase().replace(/[^a-zà-ú0-9]/g, ''), g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
  const sim = (a, b) => {
    if (Math.min(a.size, b.size) < Math.max(a.size, b.size) * 0.6) return 0;
    let n = 0; for (const x of a) if (b.has(x)) n++;
    return (2 * n) / (a.size + b.size || 1);
  };
  const pgs = [...ocrPages.entries()].map(([k, pg]) => [k, pg.lines.map((l) => ({ l, g: grams(l.text), y: l.y0 / pg.height }))]);
  const min = Math.max(3, Math.ceil(pgs.length / 2));
  for (const [k, ls] of pgs) {
    ocrPages.get(k).lines = ls.filter((p) => {
      if (STAMP.test(p.l.text)) return false;
      if (p.y > 0.88 && /mail|@|www\.|\.com\b|telefone|fone:|cel:/i.test(p.l.text)) return false; // contato no rodapé
      if (pgs.length < 3 || p.l.text.length > 160) return true;
      // igual em outras páginas; ou, no topo/pé da página, na mesma altura e só parecido (o OCR do
      // rodapé varia muito de uma página para outra)
      const margem = p.y < 0.12 || p.y > 0.85;
      const seen = pgs.filter(([k2, ls2]) => k2 === k || ls2.some((q) => sim(p.g, q.g) > 0.6
        || (margem && Math.abs(q.y - p.y) < 0.015 && sim(p.g, q.g) > 0.3))).length;
      return seen < min;
    }).map((p) => p.l);
  }
}

// Erros do OCR que dá para consertar sem risco de estragar palavra certa
function fixOcr(t) {
  return t
    .replace(/([a-zà-ú])!(?=[\s,.;:)]|$)/g, '$1l') // "polícia!" → "polícia"
    .replace(/(?:\b8|&) (\d{1,2}º)/g, '§ $1') // "art. 286, 8 2º" → "§ 2º"
    .replace(/\s*\S{0,3}\s*biante C\S*\s*\S*\s*\S{0,4}gi(?:na)? \d+\s*\/\s*\d+/gi, '') // pedaço do carimbo grudado na linha
    .replace(/\bCT8\b|\bCTi B\b|\bCT B\b/g, 'CTB')
    .replace(/\/STI\b/g, '/STJ')
    .replace(/\bbJe\b/g, 'DJe')
    .replace(/\b(\d{3}\.\d{3})[,.](\d{3}-\d{2})\b/g, '$1.$2') // CPF
    .replace(/\b(OAB\/[A-Z]{2}\s*\d{2,3})[,.](\d{3})\b/g, '$1.$2')
    .replace(/\b(Vol\.?,?)\s*\|/g, '$1 I')
    .replace(/\b(?=[O0-9.\-/]{6,}\b)(?=[O0-9.\-/]*\d)[O0-9][O0-9.\-/]*\b/g, (m) => m.replace(/O/g, '0')) // "7OO60998242"
    // títulos em romano: "1t= DO DIREITO", "il.a -", "Il.c —", "IV —="
    // (sem traço só quando vem uma palavra toda em maiúsculas: "Ill DOS REQUISITOS")
    .replace(/^([1Iilt]{1,3}V?|V)(?:[.:]\s?([a-c])[a-z]?)?(?:\s*[-—–=]+[=\s]*|\s+(?=[A-ZÀ-Ú]{3,}\b))(?=[A-ZÀ-Ú])/, (m, r, s) => r.replace(/[1ilt]/g, 'I') + (s ? '.' + s : '') + ' – ');
}

async function pdfToMarkdown(buf, opts) {
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages = [];
  const ocrPages = new Map(); // página sem texto (digitalizada) → parágrafos lidos por OCR
  const weight = new Map();
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = groupLines(tc.items);
    pages.push(lines);
    for (const l of lines) weight.set(l.size, (weight.get(l.size) || 0) + l.text.length);
    const chars = lines.reduce((a, l) => a + l.text.length, 0);
    // digitalizada: sem texto, ou uma imagem cobrindo a página com pouco texto por cima
    // (carimbo de assinatura eletrônica, número de página)
    if (window.OCR && (chars < 20 || (chars < 600 && await imageCoverage(page) > 0.5))) {
      // desenha a ~200 dpi e lê com OCR
      const vp = page.getViewport({ scale: 200 / 72 });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise; // 'print': não depende da aba estar visível
      const r = await OCR.recognize(c, (q) => opts.onProgress && opts.onProgress((p - 1 + q) / pdf.numPages, `Lendo a página ${p} de ${pdf.numPages} (OCR)`));
      if (r.lines.length) ocrPages.set(p - 1, { lines: r.lines, width: r.width, height: r.height });
      c.width = c.height = 0;
    }
    page.cleanup();
  }
  const totalChars = [...weight.values()].reduce((a, b) => a + b, 0);
  if (!totalChars && !ocrPages.size) {
    await pdf.destroy();
    throw new Error('Não foi encontrado texto no PDF, nem por OCR. Confira se a digitalização está legível.');
  }
  const body = totalChars ? [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
  const headSizes = [...weight.keys()].filter((s) => s >= body * 1.15 && weight.get(s) < totalChars * 0.3).sort((a, b) => b - a).slice(0, 4);
  const level = (s) => { const i = headSizes.indexOf(s); return i < 0 ? 0 : i + 1; };

  dropRepeated(ocrPages);
  for (const [k, pg] of ocrPages) ocrPages.set(k, OCR.toParagraphs(pg.lines, pg.width).map(fixOcr));

  const blocks = [];
  pages.forEach((lines, pi) => {
    if (pi > 0 && opts.pageBreaks) blocks.push({ type: 'raw', text: '---' });
    if (ocrPages.has(pi)) {
      // o OCR às vezes quebra o parágrafo no meio da frase: junta quando a anterior não terminou
      // (sem ponto final) e a seguinte começa com minúscula
      // (também entre páginas: parágrafo que continua na página seguinte)
      const paras = [];
      const ult = blocks[blocks.length - 1];
      const vemDeAntes = ult && ult.type === 'p' && ocrPages.has(pi - 1);
      let antes = vemDeAntes ? ult.text : null;
      for (let t of ocrPages.get(pi)) {
        if (/^8\)/.test(t) && /^f\)/.test(paras[paras.length - 1] || antes || '')) t = 'g' + t.slice(1); // "g)" lido como "8)"
        const prev = paras.length ? paras[paras.length - 1] : antes;
        if (prev && !/[.:;!?]$/.test(prev) && /^[a-zà-ú(]/.test(t)) {
          if (paras.length) paras[paras.length - 1] = prev + ' ' + t;
          else ult.text = antes = prev + ' ' + t;
        } else paras.push(t);
      }
      for (const t of paras) {
        if (/^\d{1,4}$/.test(t)) continue; // número de página
        if (BULLET.test(t)) blocks.push({ type: 'li', text: t.replace(BULLET, ''), x: 0, ord: false });
        else blocks.push({ type: 'p', text: t });
      }
      return;
    }
    let cur = null, prev = null;
    lines.forEach((l, li) => {
      if (/^\d{1,4}(\s*(de|of|\/)\s*\d{1,4})?$|^(página|page|pág\.?)\s*\d+(\s*(de|of|\/)\s*\d+)?$/i.test(l.text) && (li === 0 || li === lines.length - 1)) return;
      const gap = prev ? prev.y - l.y : 0;
      const lvl = level(l.size);
      if (l.cells.length >= 2 && !BULLET.test(l.text)) {
        if (cur && cur.type === 'table' && cur.rows[0].length === l.cells.length) cur.rows.push(l.cells);
        else blocks.push(cur = { type: 'table', rows: [l.cells] });
      } else if (lvl && l.text.length < 200) {
        if (cur && cur.type === 'h' && cur.lvl === lvl && gap < l.size * 1.8) cur.text += ' ' + l.text;
        else blocks.push(cur = { type: 'h', lvl, text: l.text });
      } else if (BULLET.test(l.text)) {
        blocks.push(cur = { type: 'li', text: l.text.replace(BULLET, ''), x: l.x, ord: false });
      } else if (NUMBERED.test(l.text) && (!cur || cur.type !== 'p' || gap > l.size * 1.6 || cur.type === 'li')) {
        const m = l.text.match(NUMBERED);
        blocks.push(cur = { type: 'li', text: l.text.slice(m[0].length), marker: m[1], x: l.x, ord: true });
      } else if (cur && (cur.type === 'p' || cur.type === 'li') && prev && gap > 0 && gap < prev.size * 1.75 && (cur.type === 'p' || l.x > cur.x + 2)) {
        cur.text = cur.text.endsWith('-') && /^[a-zà-ú]/.test(l.text) ? cur.text.slice(0, -1) + l.text : cur.text + ' ' + l.text;
      } else {
        blocks.push(cur = { type: 'p', text: l.text });
      }
      prev = l;
    });
  });
  await pdf.destroy();

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'table') {
      const cell = (c) => c.replace(/\|/g, '\\|');
      if (b.rows.length < 2) { out.push(b.rows[0].join(' ')); continue; }
      out.push([b.rows[0], b.rows[0].map(() => '---'), ...b.rows.slice(1)].map((r) => '| ' + r.map(cell).join(' | ') + ' |').join('\n'));
    } else if (b.type === 'h') out.push('#'.repeat(Math.min(b.lvl, 6)) + ' ' + b.text);
    else if (b.type === 'li') {
      const group = [];
      while (i < blocks.length && blocks[i].type === 'li') { const c = blocks[i++]; group.push((c.ord ? c.marker.replace(/[()]/g, '').replace(/\.?$/, '.') : '-') + ' ' + c.text); }
      i--; out.push(group.join('\n'));
    } else out.push(b.text);
  }
  return out.join('\n\n') + '\n';
}

/* ---------- Markdown → PDF ---------- */
const PDF_COLORS = { text: '#1b2420', muted: '#5d6a64', rule: '#c9d1cc', fill: '#f1f3f2', link: '#1f6f5c' };

function inline(tokens, base) {
  base = base || {};
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text': if (t.tokens) out.push(...inline(t.tokens, base)); else out.push({ ...base, text: decode(t.text) }); break;
      case 'strong': out.push(...inline(t.tokens, { ...base, bold: true })); break;
      case 'em': out.push(...inline(t.tokens, { ...base, italics: true })); break;
      case 'del': out.push(...inline(t.tokens, { ...base, decoration: 'lineThrough' })); break;
      case 'codespan': out.push({ ...base, text: decode(t.text), background: PDF_COLORS.fill, fontSize: 9.5 }); break;
      case 'link': out.push(...inline(t.tokens, { ...base, link: t.href, color: PDF_COLORS.link, decoration: 'underline' })); break;
      case 'image': out.push({ ...base, text: '[imagem: ' + (t.text || t.href) + ']', italics: true, color: PDF_COLORS.muted }); break;
      case 'br': out.push({ text: '\n' }); break;
      case 'escape': out.push({ ...base, text: decode(t.text) }); break;
      case 'html': { const s = t.text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''); if (s) out.push({ ...base, text: decode(s) }); break; }
      default: out.push({ ...base, text: decode(t.text || t.raw || '') });
    }
  }
  return out.length ? out : [{ text: '' }];
}

function blocks(tokens, width) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'heading': out.push({ text: inline(t.tokens), style: 'h' + Math.min(t.depth, 4) }); break;
      case 'paragraph': out.push({ text: inline(t.tokens), margin: [0, 0, 0, 8] }); break;
      case 'text': out.push({ text: t.tokens ? inline(t.tokens) : decode(t.text) }); break;
      case 'list': {
        const lis = t.items.map((it) => {
          const b = blocks(it.tokens, width - 16);
          if (it.task) b.unshift({ text: it.checked ? '[x]' : '[ ]', fontSize: 9, color: PDF_COLORS.muted });
          return b.length === 1 ? b[0] : { stack: b };
        });
        const node = { margin: [0, 0, 0, 8] };
        node[t.ordered ? 'ol' : 'ul'] = lis;
        if (t.ordered && t.start > 1) node.start = t.start;
        out.push(node); break;
      }
      case 'code':
        out.push({ table: { widths: ['*'], body: [[{ text: t.text, fontSize: 9, preserveLeadingSpaces: true, fillColor: PDF_COLORS.fill, margin: [6, 5, 6, 5] }]] }, layout: 'noBorders', margin: [0, 2, 0, 10] }); break;
      case 'blockquote':
        out.push({ table: { widths: ['*'], body: [[{ stack: blocks(t.tokens, width - 14), color: PDF_COLORS.muted, margin: [8, 0, 0, 0] }]] },
          layout: { hLineWidth: () => 0, vLineWidth: (i) => i === 0 ? 2.5 : 0, vLineColor: () => PDF_COLORS.rule, paddingTop: () => 2, paddingBottom: () => 0 }, margin: [0, 0, 0, 8] }); break;
      case 'table': {
        const head = t.header.map((c) => ({ text: inline(c.tokens), bold: true, fillColor: PDF_COLORS.fill }));
        const rows = t.rows.map((r) => r.map((c) => ({ text: inline(c.tokens) })));
        out.push({ table: { headerRows: 1, widths: head.map(() => '*'), body: [head, ...rows] },
          layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => PDF_COLORS.rule, vLineColor: () => PDF_COLORS.rule },
          fontSize: 9.5, margin: [0, 2, 0, 10] }); break;
      }
      case 'hr': out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.6, lineColor: PDF_COLORS.rule }], margin: [0, 6, 0, 12] }); break;
      case 'html': { const s = t.text.replace(/<[^>]+>/g, '').trim(); if (s) out.push({ text: decode(s), margin: [0, 0, 0, 8] }); break; }
      case 'space': break;
      default: if (t.text) out.push({ text: decode(t.text), margin: [0, 0, 0, 8] });
    }
  }
  return out;
}

const PAGE_W = { A4: 595.28, LETTER: 612, LEGAL: 612 };
function markdownToPdf(md, title, pageSize) {
  const margin = 56, width = PAGE_W[pageSize] - margin * 2;
  const doc = {
    pageSize, pageMargins: [margin, 60, margin, 60], info: { title },
    content: blocks(marked.lexer(md.replace(/^﻿/, '')), width),
    defaultStyle: { fontSize: 10.5, lineHeight: 1.3, color: PDF_COLORS.text },
    styles: {
      h1: { fontSize: 20, bold: true, margin: [0, 6, 0, 10] },
      h2: { fontSize: 15.5, bold: true, margin: [0, 10, 0, 6] },
      h3: { fontSize: 12.5, bold: true, margin: [0, 8, 0, 4] },
      h4: { fontSize: 11, bold: true, margin: [0, 6, 0, 4] },
    },
    footer: (c, n) => ({ text: c + ' / ' + n, alignment: 'center', fontSize: 8, color: PDF_COLORS.muted, margin: [0, 24, 0, 0] }),
  };
  if (!doc.content.length) doc.content = [{ text: '' }];
  return new Promise((resolve, reject) => {
    try { pdfMake.createPdf(doc).getBlob(resolve); } catch (e) { reject(e); }
  });
}

/* ---------- imagens ⇄ PDF ---------- */
const PAGE_H = { A4: 841.89, LETTER: 792, LEGAL: 1008 };

// Uma página por imagem, ajustada ao papel. Com OCR, o PDF sai "pesquisável": a foto visível e, por trás,
// o texto reconhecido invisível (modo de texto 3), palavra por palavra na posição certa. Dá para selecionar,
// buscar (Ctrl+F), copiar e converter para Markdown, como num PDF salvo pelo Word.
async function imagesToPdf(files, pageSize, title, { ocr = false, onProgress } = {}) {
  const { PDFDocument, StandardFonts, PDFNumber, PDFOperator } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = ocr ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const op = (name, ...args) => PDFOperator.of(name, args);
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const bmp = await createImageBitmap(file); // respeita a orientação da foto (EXIF)
    const isPng = /png$/i.test(file.type) || /\.png$/i.test(file.name);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    if (!isPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, isPng ? 'image/png' : 'image/jpeg', 0.92))).arrayBuffer());
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const landscape = c.width > c.height, m = 28;
    const [pw, ph] = landscape ? [PAGE_H[pageSize], PAGE_W[pageSize]] : [PAGE_W[pageSize], PAGE_H[pageSize]];
    const k = Math.min((pw - m * 2) / c.width, (ph - m * 2) / c.height);
    const w = c.width * k, h = c.height * k, ox = (pw - w) / 2, oy = (ph - h) / 2;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: ox, y: oy, width: w, height: h });
    if (ocr) {
      const r = await OCR.recognize(c, (p) => onProgress && onProgress((i + p) / files.length));
      const key = page.node.newFontDictionary(font.name, font.ref);
      const ops = [op('BT'), op('Tr', PDFNumber.of(3))];
      for (const wd of r.words) {
        // Helvetica cobre o português (WinAnsi); caractere fora disso vira "?"
        const text = [...wd.text].map((ch) => { try { font.encodeText(ch); return ch; } catch (e) { return '?'; } }).join('');
        const bw = (wd.x1 - wd.x0) * k, bh = (wd.y1 - wd.y0) * k;
        if (bw <= 0 || bh <= 0) continue;
        const size = Math.max(1, bh * 0.92);
        const natural = font.widthOfTextAtSize(text, size) || 1;
        ops.push(
          op('Tf', key, PDFNumber.of(size)),
          op('Tz', PDFNumber.of((bw / natural) * 100)),
          op('Tm', PDFNumber.of(1), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1), PDFNumber.of(ox + wd.x0 * k), PDFNumber.of(oy + h - wd.y1 * k + bh * 0.18)),
          op('Tj', font.encodeText(text + ' ')),
        );
      }
      ops.push(op('ET'));
      page.pushOperators(...ops);
    }
    c.width = c.height = 0;
    if (!ocr && onProgress) onProgress((i + 1) / files.length);
  }
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

async function pdfToImages(buf, fmt, dpi, base) {
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const n = pdf.numPages, pad = Math.max(2, String(n).length), outs = [];
  const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise; // 'print': não depende da aba estar visível
    const blob = await new Promise((r) => c.toBlob(r, mime, 0.9));
    c.width = c.height = 0;
    page.cleanup();
    outs.push({ name: n === 1 ? `${base}.${fmt}` : `${base}-p${String(p).padStart(pad, '0')}.${fmt}`, blob });
  }
  await pdf.destroy();
  return outs;
}

/* ---------- fila ---------- */
// item: {id, file, name, kind:'pdf'|'md'|'img'|'combined', size, status, target, outs:[{name, blob}], md, error, note}
function addFiles(files) {
  let skipped = 0;
  for (const f of files) {
    const kind = kindOf(f.name);
    if (!kind) { skipped++; continue; }
    items.push({ id: nextId++, file: f, name: f.name, kind, size: f.size, status: 'queued', outs: [] });
  }
  if (skipped) toast(skipped + ' arquivo(s) ignorado(s): só .pdf, .md, .txt, .jpg e .png.');
  render();
}

const STATUS = { queued: 'Na fila', working: 'Convertendo…', done: 'Pronto', error: 'Erro' };
const pdfTarget = () => $('pdfTarget').value;
function dirLabel(it) {
  if (it.kind === 'pdf') return 'PDF<br>→ ' + (it.status === 'done' ? it.target : pdfTarget()).toUpperCase();
  if (it.kind === 'md') return 'MD<br>→ PDF';
  if (it.kind === 'combined') return 'IMGs<br>→ PDF';
  return (/\.png$/i.test(it.name) ? 'PNG' : 'JPG') + '<br>→ PDF';
}
function outSummary(it) {
  if (it.note) return ' · ' + esc(it.note);
  if (!it.outs.length) return '';
  if (it.outs.length === 1) return ' → ' + esc(it.outs[0].name) + ' · ' + fmtSize(it.outs[0].blob.size);
  return ` → ${it.outs.length} imagens · ` + fmtSize(it.outs.reduce((a, o) => a + o.blob.size, 0));
}

function render() {
  const list = $('list');
  if (!items.length) {
    list.innerHTML = '<div class="empty">Nenhum arquivo na lista. Adicione PDFs, Markdown ou imagens acima.</div>';
  } else {
    list.innerHTML = items.map((it) => `
      <div class="row${it.id === selected ? ' sel' : ''}" data-id="${it.id}">
        <div class="dir">${dirLabel(it)}</div>
        <div class="name"><div class="fn">${esc(it.name)}</div>
          <div class="meta">${fmtSize(it.size)}${it.prog ? ' · ' + esc(it.prog) : outSummary(it)}${it.error ? ' · ' + esc(it.error) : ''}</div></div>
        <span class="chip ${it.status}">${STATUS[it.status]}</span>
        <div class="actions">
          ${it.outs.length ? `<button class="link" data-act="save" data-id="${it.id}">Baixar</button>` : ''}
          <button class="link" data-act="remove" data-id="${it.id}" aria-label="Remover ${esc(it.name)}">Remover</button>
        </div>
      </div>`).join('');
  }
  const done = items.filter((i) => i.status === 'done').length;
  const pending = items.filter((i) => i.status === 'queued' || i.status === 'error').length;
  $('count').textContent = items.length ? `${items.length} arquivo(s) · ${done} pronto(s)` + (pending ? ` · ${pending} aguardando` : '') : '';
  $('convertAll').disabled = busy || !pending;
  $('zipAll').disabled = busy || !items.some((i) => i.outs.length);
  $('clearAll').disabled = busy || !items.length;
  $('prog').style.width = items.length ? (done / items.length * 100) + '%' : '0';
  const t = pdfTarget();
  $('dpiWrap').hidden = t === 'md';
  $('breaksWrap').hidden = t !== 'md';
  renderPreview();
}

const urls = new WeakMap();
const urlOf = (blob) => { let u = urls.get(blob); if (!u) { u = URL.createObjectURL(blob); urls.set(blob, u); } return u; };

function thumbs(outs) {
  const shown = outs.slice(0, 60);
  return '<div class="thumbs">' + shown.map((o) => `<figure><img src="${urlOf(o.blob)}" alt="${esc(o.name)}" loading="lazy"><figcaption>${esc(o.name)}</figcaption></figure>`).join('') + '</div>' +
    (outs.length > shown.length ? `<p class="count">E mais ${outs.length - shown.length} imagem(ns) no download.</p>` : '');
}

function renderPreview() {
  const it = items.find((i) => i.id === selected);
  const pv = $('preview');
  if (!it) { pv.hidden = true; return; }
  pv.hidden = false;
  $('pvTitle').textContent = it.outs.length === 1 ? it.outs[0].name : it.name;
  const acts = $('pvActions'), body = $('pvBody');
  acts.innerHTML = it.outs.length ? `<button class="link" id="pvSave">${it.outs.length > 1 ? 'Baixar imagens (.zip)' : 'Baixar'}</button>` : '';
  if (it.status === 'error') { body.innerHTML = `<p class="err-msg">${esc(it.error)}</p>`; }
  else if (it.kind === 'pdf' && it.status === 'done' && it.target === 'md') {
    acts.innerHTML = '<button class="link" id="pvCopy">Copiar texto</button>' + acts.innerHTML;
    body.innerHTML = '<pre class="md"></pre>';
    body.firstChild.textContent = it.md;
    $('pvCopy').onclick = () => {
      navigator.clipboard.writeText(it.md).then(() => toast('Markdown copiado.'), () => {
        const r = document.createRange(); r.selectNodeContents(body.firstChild);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Texto selecionado. Use Ctrl+C para copiar.');
      });
    };
  } else if (it.kind === 'pdf' && it.status === 'done') {
    body.innerHTML = thumbs(it.outs);
  } else if (it.kind === 'pdf') {
    body.innerHTML = '<p class="count">Converta para ver o resultado.</p>';
  } else if (it.kind === 'img') {
    body.innerHTML = `<img class="single-img" src="${urlOf(it.file)}" alt="${esc(it.name)}">`;
  } else if (it.kind === 'combined') {
    body.innerHTML = `<p class="count">PDF com ${it.sources.length} página(s), uma por imagem, nesta ordem:</p>` + thumbs(it.sources.map((f) => ({ name: f.name, blob: f })));
  } else {
    getText(it).then((txt) => {
      if (selected !== it.id) return;
      body.innerHTML = '<div class="rendered"></div>';
      body.firstChild.innerHTML = marked.parse(esc(txt).replace(/^&gt;/gm, '>'));
    });
  }
  const sv = $('pvSave'); if (sv) sv.onclick = () => saveItem(it);
}

// Andamento de conversões longas (OCR), mostrado na linha do arquivo
let progT = 0;
function progress(it, msg, p) {
  it.prog = `${msg}… ${Math.round(p * 100)}%`;
  const now = performance.now();
  if (now - progT > 250 || p >= 1) { progT = now; render(); }
}

async function getText(it) { return it.text != null ? it.text : (it.text = await it.file.text()); }

async function convert(it) {
  it.status = 'working'; it.error = null; it.note = null; it.outs = []; render();
  try {
    const base = baseOf(it.name);
    if (it.kind === 'pdf') {
      it.target = pdfTarget();
      const buf = await it.file.arrayBuffer();
      if (it.target === 'md') {
        it.md = await pdfToMarkdown(buf, { pageBreaks: $('pageBreaks').checked, onProgress: (p, msg) => progress(it, msg, p) });
        it.outs = [{ name: base + '.md', blob: new Blob([it.md], { type: 'text/markdown' }) }];
      } else {
        it.outs = await pdfToImages(buf, it.target, +$('dpi').value, base);
      }
    } else if (it.kind === 'img') {
      const ocr = $('imgOcr').checked;
      const blob = await imagesToPdf([it.file], $('pageSize').value, base, { ocr, onProgress: (p) => progress(it, 'Lendo o texto da imagem', p) });
      it.outs = [{ name: base + '.pdf', blob }];
    } else {
      it.outs = [{ name: base + '.pdf', blob: await markdownToPdf(await getText(it), base, $('pageSize').value) }];
    }
    it.status = 'done'; it.prog = null;
  } catch (e) {
    it.prog = null;
    it.status = 'error'; it.error = (e && e.message) || 'Falha na conversão';
    if (/password/i.test(it.error)) it.error = 'PDF protegido por senha.';
    if (/Invalid PDF/i.test(it.error)) it.error = 'Arquivo PDF inválido ou corrompido.';
    if (it.kind === 'img' && /decode|source image|InvalidState/i.test(it.error)) it.error = 'Não foi possível ler a imagem.';
  }
  render();
}

async function convertMergedImages(imgs) {
  imgs.forEach((i) => { i.status = 'working'; i.error = null; i.outs = []; });
  render();
  const name = 'imagens-' + new Date().toISOString().slice(0, 10) + '.pdf';
  try {
    const blob = await imagesToPdf(imgs.map((i) => i.file), $('pageSize').value, baseOf(name),
      { ocr: $('imgOcr').checked, onProgress: (p) => imgs.forEach((i) => progress(i, 'Lendo o texto das imagens', p)) });
    imgs.forEach((i) => (i.prog = null));
    const combined = { id: nextId++, kind: 'combined', name, size: imgs.reduce((a, i) => a + i.size, 0), status: 'done', outs: [{ name, blob }], sources: imgs.map((i) => i.file) };
    items.splice(items.indexOf(imgs[0]), 0, combined);
    imgs.forEach((i) => { i.status = 'done'; i.note = 'incluída em ' + name; });
    selected = combined.id;
  } catch (e) {
    imgs.forEach((i) => { i.status = 'error'; i.error = 'Não foi possível juntar as imagens: ' + ((e && e.message) || 'erro'); });
  }
  render();
}

async function convertAll() {
  busy = true; render();
  const todo = items.filter((i) => i.status === 'queued' || i.status === 'error');
  const merge = $('imgMode').value === 'merge';
  const imgs = todo.filter((i) => i.kind === 'img');
  for (const it of todo) if (!(merge && imgs.length > 1 && it.kind === 'img')) await convert(it);
  if (merge && imgs.length > 1) await convertMergedImages(imgs);
  busy = false; render();
  const errs = items.filter((i) => i.status === 'error').length;
  toast(errs ? `Concluído com ${errs} erro(s).` : 'Todos os arquivos foram convertidos.');
}

async function zipOf(entries) {
  const zip = new JSZip(), used = new Set();
  for (const { path, blob } of entries) {
    let n = path, k = 2;
    while (used.has(n.toLowerCase())) n = path.replace(/(\.[^.\/]+)$/, ` (${k++})$1`);
    used.add(n.toLowerCase()); zip.file(n, blob);
  }
  return zip.generateAsync({ type: 'blob' });
}

async function saveItem(it) {
  if (it.outs.length === 1) return saveFile(it.outs[0].name, it.outs[0].blob);
  const blob = await zipOf(it.outs.map((o) => ({ path: o.name, blob: o.blob })));
  return saveFile(baseOf(it.name) + '-' + it.target + '.zip', blob);
}

async function zipAll() {
  const entries = [];
  for (const it of items) {
    if (it.outs.length === 1) entries.push({ path: it.outs[0].name, blob: it.outs[0].blob });
    else for (const o of it.outs) entries.push({ path: baseOf(it.name) + '/' + o.name, blob: o.blob });
  }
  await saveFile('convertidos-' + new Date().toISOString().slice(0, 10) + '.zip', await zipOf(entries));
}

/* ---------- eventos ---------- */
const drop = $('drop'), picker = $('picker');
drop.addEventListener('click', () => picker.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (!drop.contains(e.target) && !$('tab-conversor').hidden) addFiles([...e.dataTransfer.files]); });

$('list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation();
    const idx = items.findIndex((i) => i.id === +btn.dataset.id);
    if (btn.dataset.act === 'remove' && !busy) {
      const gone = items[idx];
      if (selected === gone.id) selected = null;
      items.splice(idx, 1);
      if (gone.kind === 'combined') for (const it of items) if (it.note === 'incluída em ' + gone.name) { it.status = 'queued'; it.note = null; }
      render();
    }
    if (btn.dataset.act === 'save') saveItem(items[idx]);
    return;
  }
  const row = e.target.closest('.row');
  if (row) { selected = +row.dataset.id; render(); }
});
// trocar o formato de saída dos PDFs recoloca na fila os que foram convertidos para outro formato
['pdfTarget', 'dpi'].forEach((id) => $(id).addEventListener('change', () => {
  if (busy) return;
  for (const it of items) if (it.kind === 'pdf' && it.status === 'done' && (it.target !== pdfTarget() || it.target !== 'md')) { it.status = 'queued'; it.outs = []; }
  render();
}));
$('convertAll').addEventListener('click', convertAll);
$('zipAll').addEventListener('click', zipAll);
$('clearAll').addEventListener('click', () => { items.length = 0; selected = null; render(); });

render();
window.conversorAdd = addFiles; // usado pela página inicial
})();
