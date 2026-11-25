// Site top bar: search (window.find highlights and scrolls to the match), print.
const q = document.getElementById('q');
const find = back => { if (q.value) window.find(q.value, false, back, true); };
q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey); } });
q.addEventListener('input', () => { getSelection().removeAllRanges(); find(false); q.focus(); });
document.getElementById('print').onclick = () => window.print();
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); q.focus(); q.select(); }
});
