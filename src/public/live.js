// Rafraîchissement automatique des pages tournoi / match : on interroge l'état du
// tournoi toutes les 20 s et on recharge la page quand il a changé (nouvelle ronde,
// résultat saisi, clôture…) — sauf si l'utilisateur est en train de remplir un champ.
(function () {
  const el = document.getElementById('live');
  if (!el || !el.dataset.url) return;
  let sig = el.dataset.sig;
  const INTERVAL = 20000;

  function typing() {
    const a = document.activeElement;
    return a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
  }

  async function tick() {
    if (document.hidden) return;
    try {
      const res = await fetch(el.dataset.url, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      if (data.sig && data.sig !== sig) {
        if (typing()) { sig = sig; return; } // on réessaie au prochain tick
        location.reload();
      }
    } catch { /* réseau indisponible : on réessaie plus tard */ }
  }

  setInterval(tick, INTERVAL);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
