// Lista de sugestões com o visual do site (substitui o <datalist> nativo).
// combo(input, () => [{ value, hint }]) — filtra enquanto digita; setas, Enter e Esc funcionam.
let box = null, cur = null, items = [], active = -1;

function ensureBox() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'combo-list';
  box.setAttribute('role', 'listbox');
  box.hidden = true;
  document.body.appendChild(box);
  box.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-i]'); if (!li) return;
    e.preventDefault(); pick(+li.dataset.i);
  });
  document.addEventListener('mousedown', (e) => { if (cur && e.target !== cur && !box.contains(e.target)) close(); });
  window.addEventListener('scroll', () => cur && place(), true);
  window.addEventListener('resize', () => cur && place());
  return box;
}
function place() {
  const r = cur.getBoundingClientRect();
  box.style.left = r.left + 'px';
  box.style.top = r.bottom + 4 + 'px';
  box.style.width = Math.max(r.width, 220) + 'px';
}
function close() { if (box) box.hidden = true; cur = null; active = -1; }
function pick(i) {
  const it = items[i]; if (!it || !cur) return;
  cur.value = it.value;
  cur.dispatchEvent(new Event('input', { bubbles: true }));
  cur.dispatchEvent(new Event('change', { bubbles: true }));
  close();
}
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function show(input, source, all) {
  ensureBox(); cur = input;
  const q = norm(input.value.trim());
  items = source().filter((o) => all || !q || norm(o.value).includes(q) || norm(o.hint || '').includes(q)).slice(0, 40);
  if (!items.length || (items.length === 1 && items[0].value === input.value)) { box.hidden = true; return; }
  active = -1;
  box.innerHTML = items.map((o, i) => `<div class="combo-item" role="option" data-i="${i}"><span>${esc(o.value)}</span>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</div>`).join('');
  box.hidden = false; place();
}
function move(d) {
  if (box.hidden || !items.length) return;
  active = (active + d + items.length) % items.length;
  [...box.children].forEach((c, i) => c.classList.toggle('on', i === active));
  box.children[active].scrollIntoView({ block: 'nearest' });
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function combo(input, source) {
  input.setAttribute('autocomplete', 'off');
  input.classList.add('combo-input');
  input.addEventListener('focus', () => show(input, source, true));
  input.addEventListener('click', () => show(input, source, true));
  input.addEventListener('input', (e) => { if (e.isTrusted) show(input, source, false); });
  input.addEventListener('blur', () => setTimeout(() => { if (cur === input) close(); }, 120));
  input.addEventListener('keydown', (e) => {
    if (cur !== input || !box || box.hidden) { if (e.key === 'ArrowDown') show(input, source, true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') close();
  });
}
