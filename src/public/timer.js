// Compte à rebours de la ronde en cours (durée paramétrable, 50 min par défaut).
// Gère tous les timers de la page : chaque conteneur `[data-started][data-length]`
// met à jour son propre `.timer` (bannière « à toi de saisir », tuile du tournoi, pilule du match…).
(function () {
  const bars = [...document.querySelectorAll('[data-started][data-length]')]
    .map((bar) => ({ bar, el: bar.querySelector('.timer'), started: parseInt(bar.dataset.started, 10), lengthMs: parseInt(bar.dataset.length, 10) * 60 * 1000 }))
    .filter((t) => t.el && Number.isFinite(t.started) && Number.isFinite(t.lengthMs));
  if (bars.length === 0) return;

  function tick() {
    const now = Date.now();
    for (const t of bars) {
      const remaining = t.started + t.lengthMs - now;
      const abs = Math.abs(remaining);
      const min = Math.floor(abs / 60000);
      const sec = Math.floor((abs % 60000) / 1000);
      const text = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      if (remaining <= 0) {
        t.el.textContent = t.el.classList.contains('todo-timer') || t.el.classList.contains('hero-timer') ? `+${text}` : `TEMPS ÉCOULÉ (+${text})`;
        t.el.classList.add('over');
      } else {
        t.el.textContent = text;
        t.el.classList.toggle('warning', remaining < 10 * 60 * 1000);
      }
    }
  }

  tick();
  setInterval(tick, 1000);
})();
