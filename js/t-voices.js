// Vozes: agrupa as falas pela "impressão digital" da voz e sugere o papel de cada voz pelo conteúdo.

const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// vecs: array de vetores (ou null para falas curtas demais). k: nº de vozes (0 = automático).
// Retorna um índice de voz por fala.
// Limite para vetores do CAM++ (js/voz-worker.js). Medido em audiência real (tools/testar-audiencia.js):
// 0,50–0,65 dá 87–91% do tempo de fala na voz certa; 0,55 separa um pouco a mais, o que é mais seguro com mais
// pessoas. Vozes a mais o usuário junta dando o mesmo papel e nome (o documento trata como a mesma pessoa).
// (O modelo anterior, WavLM, chegava a 72% com limite 0,90.)
export function clusterVoices(vecs, k = 0, threshold = 0.55) {
  const items = vecs.map((v, i) => (v ? { i, v: norm(v) } : null)).filter(Boolean);
  if (!items.length) return vecs.map(() => 0);
  // 1) agrupamento sequencial
  let cents = [];
  const add = (c, v) => { c.sum = c.sum.map((x, j) => x + v[j]); c.n++; c.v = norm(c.sum); };
  for (const it of items) {
    let best = -1, bs = -2;
    cents.forEach((c, j) => { const s = dot(c.v, it.v); if (s > bs) { bs = s; best = j; } });
    if (best >= 0 && bs >= threshold) add(cents[best], it.v);
    else cents.push({ sum: it.v.slice(), v: it.v.slice(), n: 1 });
  }
  // 2) une grupos parecidos (ou até chegar em k)
  const mergeOnce = (minSim) => {
    let bi = -1, bj = -1, bs = -2;
    for (let i = 0; i < cents.length; i++) for (let j = i + 1; j < cents.length; j++) {
      const s = dot(cents[i].v, cents[j].v); if (s > bs) { bs = s; bi = i; bj = j; }
    }
    if (bi < 0 || bs < minSim) return false;
    const a = cents[bi], b = cents[bj];
    a.sum = a.sum.map((x, j) => x + b.sum[j]); a.n += b.n; a.v = norm(a.sum);
    cents.splice(bj, 1); return true;
  };
  if (k > 0) { while (cents.length > k && mergeOnce(-2)); }
  else { while (mergeOnce(threshold)); }
  // grupos minúsculos (ruído, tosse) se juntam ao mais próximo
  if (!k) {
    const total = items.length;
    for (let guard = 0; guard < 50; guard++) {
      const small = cents.findIndex((c) => c.n < Math.max(2, total * 0.02));
      if (small < 0 || cents.length <= 1) break;
      const s = cents[small]; cents.splice(small, 1);
      let best = 0, bs = -2; cents.forEach((c, j) => { const d = dot(c.v, s.v); if (d > bs) { bs = d; best = j; } });
      const c = cents[best]; c.sum = c.sum.map((x, j) => x + s.sum[j]); c.n += s.n; c.v = norm(c.sum);
    }
  }
  // 3) refinamento estilo k-means
  let assign = new Map();
  for (let iter = 0; iter < 3; iter++) {
    assign = new Map();
    const sums = cents.map(() => null);
    for (const it of items) {
      let best = 0, bs = -2; cents.forEach((c, j) => { const s = dot(c.v, it.v); if (s > bs) { bs = s; best = j; } });
      assign.set(it.i, best);
      sums[best] = sums[best] ? sums[best].map((x, j) => x + it.v[j]) : it.v.slice();
    }
    cents = cents.map((c, j) => (sums[j] ? { ...c, sum: sums[j], v: norm(sums[j]) } : c));
  }
  // ordena as vozes pela primeira aparição
  const order = [];
  for (const it of items) { const a = assign.get(it.i); if (!order.includes(a)) order.push(a); }
  const remap = new Map(order.map((a, idx) => [a, idx]));
  // falas sem vetor herdam a voz da fala anterior (ou da próxima)
  const out = new Array(vecs.length).fill(-1);
  for (const [i, a] of assign) out[i] = remap.get(a);
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = i > 0 ? out[i - 1] : -1;
  for (let i = out.length - 1; i >= 0; i--) if (out[i] < 0) out[i] = i < out.length - 1 ? out[i + 1] : 0;
  return out;
}

const KW = {
  juiz: [/passo a palavra/, /dou a palavra/, /com a palavra/, /compromiss/, /comprometid/, /dizer a verdade/, /falar a verdade/, /falso testemunho/,
    /parentesco/, /amizade [íi]ntima/, /inimizade/, /nome completo/, /profiss[ãa]o/, /dr[a]?\.? \p{L}+, pode/u, /doutor[a]? \p{L}+\?/u, /advert/, /declaro aberta/, /encerrad/, /consign/, /defiro/, /indefiro/, /nada mais/, /pode(m)? (iniciar|come[cç]ar|perguntar|prosseguir)/, /alguma pergunta/, /qualifica/, /dispens/, /ata/, /audi[eê]ncia/, /senhor(a)? vai ser ouvid/],
  testemunha: [/meu nome (é|e)/, /tenho \d+ anos/, /\d+ anos/, /sou (casad|solteir|divorciad|vi[uú]v)/, /trabalho (como|na|no|em)/, /sim,? senhor/, /n[aã]o,? senhor/, /sim,? senhora/, /n[aã]o,? senhora/, /eu (vi|estava|lembro|sei|conhe[cç]o)/, /n[aã]o (lembro|sei|recordo|vi)/, /moro/],
  advogado: [/excel[eê]ncia/, /pela ordem/, /sem (mais )?perguntas/, /(a senhora|o senhor|voc[eê]) (sabe|lembra|viu|poderia|pode|confirma|presenciou|conhece)/, /requeir/, /protest/, /consigne/, /contradita/, /meu cliente/, /doutor/],
  promotor: [/minist[eé]rio p[uú]blico/, /promotor/, /promotoria/, /acusa[cç][aã]o/],
};

// segs: [{voice, text}] já com voz atribuída; n: nº de vozes. Retorna [{role}] sugeridos.
export function suggestRoles(segs, n) {
  const st = Array.from({ length: n }, () => ({ words: 0, segs: 0, perguntas: 0, juiz: 0, testemunha: 0, advogado: 0, promotor: 0 }));
  segs.forEach((s) => {
    const v = st[s.voice]; if (!v) return;
    const t = s.text.toLowerCase();
    v.words += t.split(/\s+/).length; v.segs++;
    if (/\?/.test(t)) v.perguntas++;
    for (const k of Object.keys(KW)) for (const re of KW[k]) if (re.test(t)) v[k]++;
  });
  const roles = st.map(() => '');
  const free = new Set(st.map((_, i) => i).filter((i) => st[i].segs >= 3));
  // Juiz: quem abre a audiência (primeira fala com conteúdo). Medido em audiência real: a fatia de falas
  // não serve (o advogado que pergunta muito fala mais que o juiz).
  const abertura = segs.find((s) => s.text.split(/\s+/).length >= 4);
  const pick = (score) => { let b = -1, bs = 0; for (const i of free) { const s = score(st[i], i); if (s > bs) { bs = s; b = i; } } return b; };
  const j = abertura && free.has(abertura.voice) ? abertura.voice : pick((v) => v.juiz * 2);
  if (j >= 0) { roles[j] = 'JUIZ'; free.delete(j); }
  // A voz do juiz às vezes se divide em duas (perto/longe do microfone). Outra voz com falas típicas de juiz
  // (qualificação, compromisso, "Dr. Fulano, pode iniciar") também é o juiz.
  for (const i of [...free]) {
    const v = st[i];
    if (v.juiz >= 2 && v.juiz / v.segs >= 0.2 && v.juiz > v.advogado) { roles[i] = 'JUIZ'; free.delete(i); }
  }
  const p = pick((v) => (v.promotor >= 2 ? v.promotor : 0));
  if (p >= 0) { roles[p] = 'PROMOTOR'; free.delete(p); }
  // Testemunha responde; juiz e advogados perguntam. Medido em audiência real: a testemunha tinha "?" em 6% das
  // falas; juiz e advogados, em 21–28%. A voz que menos pergunta é a testemunha; as outras, conforme a proporção.
  const qr = (v) => v.perguntas / v.segs;
  const cands = [...free].filter((i) => st[i].segs >= 5);
  const t = cands.sort((a, b) => (qr(st[a]) - st[a].testemunha * 0.05) - (qr(st[b]) - st[b].testemunha * 0.05))[0];
  for (const i of free) {
    const v = st[i];
    if (i === t) { roles[i] = 'TESTEMUNHA'; continue; }
    roles[i] = qr(v) >= 0.15 || v.advogado > v.testemunha ? 'ADVOGADO' : 'TESTEMUNHA';
  }
  return roles;
}
