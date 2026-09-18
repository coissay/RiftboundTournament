// Mode table : la page match en plein écran (timer géant, gros boutons de score),
// pour poser le téléphone entre les deux joueurs. Bascule par le bouton « Mode table »,
// sortie par le bouton ✕ ou Échap ; mémorisé pour la page (sessionStorage).
(function () {
  const toggle = document.getElementById('table-mode-toggle');
  if (!toggle) return;
  const KEY = 'table-mode:' + location.pathname;

  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'btn btn-ghost btn-small table-mode-exit';
  exit.textContent = '✕ Quitter le mode table';
  document.body.appendChild(exit);

  function enter() {
    document.body.classList.add('table-mode');
    sessionStorage.setItem(KEY, '1');
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }
  function leave() {
    document.body.classList.remove('table-mode');
    sessionStorage.removeItem(KEY);
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }

  toggle.addEventListener('click', enter);
  exit.addEventListener('click', leave);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('table-mode')) leave(); });
  // Sortie du plein écran par le navigateur (geste système) : on quitte aussi le mode table.
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('table-mode')) document.body.classList.remove('table-mode'); });

  // Après un rechargement (résultat saisi, rafraîchissement auto), on reste en mode table.
  if (sessionStorage.getItem(KEY) === '1') document.body.classList.add('table-mode');
})();
