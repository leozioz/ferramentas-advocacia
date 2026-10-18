// Transcritor de audiências: interface, fila de arquivos, editor com player sincronizado.
import { SR, decodeTo16k, cleanAudio, slicePoints, isSilent } from './t-audio.js';
import { clusterVoices, suggestRoles } from './t-voices.js';
import { fmtTime, voiceLabels, toMarkdown, toText, toSrt, toDocx, claudePrompt } from './t-export.js';
import { ataText, parseAta } from './t-ata.js';
import { combo } from './combo.js';

const ROLES = ['JUIZ', 'JUÍZA', 'PROMOTOR', 'PROMOTORA', 'DEFENSOR PÚBLICO', 'DEFENSORA PÚBLICA',
  'ADVOGADO DO AUTOR', 'ADVOGADA DO AUTOR', 'ADVOGADO DA AUTORA', 'ADVOGADO DOS AUTORES',
  'ADVOGADO DO RÉU', 'ADVOGADA DO RÉU', 'ADVOGADO DA RÉ', 'ADVOGADA DA RÉ', 'ADVOGADO DOS RÉUS',
  'AUTOR', 'AUTORA', 'RÉU', 'RÉ', 'TESTEMUNHA', 'INFORMANTE', 'PREPOSTO', 'PREPOSTA', 'PERITO', 'PERITA', 'DEPOENTE', 'INTÉRPRETE', 'CONCILIADOR'];
const TIPOS = ['Instrução e julgamento', 'Conciliação', 'Instrução', 'Una', 'Custódia', 'Justificação', 'Oitiva de testemunhas', 'Interrogatório'];
const roleOptions = () => ROLES.map((value) => ({ value }));

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const fmtDur = (s) => s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1).replace('.', ',') + ' h';
const MODEL_LABEL = { 'onnx-community/whisper-base': 'Whisper base', 'onnx-community/whisper-small': 'Whisper small', 'onnx-community/whisper-large-v3-turbo': 'Whisper large-v3-turbo' };
const HALLU = /^(legendas? pela comunidade amara\.org|obrigad[oa] por assistir|inscreva-se|\[?m[uú]sica\]?|\.+|tchau\.?)$/i;

let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3600); }

const st = {
  files: [],     // {id, blob, name, url, isVideo, title, status, progress, segments:[{start,end,text,voice,vec}], error}
  voices: [],    // {role, name, suggested}
  // autores/reus: listas de nomes; presentes: [{role, name, oab, note}]
  header: { proc: '', juizo: '', tipo: '', data: '', local: '', fato: '', cliente: '', autores: [], reus: [], presentes: [] },
  meta: { model: '', modelLabel: '', cleaned: false, diarized: false, translated: false },
  ata: null,     // {name, text} da ata importada
};
let nextId = 1, running = false, playerFile = null;
if (/[?&]dev\b/.test(location.search)) window.__transcritor = st; // diagnóstico (tools/testar-audiencia.js)

/* ---------- workers: asr = Whisper (texto), voz = CAM++ (impressão digital de voz) ---------- */
const workers = {}, FILES = { asr: './asr-worker.js', voz: './voz-worker.js' };
const VOICE_MODEL = new URL('../models/voz/campplus.onnx', import.meta.url).href;
let rpcId = 0;
const pending = new Map();
const dl = new Map();
function getWorker(kind = 'asr') {
  if (workers[kind]) return workers[kind];
  const worker = workers[kind] = new Worker(new URL(FILES[kind], import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') return onModelProgress(data);
    if (data.type === 'embedProgress') return pending.get(data.id)?.onProgress?.(data);
    const p = pending.get(data.id); if (!p) return;
    pending.delete(data.id);
    data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Falha no processamento')); pending.clear(); };
  return worker;
}
function rpc(msg, transfer = [], onProgress, kind = 'asr') {
  const id = ++rpcId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); getWorker(kind).postMessage({ ...msg, id }, transfer); });
}
function killWorker() {
  for (const k of Object.keys(workers)) { workers[k].terminate(); delete workers[k]; }
  for (const p of pending.values()) p.reject(new Error('cancelado')); pending.clear();
}

function onModelProgress(p) {
  if (p.status === 'progress' && p.total) dl.set(p.file + p.what, { loaded: p.loaded, total: p.total });
  if (p.status === 'done' && dl.has(p.file + p.what)) { const d = dl.get(p.file + p.what); d.loaded = d.total; }
  let loaded = 0, total = 0; for (const d of dl.values()) { loaded += d.loaded; total += d.total; }
  if (total > 0 && loaded < total) status(`Baixando o modelo de IA (só na primeira vez neste computador): ${Math.floor(loaded / total * 100)}% de ${fmtSize(total)}`, loaded / total);
}

/* ---------- status ---------- */
function status(text, frac) {
  $('t-status').hidden = !text;
  $('t-statusText').textContent = text || '';
  if (frac != null) $('t-prog').style.width = Math.round(frac * 100) + '%';
}

/* ---------- arquivos ---------- */
const isMedia = (f) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|webm|mkv|mp3|m4a|wav|ogg|opus|aac|wma|flac)$/i.test(f.name);
function addFiles(list) {
  let skipped = 0;
  for (const f of list) {
    if (!isMedia(f)) { skipped++; continue; }
    // arquivo de uma transcrição recuperada: só religa o player
    const orphan = st.files.find((x) => !x.blob && x.name === f.name);
    if (orphan) { orphan.blob = f; orphan.url = URL.createObjectURL(f); orphan.isVideo = /^video\//.test(f.type) || /\.(mp4|mov|webm|mkv)$/i.test(f.name); continue; }
    st.files.push({ id: nextId++, blob: f, name: f.name, url: URL.createObjectURL(f), isVideo: /^video\//.test(f.type) || /\.(mp4|mov|webm|mkv)$/i.test(f.name), title: f.name.replace(/\.[^.]+$/, ''), status: 'queued', progress: 0, segments: [] });
  }
  if (skipped) toast(`${skipped} arquivo(s) ignorado(s): use vídeo ou áudio.`);
  renderFiles(); renderResult();
}

const ST_LABEL = { queued: 'Na fila', decoding: 'Lendo áudio…', transcribing: 'Transcrevendo…', voices: 'Identificando vozes…', done: 'Pronto', error: 'Erro' };
const ST_CHIP = { queued: 'queued', decoding: 'working', transcribing: 'working', voices: 'working', done: 'done', error: 'error' };
function renderFiles() {
  const box = $('t-files');
  box.className = st.files.length ? 'list' : '';
  box.innerHTML = st.files.map((f, i) => `
    <div class="frow" data-id="${f.id}">
      <div class="num">VÍDEO ${i + 1}</div>
      <div class="name">
        <input class="title" data-act="title" value="${esc(f.title)}" aria-label="Título da seção ${i + 1}" ${running ? 'disabled' : ''}>
        <div class="meta">${esc(f.name)}${f.blob ? ' · ' + fmtSize(f.blob.size) : ' · arquivo não carregado (solte de novo para ouvir)'}${f.duration ? ' · ' + fmtDur(f.duration) : ''}${f.error ? ' · ' + esc(f.error) : ''}</div>
        ${f.status === 'transcribing' || f.status === 'voices' ? `<div class="bar-mini"><div style="width:${Math.round(f.progress * 100)}%"></div></div>` : ''}
      </div>
      <span class="chip ${ST_CHIP[f.status]}">${ST_LABEL[f.status]}</span>
      <div class="actions">
        <button class="link" data-act="up" ${i === 0 || running ? 'disabled' : ''} aria-label="Subir">↑</button>
        <button class="link" data-act="down" ${i === st.files.length - 1 || running ? 'disabled' : ''} aria-label="Descer">↓</button>
        <button class="link" data-act="remove" ${running ? 'disabled' : ''}>Remover</button>
      </div>
    </div>`).join('');
  const todo = st.files.some((f) => f.blob && f.status !== 'done');
  $('t-run').disabled = running || !todo;
  $('t-run').textContent = st.files.some((f) => f.status === 'done') && todo ? 'Transcrever os novos' : 'Transcrever';
  $('t-cancel').hidden = !running;
}

$('t-files').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b || running) return;
  const row = b.closest('.frow'), i = st.files.findIndex((f) => f.id === +row.dataset.id);
  if (b.dataset.act === 'remove') { const [f] = st.files.splice(i, 1); if (f.url) URL.revokeObjectURL(f.url); if (playerFile === f) playerFile = null; }
  if (b.dataset.act === 'up' && i > 0) st.files.splice(i - 1, 0, st.files.splice(i, 1)[0]);
  if (b.dataset.act === 'down' && i < st.files.length - 1) st.files.splice(i + 1, 0, st.files.splice(i, 1)[0]);
  renderFiles(); renderResult(); save();
});
$('t-files').addEventListener('input', (e) => {
  if (e.target.dataset.act !== 'title') return;
  const f = st.files.find((x) => x.id === +e.target.closest('.frow').dataset.id);
  f.title = e.target.value; renderSegs(); save();
});

/* ---------- transcrição ---------- */
async function run() {
  const model = $('t-model').value, task = $('t-task').value, language = $('t-lang').value;
  const clean = $('t-clean').checked, diarize = $('t-diar').checked;
  running = true; renderFiles();
  st.meta = { model, modelLabel: MODEL_LABEL[model], cleaned: clean, diarized: diarize, translated: task === 'translate' };
  const t0 = performance.now();
  try {
    status('Preparando o modelo de IA…', 0);
    const { device } = await rpc({ type: 'load', model });
    showDevice(device);
    if (diarize) await rpc({ type: 'load', url: VOICE_MODEL }, [], null, 'voz');
    const todo = st.files.filter((f) => f.blob && f.status !== 'done');
    for (const [n, f] of todo.entries()) {
      const label = `Vídeo ${st.files.indexOf(f) + 1} de ${st.files.length}`;
      f.status = 'decoding'; f.error = null; f.progress = 0; renderFiles();
      status(`${label}: lendo o áudio…`, 0);
      let audio = await decodeTo16k(f.blob);
      if (clean) { status(`${label}: limpando o ruído…`, 0); audio = await cleanAudio(audio); }
      f.duration = audio.length / SR;
      f.status = 'transcribing'; renderFiles();
      status(`${label}: transcrevendo…`, n / todo.length);
      const pts = slicePoints(audio);
      const segs = [];
      const started = performance.now();
      for (let k = 0; k < pts.length - 1; k++) {
        const s = pts[k], e = pts[k + 1], off = s / SR;
        if (!isSilent(audio, s, e)) {
          const slice = audio.slice(s, e);
          const { chunks } = await rpc({ type: 'transcribe', audio: slice, task, language }, [slice.buffer]);
          chunks.forEach((c, ci) => {
            const end = c.end != null ? c.end : (chunks[ci + 1] ? chunks[ci + 1].start : (e - s) / SR);
            segs.push(...splitTurns(off + (c.start || 0), off + end, c.text));
          });
        }
        f.progress = (k + 1) / (pts.length - 1);
        const el = (performance.now() - started) / 1000, done = e / SR;
        const eta = done > 0 ? (el / done) * (f.duration - done) : 0;
        status(`${label}: transcrevendo… ${Math.round(f.progress * 100)}%` + (k > 0 && eta > 5 ? ` · faltam cerca de ${fmtDur(eta)}` : ''), (n + f.progress * (diarize ? 0.85 : 1)) / todo.length);
        renderFiles();
      }
      f.segments = cleanSegments(segs);
      if (diarize) {
        f.status = 'voices'; f.progress = 0; renderFiles();
        status(`${label}: identificando as vozes…`, (n + 0.85) / todo.length);
        await embedVoices(f, audio, (p) => {
          f.progress = p; renderFiles();
          status(`${label}: identificando as vozes… ${Math.round(p * 100)}%`, (n + 0.85 + p * 0.15) / todo.length);
        });
      }
      audio = null;
      f.status = 'done'; f.progress = 1; renderFiles();
      if (!playerFile) setPlayer(f, 0, false);
    }
    if (diarize) regroupVoices(+$('t-nvoices').value, true);
    else st.voices = [];
    status('', 1);
    const mins = (performance.now() - t0) / 60000;
    toast(`Transcrição concluída em ${mins < 1 ? 'menos de 1 min' : Math.round(mins) + ' min'}. Confira os falantes e o texto.`);
  } catch (e) {
    const cur = st.files.find((f) => ['decoding', 'transcribing', 'voices'].includes(f.status));
    if (e.message === 'cancelado') { if (cur) cur.status = 'queued'; status('', 0); toast('Transcrição cancelada.'); }
    else {
      if (cur) { cur.status = 'error'; cur.error = e.message; }
      status('Erro: ' + e.message, 0);
      if (/memory|alloc|out of/i.test(e.message)) toast('Faltou memória. Tente a precisão Rápida ou divida o vídeo em partes menores.');
    }
  } finally {
    running = false; renderFiles(); renderResult(); save();
  }
}

// O Whisper marca troca de falante dentro do mesmo trecho com "-" ("-Tá. -Doutora Fulana?").
// Cada fala vira um trecho próprio, com o tempo dividido pelo tamanho do texto.
function splitTurns(start, end, text) {
  const parts = text.trim().split(/\s+(?=-\s*\S)/).map((p) => p.replace(/^-\s*/, '').trim()).filter(Boolean);
  if (parts.length <= 1) return [{ start, end, text: (parts[0] || '').trim(), voice: 0 }];
  const total = parts.reduce((a, p) => a + p.length, 0), dur = Math.max(0, end - start);
  let t = start;
  return parts.map((p) => { const d = dur * p.length / total; const seg = { start: t, end: t + d, text: p, voice: 0 }; t += d; return seg; });
}

function cleanSegments(segs) {
  const out = [];
  for (const s of segs) {
    // "Onde? Onde? Onde? Onde?" → "Onde?"
    s.text = (s.text || '').replace(/(\S.{0,40}?[.?!,]?)(?:\s+\1){3,}/g, '$1').trim();
    if (!s.text || HALLU.test(s.text)) continue;
    const prev = out[out.length - 1], prev2 = out[out.length - 2];
    if (prev && prev2 && prev.text === s.text && prev2.text === s.text) continue; // repetição em loop
    out.push(s);
  }
  return out;
}

async function embedVoices(f, audio, onProgress) {
  const clips = f.segments.map((s) => {
    const dur = s.end - s.start;
    if (dur < 1) return null;
    const take = Math.min(dur, 8), mid = (s.start + s.end) / 2;
    const a = Math.max(0, Math.floor((mid - take / 2) * SR)), b = Math.min(audio.length, Math.floor((mid + take / 2) * SR));
    return audio.slice(a, b);
  });
  const B = 40;
  for (let i = 0; i < clips.length; i += B) {
    const batch = clips.slice(i, i + B);
    const { vecs } = await rpc({ type: 'embed', clips: batch }, batch.filter(Boolean).map((c) => c.buffer), null, 'voz');
    vecs.forEach((v, j) => (f.segments[i + j].vec = v));
    onProgress(Math.min(1, (i + B) / clips.length));
  }
}

// Agrupa as falas de todos os vídeos por voz. Mantém nomes/papéis já preenchidos quando possível.
function regroupVoices(k, fresh) {
  const all = st.files.flatMap((f) => f.segments);
  if (!all.some((s) => s.vec)) { toast('Para reagrupar, transcreva os vídeos de novo nesta sessão.'); return; }
  const ids = clusterVoices(all.map((s) => s.vec || null), k);
  all.forEach((s, i) => (s.voice = ids[i]));
  const n = Math.max(...ids) + 1;
  const roles = suggestRoles(all, n);
  const old = st.voices;
  st.voices = Array.from({ length: n }, (_, i) => (old[i] && !old[i].suggested && !fresh ? old[i] : { role: roles[i], name: (old[i] && old[i].name) || '', suggested: !!roles[i] }));
  st.meta.diarized = true;
  renderResult(); applyPeopleToVoices(); save();
}

/* ---------- resultado: falantes + editor ---------- */
function voiceColor(i) { return `var(--v${(i % 8) + 1})`; }
function renderResult() {
  const has = st.files.some((f) => f.segments.length);
  $('t-result').hidden = !has;
  if (!has) return;
  renderVoices(); renderSegs(); renderPlayer();
}

function renderVoices() {
  const box = $('t-voices');
  if (!st.meta.diarized || !st.voices.length) {
    box.innerHTML = '<p class="hint">A separação de vozes está desligada. Ligue "Separar vozes por IA" e transcreva de novo para identificar os falantes.</p>';
    $('t-voiceHint').textContent = ''; return;
  }
  const all = st.files.flatMap((f) => f.segments);
  const count = st.voices.map((_, i) => all.filter((s) => s.voice === i).length);
  $('t-voiceHint').textContent = `· ${st.voices.length} voz(es) encontradas`;
  box.innerHTML = st.voices.map((v, i) => `
    <div class="voice" style="--vc:${voiceColor(i)}" data-v="${i}">
      <div class="vname"><span class="vdot"></span>Voz ${i + 1}${v.suggested ? '<span class="chip sug" title="Papel sugerido pelo app. Confira.">sugerido</span>' : ''}</div>
      <input data-k="role" value="${esc(v.role)}" placeholder="Papel (ex.: JUIZ, TESTEMUNHA)" aria-label="Papel da voz ${i + 1}">
      <input data-k="name" value="${esc(v.name)}" placeholder="Nome (ex.: DR. FULANO)" aria-label="Nome da voz ${i + 1}">
      <div class="meta">${count[i]} trecho(s) <button class="link" data-act="hear">Ouvir</button></div>
    </div>`).join('') +
    `<div class="bar"><span class="hint">É normal aparecerem mais vozes do que pessoas (a mesma pessoa perto e longe do microfone, por exemplo). Dê o mesmo papel e nome às vozes da mesma pessoa: no documento elas viram uma só. Se faltar alguém, reagrupe com mais vozes.</span>
      <span><select id="t-regroupN" aria-label="Número de vozes">${['Automático', 2, 3, 4, 5, 6, 7, 8].map((n, j) => `<option value="${j ? n : 0}">${n}</option>`).join('')}</select>
      <button class="link" id="t-regroup">Reagrupar vozes</button></span></div>`;
  box.querySelectorAll('[data-k="role"]').forEach((el) => combo(el, roleOptions));
  box.querySelectorAll('[data-k="name"]').forEach((el) => combo(el, () => people().map((p) => ({ value: p.name, hint: p.role }))));
}
$('t-voices').addEventListener('input', (e) => {
  const row = e.target.closest('.voice'); if (!row || !e.target.dataset.k) return;
  const v = st.voices[+row.dataset.v]; v[e.target.dataset.k] = e.target.value;
  // nome escolhido da lista de presentes: traz o papel junto
  if (e.target.dataset.k === 'name') {
    const p = people().find((x) => x.name === e.target.value.trim().toLocaleUpperCase('pt-BR'));
    if (p && (!v.role || v.suggested)) { v.role = p.role; row.querySelector('[data-k="role"]').value = p.role; }
  }
  v.suggested = false;
  row.querySelector('.chip.sug')?.remove();
  refreshVoiceSelects(); save();
});
$('t-voices').addEventListener('click', (e) => {
  if (e.target.id === 't-regroup') return regroupVoices(+$('t-regroupN').value, false);  if (e.target.dataset.act !== 'hear') return;
  const vi = +e.target.closest('.voice').dataset.v;
  for (const f of st.files) {
    const s = f.segments.find((x) => x.voice === vi && x.end - x.start > 2) || f.segments.find((x) => x.voice === vi);
    if (s) { setPlayer(f, s.start, true); return; }
  }
});

function optionsHtml(sel) {
  const labels = voiceLabels(st.voices);
  return labels.map((l, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
}
function refreshVoiceSelects() {
  document.querySelectorAll('#t-segs select').forEach((s) => { const v = +s.value; s.innerHTML = optionsHtml(v); });
}

function renderSegs() {
  const box = $('t-segs'), diar = st.meta.diarized && st.voices.length;
  box.innerHTML = st.files.map((f, fi) => {
    if (!f.segments.length) return '';
    let prev = -1;
    const rows = f.segments.map((s, si) => {
      const cont = diar && s.voice === prev; prev = s.voice;
      return `<div class="seg${cont ? ' cont' : ''}" data-f="${fi}" data-s="${si}" style="--vc:${diar ? voiceColor(s.voice) : 'transparent'}">
        <button class="ts" data-act="seek" title="Ouvir a partir daqui">${fmtTime(s.start)}</button>
        ${diar ? `<select aria-label="Falante">${optionsHtml(s.voice)}</select>` : '<span></span>'}
        <div class="txt" contenteditable="plaintext-only" spellcheck="true">${esc(s.text)}</div>
        <button class="del" data-act="del" aria-label="Apagar trecho" title="Apagar trecho">×</button>
      </div>`;
    }).join('');
    return `<h3 class="sec-title">Vídeo ${fi + 1} – ${esc(f.title || f.name)}</h3>${rows}`;
  }).join('');
  // Firefox não aceita plaintext-only
  if (box.querySelector('.txt') && box.querySelector('.txt').contentEditable !== 'plaintext-only') box.querySelectorAll('.txt').forEach((t) => (t.contentEditable = 'true'));
}
const segOf = (el) => { const r = el.closest('.seg'); return r && { f: st.files[+r.dataset.f], s: st.files[+r.dataset.f].segments[+r.dataset.s], row: r }; };
$('t-segs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const x = segOf(b);
  if (b.dataset.act === 'seek') setPlayer(x.f, x.s.start, true);
  if (b.dataset.act === 'del') { x.f.segments.splice(x.f.segments.indexOf(x.s), 1); renderSegs(); save(); }
});
$('t-segs').addEventListener('change', (e) => {
  if (e.target.tagName !== 'SELECT') return;
  const x = segOf(e.target); x.s.voice = +e.target.value; renderSegs(); renderVoices(); save();
});
let saveT;
$('t-segs').addEventListener('input', (e) => {
  if (!e.target.classList.contains('txt')) return;
  segOf(e.target).s.text = e.target.textContent; clearTimeout(saveT); saveT = setTimeout(save, 800);
});

/* ---------- player ---------- */
function setPlayer(f, t, play) {
  if (!f.url) { toast('Solte o arquivo "' + f.name + '" de novo para ouvir.'); return; }
  if (playerFile !== f) { playerFile = f; renderPlayer(); }
  const m = $('t-player').querySelector('video,audio');
  if (!m) return;
  const go = () => { m.currentTime = Math.max(0, t - 0.3); if (play) m.play().catch(() => {}); };
  m.readyState >= 1 ? go() : m.addEventListener('loadedmetadata', go, { once: true });
}
function renderPlayer() {
  const box = $('t-player');
  const f = playerFile && st.files.includes(playerFile) ? playerFile : null;
  if (!f || !f.url) { box.innerHTML = '<p class="count">Clique no horário de uma fala para ouvir o trecho.</p>'; return; }
  if (box.dataset.id === String(f.id) && box.querySelector('video,audio')) return;
  box.dataset.id = f.id;
  box.innerHTML = `<div class="pname">Vídeo ${st.files.indexOf(f) + 1} – ${esc(f.title || f.name)}</div>` +
    (f.isVideo ? `<video src="${f.url}" controls playsinline preload="metadata"></video>` : `<audio src="${f.url}" controls preload="metadata"></audio>`);
  const m = box.querySelector('video,audio');
  m.addEventListener('timeupdate', () => highlight(f, m.currentTime, !m.paused));
}
let lastHl = null;
function highlight(f, t, follow) {
  const fi = st.files.indexOf(f); let idx = -1;
  for (let i = 0; i < f.segments.length; i++) { if (f.segments[i].start <= t + 0.05) idx = i; else break; }
  const row = idx >= 0 ? $('t-segs').querySelector(`.seg[data-f="${fi}"][data-s="${idx}"]`) : null;
  if (row === lastHl) return;
  lastHl?.classList.remove('now'); row?.classList.add('now'); lastHl = row;
  if (row && follow && !document.activeElement?.classList.contains('txt')) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- dados da audiência ---------- */
const SIMPLE = ['proc', 'juizo', 'tipo', 'data', 'local', 'fato', 'cliente'];
function fillSimple() { for (const k of SIMPLE) { const el = $('h-' + k); if (el.value !== st.header[k]) el.value = st.header[k] || ''; } }
for (const k of SIMPLE) {
  $('h-' + k).addEventListener('input', () => { st.header[k] = $('h-' + k).value; clearTimeout(saveT); saveT = setTimeout(save, 600); });
}
combo($('h-tipo'), () => TIPOS.map((value) => ({ value })));

// listas: um campo por autor, por réu e por pessoa presente
function renderParties(kind) {
  const box = $('h-' + kind), list = st.header[kind];
  box.innerHTML = list.map((n, i) => `
    <div class="prow" data-i="${i}">
      <input value="${esc(n)}" aria-label="${kind === 'autores' ? 'Autor' : 'Réu'} ${i + 1}" placeholder="Nome completo">
      <button class="rm" data-rm title="Remover" aria-label="Remover">×</button>
    </div>`).join('');
}
function renderPresentes() {
  const box = $('h-presentes');
  box.innerHTML = st.header.presentes.map((p, i) => `
    <div class="prow pessoa" data-i="${i}">
      <input data-f="role" value="${esc(p.role)}" placeholder="Papel" aria-label="Papel da pessoa ${i + 1}">
      <input class="nm" data-f="name" value="${esc(p.name)}" placeholder="Nome" aria-label="Nome da pessoa ${i + 1}">
      <input data-f="oab" value="${esc(p.oab || '')}" placeholder="OAB (se advogado)" aria-label="OAB da pessoa ${i + 1}">
      <button class="rm" data-rm title="Remover" aria-label="Remover">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-f="role"]').forEach((el) => combo(el, roleOptions));
}
function renderHeader() { fillSimple(); renderParties('autores'); renderParties('reus'); renderPresentes(); }

for (const kind of ['autores', 'reus', 'presentes']) {
  const box = $('h-' + kind);
  box.addEventListener('input', (e) => {
    const row = e.target.closest('.prow'); if (!row) return;
    const i = +row.dataset.i;
    if (kind === 'presentes') st.header.presentes[i][e.target.dataset.f] = e.target.value;
    else st.header[kind][i] = e.target.value;
    clearTimeout(saveT); saveT = setTimeout(save, 600);
  });
  box.addEventListener('click', (e) => {
    if (!e.target.closest('[data-rm]')) return;
    st.header[kind].splice(+e.target.closest('.prow').dataset.i, 1);
    kind === 'presentes' ? renderPresentes() : renderParties(kind); save();
  });
}
document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.add;
  st.header[kind].push(kind === 'presentes' ? { role: '', name: '', oab: '', note: '' } : '');
  kind === 'presentes' ? renderPresentes() : renderParties(kind);
  const rows = $('h-' + kind).querySelectorAll('.prow');
  rows[rows.length - 1].querySelector(kind === 'presentes' ? '[data-f="name"]' : 'input').focus();
}));

// Pessoas presentes (para sugerir nomes aos falantes)
function people() {
  return st.header.presentes.filter((p) => p.name.trim()).map((p) => ({ role: p.role.trim().toLocaleUpperCase('pt-BR'), name: p.name.trim().toLocaleUpperCase('pt-BR') }));
}
// Com um único juiz/promotor na lista, preenche o nome da voz que tem esse papel.
function applyPeopleToVoices() {
  const ps = people();
  let changed = false;
  for (const [re, base] of [[/^JU[IÍ]Z/, 'JUIZ'], [/^PROMOTOR/, 'PROMOTOR']]) {
    const cand = ps.filter((p) => re.test(p.role));
    const vs = st.voices.filter((v) => re.test((v.role || '').toUpperCase()) || (v.suggested && v.role === base));
    if (cand.length === 1) for (const v of vs) if (!v.name) { v.name = cand[0].name; v.role = cand[0].role; changed = true; }
  }
  if (changed) renderResult();
}

/* ---------- ata: enviar ou digitar ---------- */
function setHeaderMode(mode) {
  for (const b of document.querySelectorAll('.seg-switch [data-mode]')) b.setAttribute('aria-checked', b.dataset.mode === mode);
  $('h-ataDrop').hidden = mode !== 'ata';
  $('h-form').hidden = mode !== 'manual';
}
$('h-review').addEventListener('click', (e) => { e.stopPropagation(); setHeaderMode('manual'); });
document.querySelectorAll('.seg-switch [data-mode]').forEach((b) => b.addEventListener('click', () => setHeaderMode(b.dataset.mode)));
setHeaderMode('ata');

async function importAta(file) {
  const stEl = $('h-ataStatus');
  stEl.className = 'ata-status'; stEl.textContent = 'Lendo a ata…';
  try {
    const text = await ataText(file);
    const a = parseAta(text);
    const got = [];
    const labels = { proc: 'processo', juizo: 'juízo', tipo: 'tipo de audiência', data: 'data', local: 'local' };
    for (const k of Object.keys(labels)) if (a[k]) { st.header[k] = a[k]; got.push(labels[k]); }
    if (a.autores.length) { st.header.autores = a.autores; got.push(`${a.autores.length} autor(es)`); }
    if (a.reus.length) { st.header.reus = a.reus; got.push(`${a.reus.length} réu(s)`); }
    if (a.people.length) { st.header.presentes = a.people; got.push(`${a.people.length} presente(s)`); }
    st.ata = { name: file.name, text: text.slice(0, 60000) };
    renderHeader(); applyPeopleToVoices(); save();
    $('h-review').hidden = !got.length;
    if (got.length) { stEl.className = 'ata-status ok'; stEl.textContent = `${file.name}: encontrados ${got.join(', ')}.`; }
    else { stEl.className = 'ata-status err'; stEl.textContent = `${file.name}: não encontrei os dados no formato esperado. Digite manualmente; o texto da ata vai junto no "Copiar para o Claude".`; }
  } catch (e) {
    stEl.className = 'ata-status err'; stEl.textContent = e.message;
  }
}
const ataDrop = $('h-ataDrop'), ataPicker = $('h-ataPicker');
ataDrop.addEventListener('click', () => ataPicker.click());
ataDrop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ataPicker.click(); } });
ataPicker.addEventListener('change', () => { if (ataPicker.files[0]) importAta(ataPicker.files[0]); ataPicker.value = ''; });
['dragenter', 'dragover'].forEach((ev) => ataDrop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); ataDrop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => ataDrop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); ataDrop.classList.remove('over'); }));
ataDrop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) importAta(f); });
renderHeader();

/* ---------- exportar ---------- */
function baseName() {
  const b = st.header.proc ? 'transcricao-' + st.header.proc : 'transcricao-' + (st.files[0]?.title || 'audiencia');
  return b.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function download(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const exportable = () => ({ ...st, files: st.files.filter((f) => f.segments.length) });
const times = () => $('x-times').checked;
$('x-md').addEventListener('click', () => download(baseName() + '.md', new Blob([toMarkdown(exportable(), { times: times() })], { type: 'text/markdown;charset=utf-8' })));
$('x-txt').addEventListener('click', () => download(baseName() + '.txt', new Blob(['﻿' + toText(exportable(), { times: times() })], { type: 'text/plain;charset=utf-8' })));
$('x-docx').addEventListener('click', async () => download(baseName() + '.docx', await toDocx(exportable(), { times: times() })));
$('x-srt').addEventListener('click', async () => {
  const e = exportable();
  if (e.files.length === 1) return download(e.files[0].title.replace(/[\\/:*?"<>|]+/g, '-') + '.srt', new Blob([toSrt(e, e.files[0])], { type: 'text/plain;charset=utf-8' }));
  const zip = new JSZip();
  e.files.forEach((f, i) => zip.file(`video-${i + 1} - ${f.title.replace(/[\\/:*?"<>|]+/g, '-')}.srt`, toSrt(e, f)));
  download(baseName() + '-legendas.zip', await zip.generateAsync({ type: 'blob' }));
});
$('x-claude').addEventListener('click', () => {
  const text = claudePrompt(st, toMarkdown(exportable(), { times: times() }));
  navigator.clipboard.writeText(text).then(
    () => toast('Copiado. Cole numa conversa com o Claude.'),
    () => { download(baseName() + '-para-claude.md', new Blob([text], { type: 'text/markdown' })); toast('Não deu para copiar; baixei o arquivo para você anexar no Claude.'); });
});

/* ---------- salvar / recuperar ---------- */
function save() {
  if (!st.files.some((f) => f.segments.length)) return;
  const data = {
    savedAt: Date.now(), voices: st.voices, header: st.header, meta: st.meta, ata: st.ata,
    files: st.files.filter((f) => f.segments.length).map((f) => ({ name: f.name, title: f.title, isVideo: f.isVideo, duration: f.duration, segments: f.segments.map(({ start, end, text, voice }) => ({ start, end, text, voice })) })),
  };
  try { localStorage.setItem('t-last', JSON.stringify(data)); } catch (e) {}
}
function offerRestore() {
  let d; try { d = JSON.parse(localStorage.getItem('t-last') || 'null'); } catch (e) {}
  if (!d || !d.files?.length) return;
  const b = $('t-restore');
  b.hidden = false;
  b.textContent = `Recuperar última transcrição (${d.files.length} vídeo(s), ${new Date(d.savedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })})`;
  b.onclick = () => {
    st.voices = d.voices || []; st.meta = d.meta; st.ata = d.ata || null;
    const h = d.header || {};
    for (const k of SIMPLE) if (typeof h[k] === 'string') st.header[k] = h[k];
    // versões anteriores guardavam texto corrido em autor/reu/presentes
    const split = (s) => (s || '').split(/;|\n/).map((x) => x.trim()).filter(Boolean);
    st.header.autores = Array.isArray(h.autores) ? h.autores : split(h.autor);
    st.header.reus = Array.isArray(h.reus) ? h.reus : split(h.reu);
    st.header.presentes = Array.isArray(h.presentes) ? h.presentes
      : split(h.presentes).map((l) => { const m = l.match(/^([^:]{2,60}):\s*(.*)$/); return m ? { role: m[1].trim(), name: m[2].trim(), oab: '', note: '' } : null; }).filter(Boolean);
    renderHeader();
    st.files = d.files.map((f) => ({ id: nextId++, blob: null, url: null, status: 'done', progress: 1, ...f }));
    b.hidden = true; renderFiles(); renderResult();
    toast('Transcrição recuperada. Solte os vídeos de novo se quiser ouvir os trechos.');
  };
}

/* ---------- eventos gerais ---------- */
const drop = $('t-drop'), picker = $('t-picker');
drop.addEventListener('click', () => picker.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
window.addEventListener('drop', (e) => { if (!$('tab-transcritor').hidden && !drop.contains(e.target)) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });

$('t-run').addEventListener('click', run);
$('t-cancel').addEventListener('click', () => { killWorker(); });
$('t-model').addEventListener('change', () => {
  const turbo = /turbo/.test($('t-model').value);
  const tr = $('t-task').querySelector('[value="translate"]');
  tr.disabled = turbo; if (turbo && $('t-task').value === 'translate') $('t-task').value = 'transcribe';
  tr.textContent = turbo ? 'Traduzir para o inglês (use Rápida ou Equilibrada)' : 'Traduzir para o inglês';
});
window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

function showDevice(device) {
  $('t-device').textContent = device === 'webgpu'
    ? 'Usando a placa de vídeo (transcrição acelerada).'
    : 'Sem placa de vídeo compatível: a transcrição usa o processador e fica mais lenta.';
}
(async () => {
  try { const { gpu } = await rpc({ type: 'gpu' }); showDevice(gpu ? 'webgpu' : 'wasm'); } catch (e) {}
})();
renderFiles(); offerRestore();
