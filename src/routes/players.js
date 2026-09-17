import { Router } from 'express';
import { oid } from '../db.js';
import { gamesOf } from '../swiss.js';

const router = Router();

// Agrège les événements officiels (locator) : bilan global + bilan par deck joué.
function summarizeExternal(events) {
  const total = { events: events.length, matches: 0, wins: 0, draws: 0, losses: 0, byes: 0, gameWins: 0, gameLosses: 0, top: 0 };
  const byDeck = new Map();
  for (const ev of events) {
    if (ev.finalPlace && ev.finalPlace <= 3) total.top += 1;
    const key = ev.matchedDeck ? String(ev.matchedDeck.deckId) : `ext::${ev.deck?.name || ev.deck?.archetype || 'Deck inconnu'}`;
    if (!byDeck.has(key)) {
      byDeck.set(key, {
        key, deckId: ev.matchedDeck ? ev.matchedDeck.deckId : null,
        name: ev.matchedDeck ? ev.matchedDeck.deckName : ev.deck?.name || ev.deck?.archetype || 'Deck inconnu',
        legend: ev.deck?.definingCard?.name || null, image: ev.deck?.definingCard?.image || null,
        events: 0, matches: 0, wins: 0, draws: 0, losses: 0,
      });
    }
    const d = byDeck.get(key);
    d.events += 1;
    for (const m of ev.matches || []) {
      if (m.outcome === 'bye') { total.byes += 1; continue; }
      if (m.outcome === 'unknown') continue;
      total.matches += 1; d.matches += 1;
      const k = m.outcome === 'win' ? 'wins' : m.outcome === 'draw' ? 'draws' : 'losses';
      total[k] += 1; d[k] += 1;
      total.gameWins += m.gamesWon || 0;
      total.gameLosses += m.gamesLost || 0;
    }
  }
  const rate = (s) => (s.matches > 0 ? (s.wins + s.draws / 2) / s.matches : 0);
  total.winRate = rate(total);
  const decks = [...byDeck.values()].map((d) => ({ ...d, winRate: rate(d) })).sort((a, b) => b.matches - a.matches);
  return { total, decks };
}

// Page joueur façon locator : palmarès + historique complet des matchs.
router.get('/players/:id', async (req, res, next) => {
  try {
    const user = await req.db.collection('users').findOne({ _id: oid(req.params.id) });
    if (!user) return res.status(404).render('error', { message: 'Joueur introuvable' });
    const userId = String(user._id);

    const tournaments = await req.db.collection('tournaments').find({ 'players.userId': user._id }).sort({ date: -1 }).toArray();

    const history = [];
    const cups = [];
    const summary = { matches: 0, wins: 0, draws: 0, losses: 0, byes: 0, gameWins: 0, gameDraws: 0, gameLosses: 0 };

    for (const t of tournaments) {
      if (t.winner && String(t.winner.userId) === userId) {
        cups.push({ tournamentId: t._id, name: t.name, date: t.date, deckName: t.winner.deckName });
      }
      for (const round of t.rounds || []) {
        for (const m of round.matches || []) {
          const meIsP1 = String(m.p1.userId) === userId;
          const meIsP2 = !m.bye && String(m.p2.userId) === userId;
          if (!meIsP1 && !meIsP2) continue;
          if (m.bye) {
            summary.byes += 1;
            history.push({
              tournamentId: t._id, tournamentName: t.name, date: t.date, round: round.number,
              bye: true, myDeck: m.p1.deckName, outcome: 'bye',
            });
            continue;
          }
          if (!m.result) continue;
          const g = gamesOf(m, t.bestOf || 1);
          const me = meIsP1 ? m.p1 : m.p2;
          const opp = meIsP1 ? m.p2 : m.p1;
          const myGames = meIsP1 ? g.p1 : g.p2;
          const oppGames = meIsP1 ? g.p2 : g.p1;
          const outcome = m.result === 'draw' ? 'draw' : (m.result === 'p1') === meIsP1 ? 'win' : 'loss';
          summary.matches += 1;
          summary.wins += outcome === 'win' ? 1 : 0;
          summary.draws += outcome === 'draw' ? 1 : 0;
          summary.losses += outcome === 'loss' ? 1 : 0;
          summary.gameWins += myGames;
          summary.gameLosses += oppGames;
          summary.gameDraws += g.draws || 0;
          history.push({
            tournamentId: t._id, tournamentName: t.name, date: t.date, round: round.number,
            bye: false, myDeck: me.deckName, oppName: opp.username, oppId: String(opp.userId), oppDeck: opp.deckName,
            score: `${myGames}-${oppGames}${g.draws ? ' (+' + g.draws + 'N)' : ''}`,
            outcome,
          });
        }
      }
    }

    history.sort((a, b) => b.date - a.date || b.round - a.round);
    const totalGames = summary.gameWins + summary.gameDraws + summary.gameLosses;
    summary.winRate = summary.matches > 0 ? (summary.wins + summary.draws / 2) / summary.matches : 0;
    summary.gameWinRate = totalGames > 0 ? (summary.gameWins + summary.gameDraws / 2) / totalGames : 0;

    // Résultats officiels importés depuis le locator UVS.
    const externalEvents = await req.db.collection('external_events').find({ ownerId: user._id }).sort({ date: -1 }).toArray();
    const external = summarizeExternal(externalEvents);
    const isMe = req.session.user && req.session.user.id === userId;
    const myDecks = isMe ? await req.db.collection('decks').find({ ownerId: user._id }).sort({ name: 1 }).toArray() : [];
    const locatorInfo = user.locator
      ? { email: user.locator.email, connectedAt: user.locator.connectedAt, lastImportAt: user.locator.lastImportAt || null, stats: user.locator.stats || null }
      : null;

    res.render('player', {
      player: user, summary, cups, history, tournamentCount: tournaments.length,
      externalEvents, external, isMe, myDecks, locatorInfo,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
