// Abas: o endereço guarda a aba aberta (#inicio / #conversor / #transcritor). Sem endereço, abre o Início.
(() => {
  const btns = [...document.querySelectorAll('.tabs [data-tab]')];
  function show(name) {
    if (!btns.some((b) => b.dataset.tab === name)) name = 'inicio';
    for (const b of btns) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', on);
      document.getElementById('tab-' + b.dataset.tab).hidden = !on;
    }
    window.dispatchEvent(new CustomEvent('aba', { detail: name }));
  }
  window.abrirAba = (name) => { history.replaceState(null, '', '#' + name); show(name); window.scrollTo(0, 0); };
  btns.forEach((b) => b.addEventListener('click', () => window.abrirAba(b.dataset.tab)));
  show(location.hash.slice(1));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
})();
