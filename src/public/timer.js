// Compte à rebours de la ronde en cours (durée paramétrable, 50 min par défaut).
(function () {
  const bar = document.querySelector('.timer-bar');
  if (!bar) return;
  const started = parseInt(bar.dataset.started, 10);
  const lengthMs = parseInt(bar.dataset.length, 10) * 60 * 1000;
  const el = document.getElementById('round-timer');

  function tick() {
    const remaining = started + lengthMs - Date.now();
    const abs = Math.abs(remaining);
    const min = Math.floor(abs / 60000);
    const sec = Math.floor((abs % 60000) / 1000);
    const text = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    if (remaining <= 0) {
      el.textContent = `TEMPS ÉCOULÉ (+${text})`;
      el.classList.add('over');
    } else {
      el.textContent = text;
      el.classList.toggle('warning', remaining < 10 * 60 * 1000);
    }
  }

  tick();
  setInterval(tick, 1000);
})();
