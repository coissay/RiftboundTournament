// Logique de rondes suisses : classement, tiebreakers et appariements.
// Points : victoire 3, nul 1, défaite 0. Le bye vaut une victoire (3 pts).
// Tiebreakers façon locator : OMW%, GW%, OGW% (plancher 33 %, convention TCG).

import { randomInt } from 'node:crypto';

export const WIN_POINTS = 3;
export const DRAW_POINTS = 1;

// Nombre de manches à gagner pour remporter le match (ex : 2 en Bo3).
export function winsNeeded(bestOf) {
  return Math.ceil((bestOf || 1) / 2);
}

// Score en manches d'un match ; rétro-compatible avec les anciens matchs
// enregistrés en score agrégé ou sans détail des manches.
export function gamesOf(match, bestOf) {
  if (Array.isArray(match.gameResults)) {
    const g = { p1: 0, p2: 0, draws: 0 };
    for (const r of match.gameResults) {
      if (r === 'p1') g.p1 += 1;
      else if (r === 'p2') g.p2 += 1;
      else if (r === 'draw') g.draws += 1;
    }
    return g;
  }
  if (match.games) return { draws: 0, ...match.games };
  const need = winsNeeded(bestOf);
  if (match.result === 'p1') return { p1: need, p2: 0, draws: 0 };
  if (match.result === 'p2') return { p1: 0, p2: need, draws: 0 };
  if (match.result === 'draw') return { p1: 1, p2: 1, draws: 0 };
  return { p1: 0, p2: 0, draws: 0 };
}

function emptyRecord(player) {
  return {
    userId: String(player.userId),
    username: player.username,
    deckName: player.deckName,
    deckId: player.deckId ? String(player.deckId) : null,
    deckVersion: player.deckVersion || 1,
    dropped: !!player.dropped,
    points: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    byes: 0,
    played: 0,
    gameWins: 0,
    gameDraws: 0,
    gameLosses: 0,
    opponents: [],
    omw: 0,
    gw: 0,
    ogw: 0,
  };
}

// Calcule le classement à partir des rondes jouées.
// `beforeRound` : ne compte que les rondes strictement antérieures (record « à l'entrée » de la ronde N).
export function computeStandings(tournament, { beforeRound = null } = {}) {
  const records = new Map();
  for (const p of tournament.players || []) {
    records.set(String(p.userId), emptyRecord(p));
  }

  const bestOf = tournament.bestOf || 1;
  for (const round of tournament.rounds || []) {
    if (beforeRound !== null && round.number >= beforeRound) continue;
    for (const match of round.matches || []) {
      const p1 = records.get(String(match.p1.userId));
      if (match.bye) {
        // Le bye vaut une victoire sur le score maximal (ex : 2-0 en Bo3).
        if (p1) {
          p1.points += WIN_POINTS;
          p1.wins += 1;
          p1.byes += 1;
          p1.gameWins += winsNeeded(bestOf);
        }
        continue;
      }
      const p2 = records.get(String(match.p2.userId));
      if (!match.result || !p1 || !p2) continue;
      const games = gamesOf(match, bestOf);
      p1.played += 1;
      p2.played += 1;
      p1.gameWins += games.p1;
      p1.gameLosses += games.p2;
      p1.gameDraws += games.draws || 0;
      p2.gameWins += games.p2;
      p2.gameLosses += games.p1;
      p2.gameDraws += games.draws || 0;
      p1.opponents.push(String(match.p2.userId));
      p2.opponents.push(String(match.p1.userId));
      if (match.result === 'p1') {
        p1.points += WIN_POINTS;
        p1.wins += 1;
        p2.losses += 1;
      } else if (match.result === 'p2') {
        p2.points += WIN_POINTS;
        p2.wins += 1;
        p1.losses += 1;
      } else if (match.result === 'draw') {
        p1.points += DRAW_POINTS;
        p2.points += DRAW_POINTS;
        p1.draws += 1;
        p2.draws += 1;
      }
    }
  }

  // GW% : manches gagnées / manches jouées (un nul de manche = ½).
  const matchWinRate = (rec) => {
    const total = rec.wins + rec.draws + rec.losses;
    return total > 0 ? (rec.wins + rec.draws / 2) / total : 0;
  };
  const gameWinRate = (rec) => {
    const total = rec.gameWins + rec.gameDraws + rec.gameLosses;
    return total > 0 ? (rec.gameWins + rec.gameDraws / 2) / total : 0;
  };
  for (const rec of records.values()) {
    rec.gw = gameWinRate(rec);
  }

  // OMW% / OGW% : moyenne du win-rate (matchs / manches) des adversaires,
  // plancher à 33 % (convention TCG). Les byes ne comptent pas comme adversaires.
  for (const rec of records.values()) {
    if (rec.opponents.length === 0) continue;
    let omwSum = 0;
    let ogwSum = 0;
    for (const oppId of rec.opponents) {
      const opp = records.get(oppId);
      if (!opp) continue;
      omwSum += Math.max(matchWinRate(opp), 1 / 3);
      ogwSum += Math.max(gameWinRate(opp), 1 / 3);
    }
    rec.omw = omwSum / rec.opponents.length;
    rec.ogw = ogwSum / rec.opponents.length;
  }

  const standings = [...records.values()].sort(
    (a, b) =>
      b.points - a.points || b.omw - a.omw || b.gw - a.gw || b.ogw - a.ogw || a.username.localeCompare(b.username)
  );
  standings.forEach((rec, i) => (rec.rank = i + 1));
  return standings;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Appariement suisse : tri par points (aléatoire au sein d'un même score),
// évite les rematchs via backtracking, bye au dernier du classement
// n'ayant pas encore eu de bye.
export function pairRound(tournament) {
  const standings = computeStandings(tournament);
  const active = standings.filter((r) => !r.dropped);

  const playedPairs = new Set();
  for (const round of tournament.rounds || []) {
    for (const match of round.matches || []) {
      if (!match.bye) {
        playedPairs.add(pairKey(match.p1.userId, match.p2.userId));
      }
    }
  }

  // Groupes par points, mélangés, puis aplatis (haut du classement d'abord).
  const groups = new Map();
  for (const rec of active) {
    if (!groups.has(rec.points)) groups.set(rec.points, []);
    groups.get(rec.points).push(rec);
  }
  const sortedPoints = [...groups.keys()].sort((a, b) => b - a);
  let pool = sortedPoints.flatMap((pts) => shuffle(groups.get(pts)));

  let byePlayer = null;
  if (pool.length % 2 === 1) {
    // Bye au joueur le plus bas sans bye précédent (sinon le dernier).
    byePlayer = [...pool].reverse().find((r) => r.byes === 0) || pool[pool.length - 1];
    pool = pool.filter((r) => r !== byePlayer);
  }

  const matches = tryPair(pool, playedPairs) || tryPair(pool, new Set()); // dernier recours : rematch autorisé
  if (!matches) return null;

  const result = matches.map(([a, b], i) => ({
    table: i + 1,
    bye: false,
    p1: { userId: a.userId, username: a.username, deckId: a.deckId, deckName: a.deckName, deckVersion: a.deckVersion || 1 },
    p2: { userId: b.userId, username: b.username, deckId: b.deckId, deckName: b.deckName, deckVersion: b.deckVersion || 1 },
    result: null,
    firstPlayer: drawFirstPlayer(), // côté qui commence la manche 1 (tirage au sort)
  }));
  if (byePlayer) {
    result.push({
      table: result.length + 1,
      bye: true,
      p1: { userId: byePlayer.userId, username: byePlayer.username, deckId: byePlayer.deckId, deckName: byePlayer.deckName, deckVersion: byePlayer.deckVersion || 1 },
      p2: null,
      result: 'p1',
      firstPlayer: null,
    });
  }
  return result;
}

// Tirage au sort (50/50) du joueur qui commence la manche 1. Les manches suivantes
// d'un Bo3 / Bo5 suivent la règle habituelle, on ne les modélise pas.
export function drawFirstPlayer() {
  return randomInt(2) === 0 ? 'p1' : 'p2';
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

function tryPair(pool, playedPairs) {
  if (pool.length === 0) return [];
  const [first, ...rest] = pool;
  for (let i = 0; i < rest.length; i++) {
    const opponent = rest[i];
    if (playedPairs.has(pairKey(first.userId, opponent.userId))) continue;
    const remaining = rest.filter((_, j) => j !== i);
    const sub = tryPair(remaining, playedPairs);
    if (sub) return [[first, opponent], ...sub];
  }
  return null;
}

// Nombre de rondes conseillé : borné par la durée du tournoi et le nombre de joueurs.
export function suggestedRounds(playerCount, durationMinutes, roundLength) {
  const bySchedule = Math.max(1, Math.floor(durationMinutes / roundLength));
  const byPlayers = playerCount > 1 ? Math.ceil(Math.log2(playerCount)) : 1;
  return Math.min(bySchedule, Math.max(byPlayers, 1));
}
