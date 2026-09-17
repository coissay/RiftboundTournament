// Clôture automatique des tournois laissés en attente.
//
// Un tournoi non terminé dont la dernière activité remonte à plus de AUTO_CLOSE_DAYS
// jours passe en « terminé » sans attribuer de coupe (`autoClosed: true`). L'organisateur
// ou un admin peut le rouvrir depuis la page du tournoi (route /reopen).
//
// « Dernière activité » = la plus récente de : date prévue du tournoi, création,
// démarrage de la dernière ronde, dernière réouverture.

export const AUTO_CLOSE_DAYS = Number(process.env.AUTO_CLOSE_DAYS) || 7;
const CHECK_EVERY_MS = 60 * 60 * 1000; // une passe par heure

export function lastActivityAt(tournament) {
  const dates = [tournament.date, tournament.createdAt, tournament.reopenedAt, ...(tournament.rounds || []).map((r) => r.startedAt)]
    .filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
}

export function isStale(tournament, now = new Date()) {
  const last = lastActivityAt(tournament);
  return !!last && now.getTime() - last.getTime() > AUTO_CLOSE_DAYS * 24 * 3600 * 1000;
}

/** Clôture les tournois en attente depuis trop longtemps. Renvoie le nombre de tournois clôturés. */
export async function autoCloseStale(db, now = new Date()) {
  const open = await db
    .collection('tournaments')
    .find({ status: { $ne: 'terminé' } }, { projection: { name: 1, status: 1, date: 1, createdAt: 1, reopenedAt: 1, 'rounds.startedAt': 1 } })
    .toArray();
  let closed = 0;
  for (const t of open) {
    if (!isStale(t, now)) continue;
    // Le filtre sur le statut évite d'écraser une clôture manuelle faite entre-temps.
    const { modifiedCount } = await db.collection('tournaments').updateOne(
      { _id: t._id, status: { $ne: 'terminé' } },
      { $set: { status: 'terminé', finishedAt: now, autoClosed: true, winner: null } }
    );
    if (modifiedCount) {
      closed += 1;
      console.log(`Tournoi « ${t.name} » clôturé automatiquement (en attente depuis plus de ${AUTO_CLOSE_DAYS} j).`);
    }
  }
  return closed;
}

/** Lance une passe au démarrage puis une par heure. Une erreur est loguée sans arrêter le serveur. */
export function startHousekeeping(db) {
  const run = () => autoCloseStale(db).catch((err) => console.error('Clôture automatique :', err));
  run();
  setInterval(run, CHECK_EVERY_MS);
}
