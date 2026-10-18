// Abas: o endereço guarda a aba aberta (#conversor / #transcritor)
(() => {
  const btns = [...document.querySelectorAll('.tabs [data-tab]')];
  function show(name) {
    if (!btns.some((b) => b.dataset.tab === name)) name = 'conversor';
    for (const b of btns) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', on);
      document.getElementById('tab-' + b.dataset.tab).hidden = !on;
    }
    try { localStorage.setItem('aba', name); } catch (e) {}
  }
  btns.forEach((b) => b.addEventListener('click', () => { history.replaceState(null, '', '#' + b.dataset.tab); show(b.dataset.tab); }));
  let start = location.hash.slice(1);
  if (!start) try { start = localStorage.getItem('aba') || ''; } catch (e) {}
  show(start);
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
})();
