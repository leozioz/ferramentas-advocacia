// Teste com gabarito da leitura de atas. Uso (com o servidor local ligado, no console do navegador):
//   const t = await import('/tools/testar-atas.js'); await t.testar(['NOME.pdf'])
// Cada ata em testes/atas/NOME.pdf precisa de testes/atas/NOME.gabarito.json.
import { ataText, parseAta } from '../js/t-ata.js';

const N = (s) => String(s || '').normalize('NFC').toLocaleUpperCase('pt-BR').replace(/\s+/g, ' ').trim();
const oabN = (s) => N(s).replace(/[\s.]/g, '');

function compara(got, exp) {
  const falhas = [];
  for (const k of ['proc', 'juizo', 'data', 'local', 'tipo']) {
    if (k in exp && N(got[k]) !== N(exp[k])) falhas.push(`${k}: veio "${got[k]}", esperado "${exp[k]}"`);
  }
  for (const k of ['autores', 'reus']) {
    if (!(k in exp)) continue;
    const g = got[k].map(N), e = exp[k].map(N);
    for (const x of e) if (!g.includes(x)) falhas.push(`${k}: faltou "${x}"`);
    for (const x of g) if (!e.includes(x)) falhas.push(`${k}: a mais "${x}"`);
  }
  if (exp.people) {
    const usados = new Set();
    for (const p of exp.people) {
      const i = got.people.findIndex((q) => N(q.name) === N(p.name));
      if (i < 0) { falhas.push(`pessoa faltando: ${p.role}: ${p.name}`); continue; }
      usados.add(i);
      const q = got.people[i];
      if (N(q.role) !== N(p.role)) falhas.push(`papel de ${p.name}: veio "${q.role}", esperado "${p.role}"`);
      if (p.oab && oabN(q.oab) !== oabN(p.oab)) falhas.push(`OAB de ${p.name}: veio "${q.oab}", esperado "${p.oab}"`);
      if (p.note && N(q.note) !== N(p.note)) falhas.push(`nota de ${p.name}: veio "${q.note}", esperado "${p.note}"`);
    }
    got.people.forEach((q, i) => { if (!usados.has(i)) falhas.push(`pessoa a mais: ${q.role}: ${q.name}`); });
  }
  return falhas;
}

export async function testar(nomes) {
  const rel = [];
  for (const nome of nomes) {
    const base = nome.replace(/\.[^.]+$/, '');
    const blob = await (await fetch('/testes/atas/' + encodeURIComponent(nome))).blob();
    const exp = await (await fetch('/testes/atas/' + encodeURIComponent(base) + '.gabarito.json')).json();
    const got = parseAta(await ataText(new File([blob], nome)));
    const falhas = compara(got, exp);
    const total = Object.keys(exp).filter((k) => k !== 'people').length + (exp.people || []).length;
    rel.push({ nome, ok: !falhas.length, acertos: `${Math.max(0, total - falhas.length)}/${total}`, falhas });
  }
  return rel;
}
