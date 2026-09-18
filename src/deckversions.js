// Versions de deck : chaque modification des cartes d'un deck crée une nouvelle version
// (collection `deck_versions` : deckId, version, cards, diff vs précédente, createdAt).
// Les inscriptions, appariements et matchs free play mémorisent la version jouée
// (`deckVersion`) pour ventiler les stats par version. Un changement de nom ou de
// notes ne crée pas de version.
import { parseDecklist, findCard, normalizeName, SECTIONS } from './cards.js';

const SECTION_LABEL = Object.fromEntries(SECTIONS.map((s) => [s.key, s.label]));

// Lignes de la decklist à plat : clé = section + nom canonique (catalogue si reconnu).
export function flattenCards(text) {
  const map = new Map();
  for (const section of parseDecklist(text)) {
    for (const line of section.cards) {
      const card = findCard(line.name);
      const name = card ? card.name : line.name;
      const key = `${section.key}::${normalizeName(name)}`;
      const cur = map.get(key);
      if (cur) cur.qty += line.qty;
      else map.set(key, { section: section.key, sectionLabel: SECTION_LABEL[section.key] || section.key, name, qty: line.qty });
    }
  }
  return map;
}

export function sameCards(textA, textB) {
  const a = flattenCards(textA);
  const b = flattenCards(textB);
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || b.get(k).qty !== v.qty) return false;
  return true;
}

// Différence entre deux decklists : cartes ajoutées / retirées (par section, avec quantité)
// et cartes déplacées d'une section à l'autre (ex. réserve → deck principal), détectées
// quand la même carte est retirée d'une section et ajoutée dans une autre.
export function diffCards(prevText, nextText) {
  const a = flattenCards(prevText);
  const b = flattenCards(nextText);
  const added = [];
  const removed = [];
  for (const [k, v] of b) {
    const before = a.get(k)?.qty || 0;
    if (v.qty > before) added.push({ section: v.section, sectionLabel: v.sectionLabel, name: v.name, qty: v.qty - before });
  }
  for (const [k, v] of a) {
    const after = b.get(k)?.qty || 0;
    if (v.qty > after) removed.push({ section: v.section, sectionLabel: v.sectionLabel, name: v.name, qty: v.qty - after });
  }
  const moved = [];
  for (const out of removed) {
    for (const inn of added) {
      if (out.qty === 0 || inn.qty === 0 || inn.section === out.section) continue;
      if (normalizeName(inn.name) !== normalizeName(out.name)) continue;
      const qty = Math.min(out.qty, inn.qty);
      moved.push({ name: inn.name, qty, from: out.section, fromLabel: out.sectionLabel, to: inn.section, toLabel: inn.sectionLabel });
      out.qty -= qty;
      inn.qty -= qty;
    }
  }
  return { added: added.filter((c) => c.qty > 0), removed: removed.filter((c) => c.qty > 0), moved };
}

// Version courante d'un deck (les decks créés avant la fonctionnalité valent 1).
export function currentVersion(deck) {
  return deck && Number.isInteger(deck.version) && deck.version >= 1 ? deck.version : 1;
}

// Crée la version 1 d'un deck qui n'en a pas encore (migration à la volée ou au démarrage).
export async function ensureVersioned(db, deck) {
  if (Number.isInteger(deck.version)) return deck.version;
  await db.collection('deck_versions').updateOne(
    { deckId: deck._id, version: 1 },
    { $setOnInsert: { deckId: deck._id, version: 1, cards: deck.cards || '', diff: null, createdAt: deck.createdAt || new Date() } },
    { upsert: true }
  );
  await db.collection('decks').updateOne({ _id: deck._id, version: { $exists: false } }, { $set: { version: 1 } });
  deck.version = 1;
  return 1;
}

export async function migrateDecks(db) {
  const decks = await db.collection('decks').find({ version: { $exists: false } }).toArray();
  for (const d of decks) await ensureVersioned(db, d);
  if (decks.length) console.log(`Versions de deck : ${decks.length} deck(s) initialisé(s) en v1.`);
}

// Première version d'un deck fraîchement créé.
export async function createInitialVersion(db, deckId, cards) {
  await db.collection('deck_versions').insertOne({ deckId, version: 1, cards, diff: null, createdAt: new Date() });
}

// À la modification : nouvelle version si les cartes ont changé. Renvoie la version à écrire sur le deck.
export async function bumpVersionIfChanged(db, deck, newCards) {
  const from = await ensureVersioned(db, deck);
  if (sameCards(deck.cards || '', newCards)) return { version: from, changed: false };
  const version = from + 1;
  const diff = diffCards(deck.cards || '', newCards);
  await db.collection('deck_versions').insertOne({ deckId: deck._id, version, cards: newCards, diff, createdAt: new Date() });
  return { version, changed: true, diff };
}

// Version jouée par un participant (inscription / match) : absente = v1.
export function playedVersion(p) {
  return p && Number.isInteger(p.deckVersion) && p.deckVersion >= 1 ? p.deckVersion : 1;
}

// Stats d'un deck ventilées par version : tournois (matchs hors bye) et free play (matchs clôturés).
export function statsByVersion(deckId, tournaments, freeMatches, { gamesOfTournamentMatch, freePlayCountsForStats, freePlayOutcomeForSide }) {
  const id = String(deckId);
  const perVersion = new Map();
  const get = (v) => {
    if (!perVersion.has(v)) {
      perVersion.set(v, {
        version: v,
        tournois: { matches: 0, wins: 0, draws: 0, losses: 0, gameWins: 0, gameDraws: 0, gameLosses: 0, cups: 0 },
        freeplay: { matches: 0, wins: 0, draws: 0, losses: 0, gameWins: 0, gameDraws: 0, gameLosses: 0 },
      });
    }
    return perVersion.get(v);
  };
  const add = (s, outcome, won, lost, drawn) => {
    s.matches += 1;
    s[outcome === 'win' ? 'wins' : outcome === 'draw' ? 'draws' : 'losses'] += 1;
    s.gameWins += won;
    s.gameLosses += lost;
    s.gameDraws += drawn;
  };
  for (const t of tournaments) {
    for (const round of t.rounds || []) {
      for (const m of round.matches || []) {
        if (m.bye || !m.result) continue;
        for (const side of ['p1', 'p2']) {
          const p = m[side];
          if (!p || String(p.deckId) !== id) continue;
          const g = gamesOfTournamentMatch(m, t.bestOf || 1);
          const outcome = m.result === 'draw' ? 'draw' : m.result === side ? 'win' : 'loss';
          add(get(playedVersion(p)).tournois, outcome, side === 'p1' ? g.p1 : g.p2, side === 'p1' ? g.p2 : g.p1, g.draws || 0);
        }
      }
    }
    if (t.winner && String(t.winner.deckId) === id) get(playedVersion(t.winner)).tournois.cups += 1;
  }
  for (const m of freeMatches) {
    if (!freePlayCountsForStats(m)) continue;
    m.sides.forEach((side, i) => {
      for (const p of side.players) {
        if (String(p.deckId) !== id) continue;
        const o = freePlayOutcomeForSide(m, i);
        add(get(playedVersion(p)).freeplay, o.outcome, o.won, o.lost, o.drawn);
      }
    });
  }
  const rate = (s) => (s.matches > 0 ? (s.wins + s.draws / 2) / s.matches : 0);
  return Object.fromEntries([...perVersion.values()].map((v) => [v.version, { ...v, tournois: { ...v.tournois, winRate: rate(v.tournois) }, freeplay: { ...v.freeplay, winRate: rate(v.freeplay) } }]));
}
