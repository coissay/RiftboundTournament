// Limiteur de débit minimal, en mémoire, par clé (ex. id utilisateur) : au plus `max`
// événements par fenêtre glissante de `windowMs`. Best-effort : un seul processus, remis à
// zéro au redémarrage — suffisant pour freiner un abus depuis un compte connecté.
export function createRateLimiter({ max, windowMs }) {
  const hits = new Map(); // key → timestamps (ms) dans la fenêtre
  return {
    // Vrai si l'événement est accepté (et comptabilisé), faux s'il dépasse la limite.
    take(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 10000) for (const [k, ts] of hits) if (!ts.some((t) => now - t < windowMs)) hits.delete(k);
      return true;
    },
  };
}
