// Loaded synchronously in <head> to apply the saved theme before first paint.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('fares-theme'); } catch (e) { /* storage blocked */ }
  var dark = saved ? saved === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
