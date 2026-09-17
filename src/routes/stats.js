import { Router } from 'express';
import { gamesOf } from '../swiss.js';

const router = Router();

// Stats calculées en parcourant tous les matchs de tous les tournois.
// Les byes sont exclus (pas un vrai match) ; les nuls comptent pour 0,5 victoire.
router.get('/stats', async (req, res, next) => {
  try {
    const tournaments = await req.db.collection('tournaments').find().toArray();

    const playerStats = new Map(); // userId → stats
    const deckStats = new Map(); // deckId (ou nom) → stats

    const bump = (map, key, seed, outcome, games) => {
      if (!map.has(key)) {
        map.set(key, { ...seed, matches: 0, wins: 0, draws: 0, losses: 0, gameWins: 0, gameDraws: 0, gameLosses: 0, cups: 0 });
      }
      const s = map.get(key);
      if (outcome) {
        s.matches += 1;
        s[outcome] += 1;
        s.gameWins += games.won;
        s.gameLosses += games.lost;
        s.gameDraws += games.drawn;
      }
      return s;
    };

    for (const t of tournaments) {
      for (const round of t.rounds || []) {
        for (const m of round.matches || []) {
          if (m.bye || !m.result) continue;
          const g = gamesOf(m, t.bestOf || 1);
          const sides = [
            { p: m.p1, outcome: m.result === 'p1' ? 'wins' : m.result === 'p2' ? 'losses' : 'draws', games: { won: g.p1, lost: g.p2, drawn: g.draws || 0 } },
            { p: m.p2, outcome: m.result === 'p2' ? 'wins' : m.result === 'p1' ? 'losses' : 'draws', games: { won: g.p2, lost: g.p1, drawn: g.draws || 0 } },
          ];
          for (const { p, outcome, games } of sides) {
            bump(playerStats, String(p.userId), { username: p.username, userId: String(p.userId) }, outcome, games);
            const deckKey = p.deckId ? String(p.deckId) : `${p.username}::${p.deckName}`;
            bump(deckStats, deckKey, { deckName: p.deckName, ownerName: p.username, ownerId: String(p.userId) }, outcome, games);
          }
        }
      }
      if (t.winner) {
        bump(playerStats, String(t.winner.userId), { username: t.winner.username, userId: String(t.winner.userId) }, null).cups += 1;
        const deckKey = t.winner.deckId ? String(t.winner.deckId) : `${t.winner.username}::${t.winner.deckName}`;
        bump(deckStats, deckKey, { deckName: t.winner.deckName, ownerName: t.winner.username, ownerId: String(t.winner.userId) }, null).cups += 1;
      }
    }

    const withRate = (s) => ({
      ...s,
      winRate: s.matches > 0 ? (s.wins + s.draws / 2) / s.matches : 0,
      gameWinRate:
        s.gameWins + s.gameDraws + s.gameLosses > 0
          ? (s.gameWins + s.gameDraws / 2) / (s.gameWins + s.gameDraws + s.gameLosses)
          : 0,
    });
    const players = [...playerStats.values()].map(withRate).sort((a, b) => b.cups - a.cups || b.winRate - a.winRate || b.matches - a.matches);
    const decks = [...deckStats.values()].map(withRate).sort((a, b) => b.cups - a.cups || b.winRate - a.winRate || b.matches - a.matches);

    res.render('stats', { players, decks });
  } catch (err) {
    next(err);
  }
});

export default router;
