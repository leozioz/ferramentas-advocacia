// Ata da audiência: extrai o texto (PDF, Word ou .txt) e encontra processo, juízo, partes e presentes.

export async function ataText(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
    let out = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let txt = '';
      for (const it of tc.items) txt += (it.str || '') + (it.hasEOL ? '\n' : '');
      if (txt.replace(/\s/g, '').length < 20 && window.OCR && p <= 15) {
        // ata digitalizada: lê a página com OCR (uma linha por parágrafo reconhecido)
        if (onProgress) onProgress(`Lendo a página ${p} de ${pdf.numPages} da ata (OCR)…`);
        const vp = page.getViewport({ scale: 200 / 72 });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise; // 'print': não depende da aba estar visível
        const r = await OCR.recognize(c);
        txt = r.text;
        c.width = c.height = 0;
      }
      out += txt + '\n';
    }
    await pdf.destroy();
    if (!out.replace(/\s/g, '')) throw new Error('Não foi possível ler texto na ata, nem por OCR. Tente a versão em Word ou um PDF gerado pelo sistema do tribunal.');
    return out;
  }
  if (name.endsWith('.docx')) {
    const zip = await JSZip.loadAsync(file);
    const xml = await zip.file('word/document.xml').async('string');
    return xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  if (name.endsWith('.doc')) throw new Error('Arquivos .doc antigos não são lidos. Salve a ata como .docx ou PDF.');
  return file.text();
}

const MESES = { janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const iso = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s:–-]+|[\s;,.:–-]+$/g, '').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const R_AUTOR = /^(autor(a|es|as)?|requerente(s)?|exequente(s)?|reclamante(s)?|embargante(s)?|impetrante(s)?|apelante(s)?|querelante(s)?)\s*(\(s\))?\s*[:–-]\s*(.+)$/i;
const R_REU = /^(r[ée]u(s)?|r[ée](s)?|requerid[oa]s?|executad[oa]s?|reclamad[oa]s?|embargad[oa]s?|impetrad[oa]s?|apelad[oa]s?|denunciad[oa]s?|acusad[oa]s?|querelad[oa]s?)\s*(\(s\))?\s*[:–-]\s*(.+)$/i;
const R_PAPEL = /(ju[íi]z|magistrad|promotor|minist[ée]rio p[úu]blico|defensor|advogad|procurador|preposto|preposta|testemunha|informante|perit[oa]|int[ée]rprete|depoente|conciliador)/i;
const R_OAB = /,?\s*\(?\s*OAB\s*\/?\s*([A-Z]{2})\s*(n[ºo°.]*\s*)?([\d.]+[A-Z]?)\s*\)?/i;

function roleOf(left, name) {
  const l = left.toLowerCase();
  const fem = /ju[íi]za|promotora|advogada|procuradora|preposta|perita|defensora/.test(l) || /^(dra\.?|doutora)\s/i.test(name);
  if (/ju[íi]z|magistrad/.test(l)) return fem ? 'JUÍZA' : 'JUIZ';
  if (/promotor|minist[ée]rio p[úu]blico/.test(l)) return fem ? 'PROMOTORA' : 'PROMOTOR';
  if (/defensor/.test(l)) return fem ? 'DEFENSORA PÚBLICA' : 'DEFENSOR PÚBLICO';
  if (/advogad|procurador/.test(l)) return (fem ? 'ADVOGADA' : 'ADVOGADO') + sideSuffix(l);
  if (/preposto|preposta/.test(l)) return (fem ? 'PREPOSTA' : 'PREPOSTO') + sideSuffix(l);
  if (/testemunha/.test(l)) return 'TESTEMUNHA';
  if (/informante/.test(l)) return 'INFORMANTE';
  if (/perit/.test(l)) return fem ? 'PERITA' : 'PERITO';
  if (/int[ée]rprete/.test(l)) return 'INTÉRPRETE';
  if (/conciliador/.test(l)) return 'CONCILIADOR';
  return 'DEPOENTE';
}

// "Pedro Alves", "MARIA DA SILVA", "Dr. João de Souza, OAB/RS 1.234" — não frases do texto
function looksLikeName(s) {
  const base = s.replace(R_OAB, '').replace(/\(.*?\)/g, '').replace(/^(dr\.?|dra\.?|sr\.?|sra\.?)\s+/i, '').trim();
  const words = base.split(/\s+/);
  return words.length >= 2 && words.length <= 7 && !/[,;:!?]|\.$/.test(base) &&
    words.every((w) => /^[A-ZÀ-Ú][\p{L}'’.-]*$/u.test(w) || /^(da|de|do|das|dos|e)$/i.test(w));
}

export function parseAta(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, ' ').trim()).filter(Boolean);
  const flat = lines.join('\n');
  const out = { proc: '', juizo: '', tipo: '', data: '', local: '', autores: [], reus: [], people: [] };

  const proc = flat.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  if (proc) out.proc = proc[0];

  const jz = lines.find((l) => l.length < 160 && /\b(vara|juizado|ju[íi]zo|turma recursal|n[úu]cleo de justi[çc]a|cejusc)\b/i.test(l) && !/processo\s*n|^\s*(autor|r[ée]u)/i.test(l));
  if (jz) out.juizo = clean(jz.replace(/^(ju[íi]zo|órg[ãa]o julgador|unidade)\s*:\s*/i, ''));
  const com = flat.match(/comarca d[eao]s?\s+([A-ZÀ-Úa-zà-ú' ]{3,40}?)(?=[\n,.\-–/]|$)/i);
  if (com && out.juizo && !/comarca/i.test(out.juizo)) out.juizo += ' – Comarca de ' + clean(com[1]);
  else if (com && !out.juizo) out.juizo = 'Comarca de ' + clean(com[1]);

  const tipo = flat.match(/audi[êe]ncia\s+(?:una\s+)?(?:de\s+)?(instru[çc][ãa]o\s+e\s+julgamento|instru[çc][ãa]o|concilia[çc][ãa]o(?:\s+e\s+media[çc][ãa]o)?|media[çc][ãa]o|una|cust[óo]dia|justifica[çc][ãa]o|admonit[óo]ria|preliminar|inicial|interrogat[óo]rio|oitiva[^\n.]{0,30})/i);
  if (tipo) out.tipo = cap(clean(tipo[1]));

  // ordem de preferência: "Data: dd/mm/aaaa", data por extenso ("Aos 14 dias do mês de outubro de 2026"), primeira dd/mm/aaaa
  let d = flat.match(/data[^\d\n]{0,25}(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  const ext = flat.match(/(\d{1,2})[º°]?\s+(?:dias?\s+do\s+m[êe]s\s+)?de\s+(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})/i);
  if (d) out.data = iso(+d[1], +d[2], +d[3]);
  else if (ext) out.data = iso(+ext[1], MESES[ext[2].toLowerCase().replace('ç', 'c')], +ext[3]);
  else if ((d = flat.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) out.data = iso(+d[1], +d[2], +d[3]);

  // "Local: Cidade   Data: …" vence; "virtual" sozinho não serve ("Balcão Virtual" aparece no cabeçalho do eproc)
  const loc = flat.match(/^\s*local\s*:\s*(.+?)(?=\s+data\s*:|\s{2,}|$)/im);
  if (loc) out.local = clean(loc[1]);
  else if (/videoconfer[êe]ncia|telepresencial|audi[êe]ncia\s+virtual|sess[ãa]o\s+virtual|microsoft teams|zoom|webex/i.test(flat)) out.local = 'Videoconferência';
  else { const s = flat.match(/sala de audi[êe]ncias[^\n.]{0,60}/i); if (s) out.local = cap(clean(s[0])); }

  // partes, uma por linha do cabeçalho ("AUTOR: NOME", "RÉU: NOME")
  const tidy = (s) => clean(s.replace(/\(.*?\)/g, '').replace(/\(.*$/, '').replace(/,?\s*(CPF|CNPJ|RG)\b.*$/i, '')).replace(/\bS\.A$/i, 'S.A.');
  for (const l of lines) {
    let m;
    if ((m = l.match(R_AUTOR))) out.autores.push(...m[m.length - 1].split(';').map(tidy));
    else if ((m = l.match(R_REU))) out.reus.push(...m[m.length - 1].split(';').map(tidy));
  }
  const uniq = (a) => [...new Set(a.filter((s) => s.length > 2))];
  out.autores = uniq(out.autores); out.reus = uniq(out.reus);
  N_AUT = out.autores.length;

  const people = [];
  const push = (role, name, oab = '', note = '') => {
    name = clean(name.replace(/^(dr\.?|dra\.?|doutor|doutora|sr\.?|sra\.?|senhor|senhora)\s+/i, ''));
    if (!validName(name, /PREPOST/.test(role) ? 1 : 2)) return;
    people.push({ role, name: name.toLocaleUpperCase('pt-BR'), oab, note });
  };

  // 1) linhas "Papel: Nome" (atas em formulário) e listas de nomes nas linhas seguintes
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.{2,70}?)\s*:\s*(.*)$/);
    if (!m || !R_PAPEL.test(m[1]) || R_AUTOR.test(lines[i]) || R_REU.test(lines[i])) continue;
    if (m[1].split(/\s+/).length > 7 || /\b(dito|disse|declar|decid|determin|deliber|requer|manifest|consign)/i.test(m[1])) continue;
    const chunks = m[2] ? m[2].split(/;|\s+\/\s+/) : [];
    if (!m[2]) for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
      const cand = lines[j].replace(/^[-•·\d.)\s]+/, '');
      if (/:/.test(cand) || !looksLikeName(cand)) break;
      chunks.push(cand);
    }
    for (const c of chunks) {
      const oab = oabOf(c);
      const nm = nameAt(c.replace(R_OAB, ''));
      if (nm) push(roleOf(m[1], nm.raw), nm.name, oab, noteOf(m[1]) || noteOf(c));
    }
  }

  // 2) texto corrido: "presente a Juíza de Direito Dra. Fulana", "o procurador da ré Dr. Fulano, OAB/RS 123".
  // O papel é procurado sem diferenciar maiúsculas; o nome logo depois precisa começar com maiúscula.
  const nar = text.replace(/-\r?\n/g, '').replace(/\s+/g, ' ');
  const after = (kw, minWords) => {
    for (const m of nar.matchAll(kw)) {
      const n = nameAt(nar.slice(m.index + m[0].length, m.index + m[0].length + 120));
      if (n) push(roleOf(m[0], n.raw), n.name, '', '');
    }
  };
  after(/\b(ju[íi]z[a]?(\(a\))?(\s+de\s+direito|\s+substitut[oa]|\s+federal|\s+leig[oa]|\s+do\s+trabalho)?|magistrad[oa])(?![\p{L}])/giu);
  after(/\bpromotor[a]?\s+de\s+justi[çc]a/gi);
  after(/\bdefensor[a]?\s+p[úu]blic[oa]/gi);
  // juiz pela assinatura: "assinado eletronicamente por NOME, Juiz de Direito"
  for (const m of nar.matchAll(new RegExp('(' + NAME + ')\\s*,\\s*[Jj][Uu][ÍíIi][Zz]([Aa])?(?![\\p{L}])', 'gu')))
    push(m[2] ? 'JUÍZA' : 'JUIZ', m[1]);
  // prepostos: o lado vem do que está escrito antes ("Presente a ré X, representada pelo preposto NOME")
  for (const m of nar.matchAll(/\bprepost([oa])(\s+d[aeo]s?\s+(parte\s+)?[\p{L}]+)?/giu)) {
    const n = nameAt(nar.slice(m.index + m[0].length, m.index + m[0].length + 120));
    if (n) push((m[1].toLowerCase() === 'a' ? 'PREPOSTA' : 'PREPOSTO') + sideSuffix(nar.slice(Math.max(0, m.index - 160), m.index + m[0].length)), n.name);
  }
  // advogados: o nome mais próximo antes de cada OAB; o lado (autor/réu) vem das palavras antes do nome
  for (const o of nar.matchAll(new RegExp(R_OAB.source, 'gi'))) {
    const win = nar.slice(Math.max(0, o.index - 240), o.index);
    let last = null;
    for (const k of win.matchAll(/\b(dra?\.|doutor[a]?|advogad[oa]|procurador[a]?)(?![\p{L}])/giu)) {
      const n = nameAt(win.slice(k.index + k[0].length));
      if (n) last = { k, n };
    }
    if (!last) continue;
    const ctx = win.slice(Math.max(0, last.k.index - 140), last.k.index + last.k[0].length);
    const fem = /dra\.|doutora|advogada|procuradora/i.test(last.k[0] + ' ' + last.n.raw);
    push((fem ? 'ADVOGADA' : 'ADVOGADO') + sideSuffix(ctx), last.n.name, `OAB/${o[1].toUpperCase()} ${o[3]}`);
  }
  // partes pessoas físicas presentes ("Presente a parte autora NOME e NOME"); empresas ficam de fora
  for (const m of nar.matchAll(/\bpresentes?\s+(?:a|o|as|os)\s+(partes?\s+autoras?|autor[ae]?s?|requerentes?|partes?\s+r[ée]s?|r[ée]u?s?|requerid[oa]s?)\s+/giu)) {
    const autor = /autor|requerente/i.test(m[1]);
    for (const p of listNames(nar.slice(m.index + m[0].length, m.index + m[0].length + 300)))
      if (!EMPRESA.test(p.name)) push(autor ? 'PARTE AUTORA' : 'PARTE RÉ', p.name);
  }
  // testemunhas e informantes, com quem arrolou ("MARIA X e ANA Y, arroladas pela ré, e JOÃO Z, arrolado pela parte autora")
  for (const m of nar.matchAll(/\b(testemunhas?|informantes?)(\s*\(s\))?(\s+arrolad[oa]s?\s+pel[oa]s?\s+((parte\s+)?[\p{L}]+))?\s*[,:–-]?/giu)) {
    const pre = m[4] ? 'arrolada pela ' + m[4].toLowerCase() : '';
    for (const p of listNames(nar.slice(m.index + m[0].length, m.index + m[0].length + 400)))
      push(roleOf(m[1], ''), p.name, '', p.note || pre);
  }

  // sem repetidos: fica a versão mais completa (com OAB, com lado definido)
  const best = new Map();
  const score = (p) => (p.oab ? 4 : 0) + (/ D[AO]S? /.test(p.role) ? 2 : 0) + (p.note ? 1 : 0);
  for (const p of people) {
    const k = p.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const prev = [...best.keys()].find((x) => x === k || x.startsWith(k + ' ') || k.startsWith(x + ' '));
    if (!prev) best.set(k, p);
    else if (score(p) > score(best.get(prev)) || p.name.length > best.get(prev).name.length) { best.delete(prev); best.set(k, p); }
  }
  out.people = [...best.values()];
  return out;
}

const W = "[A-ZÀ-Ý][\\p{L}'’]*(?:-[A-ZÀ-Ý][\\p{L}'’]*)?";
const NAME = `${W}(?:\\s+(?:(?:d[aeo]s?|di|del|van|von)\\s+)?${W}){0,6}`;
const STOP = new Set(['declaro', 'encerrada', 'encerrado', 'aberta', 'aberto', 'instrução', 'audiência', 'audiencia', 'direito', 'processo', 'parte', 'partes',
  'autora', 'autor', 'autores', 'ré', 're', 'réu', 'reu', 'réus', 'presente', 'presentes', 'ausente', 'nada', 'mais', 'foi', 'foram', 'conforme', 'gravação', 'termo',
  'sentença', 'prazo', 'memoriais', 'defiro', 'indefiro', 'ministério', 'público', 'pública', 'justiça', 'estado', 'tribunal', 'comarca', 'vara', 'juízo',
  'juiz', 'juíza', 'advogado', 'advogada', 'procurador', 'procuradora', 'preposto', 'preposta', 'testemunha', 'testemunhas', 'oab', 'cpf', 'cnpj', 'sem', 'com',
  'pela', 'pelo', 'para', 'por', 'não', 'sim', 'ata', 'ouvida', 'ouvido', 'ouvidas', 'dispensada', 'dispensado', 'requerida', 'requerido', 'requerente', 'nos', 'autos']);
function validName(n, minWords) {
  const words = n.split(/\s+/).filter(Boolean);
  const real = words.filter((w) => !/^(d[aeo]s?|di|del|van|von)$/i.test(w));
  return n.length <= 70 && real.length >= minWords && real.length <= 7 && !real.some((w) => STOP.has(w.toLowerCase()));
}
// Nome logo no início do trecho, depois de "o/a", "Dr./Dra.", "Sr./Sra." (estes sem diferenciar maiúsculas).
function nameAt(s) {
  const pre = s.match(/^\s*[,:–-]?\s*((o|a)\s+)?((dra?|sra?)\.?\s+|doutor[a]?\s+|senhor[a]?\s+)?/i)[0];
  const m = s.slice(pre.length).match(new RegExp('^(' + NAME + ')', 'u'));
  if (!m || !validName(m[1], 1)) return null;
  return { name: m[1], raw: pre + m[1], len: pre.length + m[1].length };
}
function oabOf(s) { const m = s.match(R_OAB); return m ? `OAB/${m[1].toUpperCase()} ${m[3]}` : ''; }
function noteOf(s) { const m = /arrolad[oa]s?\s+pel[oa]s?\s+([^,;:)]+)/i.exec(s); return m ? 'arrolada pela ' + clean(m[1]).toLowerCase() : ''; }
let N_AUT = 0; // nº de autores da ata em leitura (para "DOS AUTORES")
const EMPRESA = /\b(S\.?\s?A\.?|LTDA|EIRELI|ME|EPP|SEGURADORA|TRANSPORTES?|BANCO|COMPANHIA|CIA|COOPERATIVA|ASSOCIA[ÇC][ÃA]O|MUNIC[ÍI]PIO|ESTADO|UNI[ÃA]O|INSS)\b/i;

// Lado da última parte citada no trecho: " DO AUTOR", " DOS AUTORES", " DA RÉ", " DO RÉU", " DA DENUNCIADA"…
function sideSuffix(ctx) {
  const l = ctx.toLowerCase();
  const last = (re) => { let r = null, m; re.lastIndex = 0; while ((m = re.exec(l))) r = m; return r; };
  const A = last(/(?<![a-zà-ú])(autor[ae]?s?|requerentes?|exequentes?|reclamantes?|embargantes?)(?![a-zà-ú])/g);
  const R = last(/(?<![a-zà-ú])(r[ée]us?|r[ée]s?|requerid[oa]s?|executad[oa]s?|reclamad[oa]s?|acusad[oa]s?)(?![a-zà-ú])/g);
  const D = last(/(?<![a-zà-ú])(denunciad[oa]s?)(?![a-zà-ú])/g);
  const best = [A, R, D].filter(Boolean).sort((x, y) => y.index - x.index)[0];
  if (!best) return '';
  const w = best[1];
  if (best === D) return w.endsWith('as') ? ' DAS DENUNCIADAS' : w.endsWith('os') ? ' DOS DENUNCIADOS' : w.endsWith('a') ? ' DA DENUNCIADA' : ' DO DENUNCIADO';
  if (best === A) {
    if (N_AUT > 1 || /s$/.test(w)) return ' DOS AUTORES';
    return w === 'autora' && !/parte\s+$/.test(l.slice(0, best.index)) ? ' DA AUTORA' : ' DO AUTOR';
  }
  if (/s$/.test(w)) return /^r[ée]s$/.test(w) ? ' DAS RÉS' : ' DOS RÉUS';
  return /^r[ée]$|a$/.test(w) ? ' DA RÉ' : ' DO RÉU';
}

// Lista de nomes: "A e B, arroladas pela ré X, e C, arrolado pela parte autora". A nota vale para os nomes anteriores sem nota.
function listNames(s) {
  const out = [];
  let rest = s;
  for (let guard = 0; guard < 15; guard++) {
    rest = rest.replace(/^\s*((,|;|\be\b)\s*)*/, '');
    const ar = rest.match(/^arrolad[oa]s?\s+pel[oa]s?\s+([^,.;]+)/i);
    if (ar) {
      const note = 'arrolada pela ' + clean(ar[1]).toLowerCase();
      out.forEach((o) => { if (!o.note) o.note = note; });
      rest = rest.slice(ar[0].length); continue;
    }
    const n = nameAt(rest);
    if (!n) break;
    out.push({ name: n.name, note: '' });
    rest = rest.slice(n.len);
    if (/^\s*\.\s+[A-ZÀ-Ý]/.test(rest)) break; // fim da frase
  }
  return out;
}
