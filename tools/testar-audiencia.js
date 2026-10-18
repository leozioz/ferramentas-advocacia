// Teste com gabarito da separação de vozes. Fluxo:
// 1) Abra http://localhost:8770/?dev#transcritor, transcreva o vídeo e rode salvar('NOME') no console:
//    grava tools/_saida/NOME.falas.json com as falas e a impressão digital de cada voz.
// 2) O gabarito fica em testes/audiencias/NOME.gabarito.json: { "falas": ["JUIZ", "TESTEMUNHA", ...] } — um papel por fala, na mesma ordem.
// 3) avaliar('NOME', { k, threshold }) agrupa de novo (sem transcrever) e mede o acerto.
import { clusterVoices, suggestRoles } from '../js/t-voices.js';

// Papel sugerido pelo app × gabarito (JUIZ, TESTEMUNHA, ADVOGADO), em % do tempo de fala.
export async function avaliarPapeis(nome, opts = {}) {
  const falas = await (await fetch('/tools/_saida/' + (opts.arquivo || nome) + '.falas.json?' + Date.now())).json();
  const g = await (await fetch('/testes/audiencias/' + nome + '.gabarito.json?' + Date.now())).json();
  const gab = falas.map((f) => { const mid = (f.start + f.end) / 2; let k = 0; g.inicios.forEach((t, i) => { if (t <= mid + 0.5) k = i; }); return g.falas[k]; });
  const ids = clusterVoices(falas.map((f) => f.vec), opts.k || 0, opts.threshold);
  const segs = falas.map((f, i) => ({ voice: ids[i], text: f.text }));
  const roles = suggestRoles(segs, Math.max(...ids) + 1);
  const classe = (r) => (/^ADV/.test(r) ? 'ADVOGADO' : r);
  const dur = (f) => Math.max(0.3, f.end - f.start);
  let certo = 0, total = 0;
  const erros = {};
  falas.forEach((f, i) => {
    total += dur(f);
    const sug = roles[ids[i]] || '(nenhum)', exp = classe(gab[i]);
    if (sug === exp) certo += dur(f); else erros[`${exp}→${sug}`] = (erros[`${exp}→${sug}`] || 0) + 1;
  });
  return { acerto: Math.round(certo / total * 1000) / 10 + '%', vozes: roles.length, papeis: roles, erros };
}

export async function salvar(nome) {
  const st = window.__transcritor;
  const f = st.files.find((x) => x.segments.length);
  const data = f.segments.map(({ start, end, text, vec }) => ({ start, end, text, vec }));
  const r = await fetch('/__salvar/' + nome + '.falas.json', { method: 'POST', body: JSON.stringify(data) });
  return r.status === 200 ? `${data.length} falas salvas` : 'falhou';
}

// Recalcula as impressões digitais das falas salvas (sem transcrever de novo) com um modelo ONNX do sherpa-onnx (js/voz-worker.js). tag nomeia o arquivo salvo.
export async function reembedModelo(nome, video, modelo, tag, { secs = 8, minSecs = 1 } = {}) {
  const falas = await (await fetch('/tools/_saida/' + nome + '.falas.json')).json();
  const buf = await (await fetch('/testes/audiencias/' + video)).arrayBuffer();
  const a = (await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(buf)).getChannelData(0);
  const w = new Worker('/js/voz-worker.js', { type: 'module' });
  let id = 0;
  const rpc = (msg, tr = []) => new Promise((res, rej) => {
    const my = ++id;
    const h = ({ data }) => { if (data.id !== my || data.type === 'embedProgress') return; w.removeEventListener('message', h); data.type === 'error' ? rej(new Error(data.message)) : res(data); };
    w.addEventListener('message', h); w.postMessage({ ...msg, id: my }, tr);
  });
  const info = await rpc({ type: 'load', url: '/models/voz/' + modelo });
  const t0 = performance.now();
  const clips = falas.map((f) => {
    const dur = f.end - f.start; if (dur < minSecs) return null;
    const take = Math.min(dur, secs), mid = (f.start + f.end) / 2;
    return a.slice(Math.max(0, Math.floor((mid - take / 2) * 16000)), Math.floor((mid + take / 2) * 16000));
  });
  for (let i = 0; i < clips.length; i += 40) {
    const batch = clips.slice(i, i + 40);
    const { vecs } = await rpc({ type: 'embed', clips: batch }, batch.filter(Boolean).map((c) => c.buffer));
    vecs.forEach((v, j) => (falas[i + j].vec = v));
  }
  const seg = (performance.now() - t0) / 1000;
  w.terminate();
  await fetch(`/__salvar/${nome}-${tag}.falas.json`, { method: 'POST', body: JSON.stringify(falas) });
  return `${tag}: ${clips.filter(Boolean).length} trechos em ${seg.toFixed(0)} s, dim ${falas.find((f) => f.vec)?.vec.length}, entradas ${info.inputs}`;
}

// Acerto = % do tempo de fala atribuído à pessoa certa, depois de casar cada voz com o papel mais comum nela
// (a mesma ideia do DER, sem contar sobreposição de falas).
export async function avaliar(nome, opts = {}) {
  const falas = await (await fetch('/tools/_saida/' + (opts.arquivo || nome) + '.falas.json')).json();
  const g = await (await fetch('/testes/audiencias/' + nome + '.gabarito.json')).json();
  // o gabarito é por horário: cada fala recebe o papel do último trecho do gabarito que começou antes do meio dela
  const gab = falas.map((f) => {
    const mid = (f.start + f.end) / 2; let k = 0;
    g.inicios.forEach((t, i) => { if (t <= mid + 0.5) k = i; });
    return g.falas[k];
  });
  const ids = clusterVoices(falas.map((f) => f.vec), opts.k || 0, opts.threshold);
  const dur = (f) => Math.max(0.3, f.end - f.start);
  const porVoz = {};
  falas.forEach((f, i) => { const v = ids[i]; porVoz[v] = porVoz[v] || {}; porVoz[v][gab[i]] = (porVoz[v][gab[i]] || 0) + dur(f); });
  const papelDaVoz = {};
  for (const [v, m] of Object.entries(porVoz)) papelDaVoz[v] = Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
  let certo = 0, total = 0;
  falas.forEach((f, i) => { total += dur(f); if (papelDaVoz[ids[i]] === gab[i]) certo += dur(f); });
  const pessoas = new Set(gab).size, achadas = new Set(Object.values(papelDaVoz)).size;
  return { vozes: Object.keys(porVoz).length, pessoas, pessoasEncontradas: achadas, acerto: Math.round(certo / total * 1000) / 10 + '%', papelDaVoz };
}
