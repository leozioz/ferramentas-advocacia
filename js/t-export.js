// Exportação: .md (padrão da skill de transcrição de audiências), Word, .txt, .srt e texto para o Claude.

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return [h, m, x].map((n) => String(n).padStart(2, '0')).join(':');
};
const srtTime = (s) => {
  s = Math.max(0, s || 0);
  const ms = Math.round((s % 1) * 1000);
  return fmtTime(s) + ',' + String(ms).padStart(3, '0');
};
const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
const up = (s) => (s || '').trim().toLocaleUpperCase('pt-BR');

// Rótulo no padrão da skill: JUIZ (NOME) · NOME (TESTEMUNHA) · DR. NOME (ADVOGADO DO AUTOR)
export function voiceLabels(voices) {
  const raw = voices.map((v, i) => {
    const role = up(v.role), name = up(v.name);
    if (!role && !name) return `VOZ ${i + 1}`;
    if (!name) return role;
    if (!role) return name;
    return /^JU[IÍ]Z/.test(role) ? `${role} (${name})` : `${name} (${role})`;
  });
  // papéis repetidos sem nome viram "TESTEMUNHA 1", "TESTEMUNHA 2";
  // vozes com o mesmo nome e papel são a mesma pessoa e ficam com o mesmo rótulo
  const count = {};
  // (juiz e promotor são um só por audiência: vozes com esse papel são a mesma pessoa)
  const unico = (l) => /^(JU[IÍ]ZA?|PROMOTORA?)$/.test(l);
  raw.forEach((l, i) => { if (!up(voices[i].name) && !unico(l)) count[l] = (count[l] || 0) + 1; });
  const seen = {};
  return raw.map((l, i) => (!up(voices[i].name) && count[l] > 1 ? `${l} ${(seen[l] = (seen[l] || 0) + 1)}` : l));
}

// Junta trechos seguidos da mesma voz em uma fala. Falas longas ganham um parágrafo
// de continuação (sem rótulo, com minutagem) a cada ~60 s, para facilitar a citação.
export function falasOf(file, diarized, labels = []) {
  const out = [];
  let head = null;
  const same = (a, b) => a === b || (a >= 0 && b >= 0 && labels[a] && labels[a] === labels[b]);
  for (const s of file.segments) {
    const text = (s.text || '').trim();
    if (!text) continue;
    const last = out[out.length - 1];
    const voice = diarized ? s.voice : -1;
    if (last && head && same(head.voice, voice) && (diarized || s.start - last.start < 60)) {
      if (s.start - last.start >= 60) out.push({ voice, start: s.start, text, cont: true });
      else last.text += ' ' + text;
    } else {
      head = { voice, start: s.start, text };
      out.push(head);
    }
  }
  return out;
}

function headerLines(st) {
  const h = st.header, L = [];
  if (h.proc) L.push(['Processo', h.proc]);
  if (h.juizo) L.push(['Juízo', h.juizo]);
  if (h.tipo) L.push(['Audiência', h.tipo]);
  if (h.data) L.push(['Data', fmtDate(h.data)]);
  if (h.local) L.push(['Local', h.local]);
  if (h.fato) L.push(['Fato', h.fato]);
  return L;
}
function partes(st) {
  const h = st.header, P = [];
  const add = (label, names, ours) => names.map((n) => n.trim()).filter(Boolean).forEach((n) => P.push([label, n + (ours ? ' (nosso cliente)' : '')]));
  add('Autor(a)', h.autores || [], h.cliente === 'autor');
  add('Réu/Ré', h.reus || [], h.cliente === 'reu');
  return P;
}
const presentes = (st) => (st.header.presentes || []).filter((p) => (p.name || '').trim())
  .map((p) => `${(p.role || 'PRESENTE').trim().toLocaleUpperCase('pt-BR')}: ${p.name.trim().toLocaleUpperCase('pt-BR')}${p.oab ? ' – ' + p.oab.trim() : ''}${p.note ? ' (' + p.note + ')' : ''}`);
const sectionTitle = (f, i) => `VÍDEO ${i + 1} – ${up(f.title || f.name)}`;

function observacoes(st) {
  const O = [];
  O.push(`Transcrição automática gerada no navegador (${st.meta.modelLabel}) em ${new Date().toLocaleDateString('pt-BR')}. Conferir no áudio antes de usar em peça.`);
  if (st.meta.cleaned) O.push('Foi aplicado filtro de limpeza de ruído antes da transcrição.');
  if (st.meta.diarized) {
    const labels = voiceLabels(st.voices);
    const sug = [...new Set(st.voices.map((v, i) => (v.suggested ? labels[i] : null)).filter(Boolean))];
    O.push('Falantes separados automaticamente pela voz; trocas de falante em falas curtas podem estar atribuídas à pessoa errada.');
    if (sug.length) O.push('Papéis sugeridos pelo app e ainda não confirmados: ' + sug.join(', ') + '.');
    const unnamed = [...new Set(st.voices.map((v, i) => (!v.name ? labels[i] : null)).filter(Boolean))];
    if (unnamed.length) O.push('Sem nome informado (conferir com a ata): ' + unnamed.join(', ') + '.');
  } else {
    O.push('Falantes não identificados (separação de vozes desligada).');
  }
  if (st.meta.translated) O.push('Texto traduzido automaticamente para o inglês.');
  if (st.ata) O.push(`Dados do cabeçalho e presentes importados automaticamente da ata ("${st.ata.name}"); conferir com o documento.`);
  return O;
}

export function toMarkdown(st, { times = true } = {}) {
  const labels = voiceLabels(st.voices), L = [];
  L.push('# TRANSCRIÇÃO DE AUDIÊNCIA', '');
  for (const [k, v] of headerLines(st)) L.push(`**${k}:** ${v}  `);
  const P = partes(st);
  if (P.length) { L.push('', '## PARTES', ''); for (const [k, v] of P) L.push(`- **${k}:** ${v}`); }
  const PR = presentes(st);
  if (PR.length) { L.push('', '## PRESENTES', ''); for (const p of PR) L.push('- ' + p); }
  if (st.meta.diarized) {
    L.push('', '## LEGENDA DOS FALANTES', '');
    [...new Set(labels)].forEach((l) => L.push(`- **${l}**${st.voices.some((v, i) => labels[i] === l && v.suggested) ? ' — papel sugerido automaticamente, a conferir' : ''}`));
    L.push('- Observações da secretaria ao final do documento.');
  }
  st.files.forEach((f, i) => {
    L.push('', `## ${sectionTitle(f, i)}`, '');
    for (const fa of falasOf(f, st.meta.diarized, labels)) {
      const t = times ? `[${fmtTime(fa.start)}] ` : '';
      L.push((fa.voice >= 0 && !fa.cont ? `**${labels[fa.voice]}:** ` : '') + t + fa.text, '');
    }
  });
  L.push('', '## OBSERVAÇÕES DA SECRETARIA', '');
  for (const o of observacoes(st)) L.push('- ' + o);
  return L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

export function toText(st, { times = true } = {}) {
  const labels = voiceLabels(st.voices), L = [];
  L.push('TRANSCRIÇÃO DE AUDIÊNCIA', '');
  for (const [k, v] of headerLines(st)) L.push(`${k}: ${v}`);
  const P = partes(st);
  if (P.length) { L.push('', 'PARTES'); for (const [k, v] of P) L.push(`${k}: ${v}`); }
  const PR = presentes(st);
  if (PR.length) { L.push('', 'PRESENTES'); for (const p of PR) L.push(p); }
  st.files.forEach((f, i) => {
    L.push('', sectionTitle(f, i), '');
    for (const fa of falasOf(f, st.meta.diarized, labels)) {
      const t = times ? `[${fmtTime(fa.start)}] ` : '';
      L.push((fa.voice >= 0 && !fa.cont ? `${labels[fa.voice]}: ` : '') + t + fa.text, '');
    }
  });
  return L.join('\r\n').replace(/(\r\n){3,}/g, '\r\n\r\n') + '\r\n';
}

export function toSrt(st, file) {
  const labels = voiceLabels(st.voices);
  let n = 0;
  return file.segments.filter((s) => (s.text || '').trim()).map((s) => {
    const end = s.end != null && s.end > s.start ? s.end : s.start + 3;
    const who = st.meta.diarized ? labels[s.voice] + ': ' : '';
    return `${++n}\r\n${srtTime(s.start)} --> ${srtTime(end)}\r\n${who}${s.text.trim()}\r\n`;
  }).join('\r\n');
}

export function claudePrompt(st, md) {
  return [
    'Use a skill transcricao-audiencia.',
    '',
    'Abaixo está a transcrição automática de uma audiência, gerada pelo meu app. Os falantes foram separados pela voz e os papéis foram sugeridos automaticamente, então podem estar errados.',
    '',
    st.ata
      ? '1. Revise quem fala em cada trecho pelo contexto e confira com a ata (no final desta mensagem), como a skill orienta. Me pergunte o que faltar.'
      : '1. Revise quem fala em cada trecho pelo contexto, como a skill orienta, e me pergunte o que faltar (quem é nosso cliente, se há ata).',
    '2. Depois, faça um resumo por depoente com os pontos relevantes e eventuais contradições entre os depoimentos, sem opinar sobre o mérito.',
    '',
    '---',
    '',
    md,
    ...(st.ata ? ['', '---', '', `ATA DA AUDIÊNCIA (texto extraído de "${st.ata.name}"):`, '', st.ata.text.trim()] : []),
  ].join('\n');
}

/* ---------- Word (.docx) montado à mão: Calibri 11, justificado, entrelinha 1,15 ---------- */
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const run = (text, { b = false, i = false, sz = 0 } = {}) =>
  `<w:r>${b || i || sz ? `<w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}${sz ? `<w:sz w:val="${sz}"/>` : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
const para = (runs, { style = '', pageBreak = false, jc = '' } = {}) =>
  `<w:p>${style || pageBreak || jc ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pageBreak ? '<w:pageBreakBefore/>' : ''}${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>` : ''}${runs}</w:p>`;

export async function toDocx(st, { times = true } = {}) {
  const labels = voiceLabels(st.voices), B = [];
  B.push(para(run('TRANSCRIÇÃO DE AUDIÊNCIA'), { style: 'Ttulo1' }));
  for (const [k, v] of headerLines(st)) B.push(para(run(k + ': ', { b: true }) + run(v)));
  const P = partes(st);
  if (P.length) { B.push(para(run('PARTES'), { style: 'Ttulo2' })); for (const [k, v] of P) B.push(para(run(k + ': ', { b: true }) + run(v))); }
  const PR = presentes(st);
  if (PR.length) {
    B.push(para(run('PRESENTES'), { style: 'Ttulo2' }));
    for (const p of PR) { const m = p.match(/^([^:]{2,60}):\s*(.*)$/); B.push(para(m ? run(m[1] + ': ', { b: true }) + run(m[2]) : run(p))); }
  }
  if (st.meta.diarized) {
    B.push(para(run('LEGENDA DOS FALANTES'), { style: 'Ttulo2' }));
    [...new Set(labels)].forEach((l) => B.push(para(run('• ') + run(l, { b: true }))));
  }
  st.files.forEach((f, i) => {
    B.push(para(run(sectionTitle(f, i)), { style: 'Ttulo2', pageBreak: true }));
    for (const fa of falasOf(f, st.meta.diarized, labels)) {
      const t = times ? `[${fmtTime(fa.start)}] ` : '';
      B.push(para((fa.voice >= 0 && !fa.cont ? run(labels[fa.voice] + ': ', { b: true }) : '') + run(t + fa.text)));
    }
  });
  const footerLines = (st.header.rodape || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const hasFooter = footerLines.length > 0;
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${B.join('')}<w:sectPr>${hasFooter ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1134" w:bottom="1134" w:left="1701" w:header="709" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="240"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Rodap"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
</w:styles>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}>${footerLines.map((l) => para(run(l), { style: 'Rodap' })).join('')}</w:ftr>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${hasFooter ? '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}</Relationships>`);
  zip.file('word/document.xml', doc);
  zip.file('word/styles.xml', styles);
  if (hasFooter) zip.file('word/footer1.xml', footer);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
