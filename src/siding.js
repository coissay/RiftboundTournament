// Side deck (cartes échangées avec la réserve, manche par manche), partagé par les
// matchs de tournoi et le free play. Stockage commun : siding[userId].games[n] =
// { out, in, note, updatedAt }, chaque side exprimé par rapport au deck inscrit.
//
// routes/tournaments.js et routes/freeplay.js partagent ces helpers (deckLinesFor,
// sidedDeckFor, sideSummary).
import { oid } from './db.js';
import { playedVersion, ensureVersioned } from './deckversions.js';
import { resolveDecklist, parseDecklist, applySiding, findCard } from './cards.js';

/** Nom catalogue nu d'une ligne de side (« Fiora, Peerless (SFD-110a) » → « Fiora, Peerless »), sinon le nom écrit. */
export function bareName(name) {
  return findCard(name)?.name || name;
}

export function normalizeSiding(raw) {
  if (!raw) return { games: {} };
  if (raw.games) return raw;
  if (Array.isArray(raw.out) || Array.isArray(raw.in)) return { games: { 2: raw } }; // ancien format (un side par match)
  return { games: {} };
}

// Manches où le side deck est autorisé pour `count` manches possibles : [1] s'il n'y en a
// qu'une, sinon [2..count] (la manche 1 se joue avec le deck inscrit).
export function sidingGamesFor(count) {
  return count < 2 ? [1] : Array.from({ length: count - 1 }, (_, i) => i + 2);
}

// Deck principal + réserve du joueur, dans la version jouée (pour le formulaire de side deck).
export async function deckLinesFor(db, player) {
  const deckId = oid(player.deckId);
  if (!deckId) return null;
  let version = await db.collection('deck_versions').findOne({ deckId, version: playedVersion(player) });
  if (!version) {
    const deck = await db.collection('decks').findOne({ _id: deckId });
    if (!deck) return null;
    await ensureVersioned(db, deck);
    version = { cards: deck.cards };
  }
  const resolved = resolveDecklist(version.cards || '');
  // Une ligne par carte (nom catalogue nu) : plusieurs impressions de la même carte (« 2 Akali, Deadly Weapon
  // (VEN-021a) » + « 1 Akali, Deadly Weapon ») sont fusionnées (quantités additionnées, image de la première),
  // sinon le formulaire de side afficherait deux lignes indistinguables et les quantités saisies se percuteraient.
  const lines = (key) => {
    const out = [];
    for (const l of resolved.sections.find((s) => s.key === key)?.cards || []) {
      const name = l.card ? l.card.name : l.name;
      const hit = out.find((o) => o.name === name);
      if (hit) hit.qty += l.qty;
      else out.push({ name, qty: l.qty, image: l.card?.image || null });
    }
    return out;
  };
  return { main: lines('main'), sideboard: lines('sideboard'), text: version.cards || '' };
}

const countOf = (resolved, key) => resolved.sections.find((s) => s.key === key)?.count || 0;

// Deck d'un joueur tel qu'il est après son side : cartes entrées dans le principal,
// sorties en réserve, avec les changements marqués pour la vue deck.
export async function sidedDeckFor(db, player, sd) {
  const lines = await deckLinesFor(db, player);
  if (!lines) return null;
  const resolved = resolveDecklist(applySiding(lines.text, sd));
  // Clés = nom catalogue nu (deck-view compare sur card.name / baseName) : un side saisi en mode texte avec un
  // code (« 2 Fiora, Peerless (SFD-110a) ») garde son badge IN / OUT.
  const highlight = {};
  for (const c of sd.in || []) highlight[bareName(c.name).toLowerCase()] = 'in';
  for (const c of sd.out || []) highlight[bareName(c.name).toLowerCase()] = 'out';
  return { resolved, highlight, mainCount: countOf(resolved, 'main'), sideCount: countOf(resolved, 'sideboard') };
}

// Deck inscrit (de base) résolu, pour le récapitulatif après clôture.
export async function baseDeckFor(db, player) {
  const lines = await deckLinesFor(db, player);
  if (!lines) return null;
  const resolved = resolveDecklist(lines.text);
  return { resolved, mainCount: countOf(resolved, 'main'), sideCount: countOf(resolved, 'sideboard') };
}

// Lignes « qty nom » saisies à la main (deck introuvable) : réutilise le parseur de decklist.
export function parseFreeLines(text) {
  return parseDecklist(String(text || '').slice(0, 5000))
    .flatMap((s) => s.cards)
    .map((c) => ({ name: c.name.slice(0, 120), qty: Math.min(c.qty, 40) }));
}

// Quantités `${prefix}_${i}` du formulaire, indexées sur les lignes `ref` du deck joué et
// bornées par la quantité de chaque ligne.
export function pickSidingQty(body, prefix, ref) {
  return (ref || [])
    .map((c, i) => ({ name: c.name, qty: Math.max(0, Math.min(c.qty, parseInt(body[`${prefix}_${i}`], 10) || 0)) }))
    .filter((c) => c.qty > 0);
}

// Lit le side d'une manche depuis le corps de requête (mode 'text' ou quantités).
// Renvoie { out, in, note }.
export async function sidingFromBody(db, player, body) {
  let out = [];
  let inn = [];
  if (body.mode === 'text') {
    out = parseFreeLines(body.outText);
    inn = parseFreeLines(body.inText);
  } else {
    const lines = await deckLinesFor(db, player);
    out = pickSidingQty(body, 'out', lines?.main);
    inn = pickSidingQty(body, 'in', lines?.sideboard);
  }
  return { out, in: inn, note: String(body.note || '').trim().slice(0, 300) };
}

export function isEmptySiding(sd) {
  return !sd || (sd.out.length === 0 && sd.in.length === 0 && !sd.note);
}

// Résumé texte d'un side : « −2 Carte A, +2 Carte B » ou « aucun échange » (noms catalogue nus, sans code).
export function sideSummary(sd) {
  return [...(sd.out || []).map((c) => `−${c.qty} ${bareName(c.name)}`), ...(sd.in || []).map((c) => `+${c.qty} ${bareName(c.name)}`)].join(', ') || 'aucun échange';
}
