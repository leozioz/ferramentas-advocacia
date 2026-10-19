// Página inicial: atalhos, arquivo solto em qualquer lugar vai para a ferramenta certa,
// transcrição em andamento e situação dos modelos neste computador.
(() => {
  const $ = (id) => document.getElementById(id);


  document.querySelectorAll('[data-ir]').forEach((b) => b.addEventListener('click', () => abrirAba(b.dataset.ir)));

  /* ---------- soltar qualquer arquivo ---------- */
  const ehMidia = (f) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|webm|mkv|mp3|m4a|wav|ogg|opus|aac|wma|flac)$/i.test(f.name);
  const quandoTranscritor = (fn) => (window.transcritorAdd ? fn() : window.addEventListener('transcritor-pronto', fn, { once: true }));
  function distribuir(files) {
    const midia = files.filter(ehMidia), docs = files.filter((f) => !ehMidia(f));
    if (docs.length) window.conversorAdd(docs);
    if (midia.length) quandoTranscritor(() => window.transcritorAdd(midia));
    abrirAba(midia.length && !docs.length ? 'transcritor' : 'conversor');
  }
  const drop = $('i-drop'), picker = $('i-picker');
  drop.addEventListener('click', () => picker.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
  picker.addEventListener('change', () => { distribuir([...picker.files]); picker.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => distribuir([...e.dataTransfer.files]));
  window.addEventListener('drop', (e) => { if (!$('tab-inicio').hidden && !drop.contains(e.target)) { e.preventDefault(); distribuir([...e.dataTransfer.files]); } });

  /* ---------- continuar de onde parou ---------- */
  function continuar() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem('t-last') || 'null'); } catch (e) {}
    const box = $('i-continuar');
    if (!d || !d.files || !d.files.length) { box.hidden = true; return; }
    const proc = d.header && d.header.proc;
    const nomes = d.files.map((f) => f.title || f.name);
    $('i-cont-titulo').textContent = proc ? `Audiência do processo ${proc}` : nomes[0] + (nomes.length > 1 ? ` e mais ${nomes.length - 1}` : '');
    const quando = new Date(d.savedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    $('i-cont-meta').textContent = `${d.files.length} vídeo(s) · salva em ${quando} · neste computador`;
    box.hidden = false;
  }
  $('i-cont-abrir').addEventListener('click', () => {
    abrirAba('transcritor');
    quandoTranscritor(() => window.transcritorRestaurar());
  });
  window.addEventListener('aba', (e) => { if (e.detail === 'inicio') { continuar(); situacao(); } });

  /* ---------- situação dos modelos neste computador ---------- */
  async function situacao() {
    const partes = [];
    try {
      const nomes = (await caches.keys()).filter((n) => /transformers/i.test(n));
      let whisper = '';
      for (const n of nomes) {
        const urls = (await (await caches.open(n)).keys()).map((r) => r.url);
        const m = ['large-v3-turbo', 'small', 'base'].find((t) => urls.some((u) => u.includes('whisper-' + t)));
        if (m) { whisper = { 'large-v3-turbo': 'máxima', small: 'equilibrada', base: 'rápida' }[m]; break; }
      }
      partes.push(whisper ? `transcrição ✓ (${whisper})` : 'transcrição: baixa na 1ª vez (~500 MB)');
    } catch (e) {}
    try {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      partes.push(dbs.some((d) => d.name === 'keyval-store') ? 'OCR ✓' : 'OCR: baixa na 1ª vez (~15 MB)');
    } catch (e) {}
    $('i-status').textContent = partes.length ? 'Neste computador: ' + partes.join(' · ') + '.' : '';
  }

  if (!$('tab-inicio').hidden) { continuar(); situacao(); }
})();
