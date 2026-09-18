// Free play : matchs hors tournoi, en 1v1, 1v1v1 (mêlée à trois), 1v1v1v1 (free for all) ou 2v2 (équipes).
//
// Un match est découpé en « côtés » (sides) : 2 côtés d'un joueur en 1v1, 3 côtés
// d'un joueur en 1v1v1, 4 en 1v1v1v1, 2 côtés de deux joueurs en 2v2. Chaque manche (gameResults)
// vaut l'index du côté vainqueur ou 'draw'. Le résultat du match est recalculé
// après chaque manche : le côté qui a le plus de manches gagne, égalité en tête = nul.

import { playedVersion } from './deckversions.js';

export const FORMATS = {
  '1v1': { label: '1v1', sides: 2, perSide: 1, description: 'Duel classique' },
  '1v1v1': { label: '1v1v1', sides: 3, perSide: 1, description: 'Mêlée à trois' },
  '1v1v1v1': { label: '1v1v1v1', sides: 4, perSide: 1, description: 'Free for all à quatre' },
  '2v2': { label: '2v2', sides: 2, perSide: 2, description: 'Deux équipes de deux' },
};

export function formatOf(match) {
  return FORMATS[match.format] || FORMATS['1v1'];
}

export function winsNeeded(bestOf) {
  return Math.ceil((bestOf || 1) / 2);
}

// Compte les manches gagnées par côté + les nuls.
export function gamesOf(match) {
  const n = formatOf(match).sides;
  const wins = Array(n).fill(0);
  let draws = 0;
  for (const r of match.gameResults || []) {
    if (r === 'draw') draws += 1;
    else if (Number.isInteger(r) && r >= 0 && r < n) wins[r] += 1;
  }
  return { wins, draws, played: (match.gameResults || []).length };
}

// Résultat courant : index du côté en tête, ou 'draw' s'il y a égalité en tête
// (ou aucune manche). Un match sans manche a un résultat null.
export function resultOf(match) {
  const { wins, played } = gamesOf(match);
  if (played === 0) return null;
  const max = Math.max(...wins);
  const leaders = wins.filter((w) => w === max).length;
  return leaders === 1 ? wins.indexOf(max) : 'draw';
}

// Le match est décidé quand un côté atteint le nombre de manches requis ou que
// toutes les manches du Bo sont jouées.
export function isDecided(match) {
  const bestOf = match.bestOf || 1;
  const { wins, played } = gamesOf(match);
  return played >= bestOf || wins.some((w) => w >= winsNeeded(bestOf));
}

export function sideName(side) {
  return (side.players || []).map((p) => p.username).join(' & ');
}

export function participantIds(match) {
  return (match.sides || []).flatMap((s) => (s.players || []).map((p) => String(p.userId)));
}

// Résultat du match vu d'un côté : 'win' / 'loss' / 'draw', avec le détail des manches
// (manches gagnées par ce côté, manches gagnées par les autres, nuls).
export function outcomeForSide(match, sideIndex) {
  const { wins, draws } = gamesOf(match);
  const result = match.result;
  const outcome = result === 'draw' ? 'draw' : result === sideIndex ? 'win' : 'loss';
  const won = wins[sideIndex] || 0;
  const lost = wins.reduce((sum, w, i) => (i === sideIndex ? sum : sum + w), 0);
  return { outcome, won, lost, drawn: draws };
}

// Un match compte dans les stats s'il est clôturé avec au moins une manche jouée.
export function countsForStats(match) {
  return match.status === 'terminé' && match.result !== null && match.result !== undefined;
}

// Stats free play par joueur, par deck et par duo (2v2), sur les matchs clôturés.
// `format` restreint à un format ('1v1', '1v1v1', '2v2'), sinon tous confondus.
// Un nul compte pour une demi-victoire dans le win rate, comme dans les tournois.
export function computeStats(matches, { format = null } = {}) {
  const players = new Map();
  const decks = new Map();
  const deckVersions = new Map(); // `${deckKey}::v${n}` → stats de cette version
  const duos = new Map();
  const emptyCounts = () => Object.fromEntries(Object.keys(FORMATS).map((f) => [f, 0]));
  const byFormat = emptyCounts();

  const bump = (map, key, seed, o) => {
    if (!map.has(key)) {
      map.set(key, { ...seed, matches: 0, wins: 0, draws: 0, losses: 0, gameWins: 0, gameDraws: 0, gameLosses: 0, perFormat: emptyCounts() });
    }
    const s = map.get(key);
    s.matches += 1;
    s[o.outcome === 'win' ? 'wins' : o.outcome === 'draw' ? 'draws' : 'losses'] += 1;
    s.gameWins += o.won;
    s.gameLosses += o.lost;
    s.gameDraws += o.drawn;
    if (s.perFormat[o.format] !== undefined) s.perFormat[o.format] += 1;
    return s;
  };

  for (const m of matches) {
    if (!countsForStats(m)) continue;
    if (byFormat[m.format] !== undefined) byFormat[m.format] += 1;
    if (format && m.format !== format) continue;
    m.sides.forEach((side, i) => {
      const o = { ...outcomeForSide(m, i), format: m.format };
      for (const p of side.players) {
        bump(players, String(p.userId), { userId: String(p.userId), username: p.username }, o);
        if (p.deckId || p.deckName) {
          const key = p.deckId ? String(p.deckId) : `${p.username}::${p.deckName}`;
          const seed = { deckId: p.deckId ? String(p.deckId) : null, deckName: p.deckName, ownerId: String(p.userId), ownerName: p.username };
          bump(decks, key, seed, o);
          if (p.deckId) bump(deckVersions, `${key}::v${playedVersion(p)}`, { ...seed, version: playedVersion(p) }, o);
        }
      }
      if (m.format === '2v2' && side.players.length === 2) {
        const ids = side.players.map((p) => String(p.userId)).sort();
        bump(duos, ids.join('+'), { members: side.players.map((p) => ({ userId: String(p.userId), username: p.username })) }, o);
      }
    });
  }

  const withRate = (s) => {
    const games = s.gameWins + s.gameDraws + s.gameLosses;
    return {
      ...s,
      winRate: s.matches > 0 ? (s.wins + s.draws / 2) / s.matches : 0,
      gameWinRate: games > 0 ? (s.gameWins + s.gameDraws / 2) / games : 0,
    };
  };
  const order = (a, b) => b.winRate - a.winRate || b.wins - a.wins || b.matches - a.matches;
  const versionsOf = (d) =>
    [...deckVersions.values()].filter((v) => v.deckId === d.deckId).map(withRate).sort((a, b) => b.version - a.version);
  return {
    players: [...players.values()].map(withRate).sort(order),
    decks: [...decks.values()].map(withRate).map((d) => ({ ...d, versions: d.deckId ? versionsOf(d) : [] })).sort(order),
    duos: [...duos.values()].map(withRate).sort(order),
    byFormat,
    total: Object.values(byFormat).reduce((a, b) => a + b, 0),
  };
}
