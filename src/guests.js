// Joueurs invités : ajoutés à un tournoi par l'organisateur sans compte, identifiés
// par un e-mail. Ils existent dans `users` avec `guest: true` et sans mot de passe,
// donc tout le reste (appariements, classement, stats, page joueur) fonctionne à
// l'identique. À l'inscription via le lien d'invitation, le compte est « réclamé » :
// même _id, donc l'historique est conservé.
import crypto from 'node:crypto';
import { oid } from './db.js';

export function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

export function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function newInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Trouve l'utilisateur (inscrit ou invité) portant cet e-mail, sinon crée un invité.
// Renvoie { user, created, error }.
export async function findOrCreateGuest(db, { username, email }) {
  const users = db.collection('users');
  const existing = await users.findOne({ email });
  if (existing) return { user: existing, created: false };
  const nameTaken = await users.findOne({ username });
  if (nameTaken) return { error: `Le pseudo « ${username} » est déjà pris — choisis-en un autre pour cet invité.` };
  const doc = {
    username,
    email,
    guest: true,
    invite: { token: newInviteToken(), createdAt: new Date(), sentAt: null },
    createdAt: new Date(),
  };
  const { insertedId } = await users.insertOne(doc);
  return { user: { ...doc, _id: insertedId }, created: true };
}

// Renomme un joueur partout où son pseudo est copié (tournois, matchs, free play).
export async function renameEverywhere(db, userId, username) {
  const tournaments = await db.collection('tournaments').find({ 'players.userId': userId }).toArray();
  for (const t of tournaments) {
    const id = String(userId);
    for (const p of t.players || []) if (String(p.userId) === id) p.username = username;
    for (const r of t.rounds || []) for (const m of r.matches || []) for (const side of ['p1', 'p2']) if (m[side] && String(m[side].userId) === id) m[side].username = username;
    if (t.winner && String(t.winner.userId) === id) t.winner.username = username;
    await db.collection('tournaments').updateOne({ _id: t._id }, { $set: { players: t.players, rounds: t.rounds, winner: t.winner } });
  }
  const matches = await db.collection('free_matches').find({ 'sides.players.userId': userId }).toArray();
  for (const m of matches) {
    for (const s of m.sides) for (const p of s.players) if (String(p.userId) === String(userId)) p.username = username;
    await db.collection('free_matches').updateOne({ _id: m._id }, { $set: { sides: m.sides } });
  }
  await db.collection('decks').updateMany({ ownerId: userId }, { $set: { ownerName: username } });
}

// Réclame un compte invité : pose le mot de passe (et le pseudo choisi), retire le jeton.
export async function claimGuest(db, guest, { username, passwordHash }) {
  await db.collection('users').updateOne(
    { _id: guest._id, guest: true },
    { $set: { username, passwordHash, guest: false, claimedAt: new Date() }, $unset: { invite: '' } }
  );
  if (username !== guest.username) await renameEverywhere(db, guest._id, username);
}

// Version d'un deck en vigueur à une date : la dernière créée avant, sinon la première.
export async function versionAtDate(db, deckId, date) {
  const versions = await db.collection('deck_versions').find({ deckId }).sort({ version: 1 }).toArray();
  if (versions.length === 0) return 1;
  const before = versions.filter((v) => v.createdAt <= date);
  return (before.length ? before[before.length - 1] : versions[0]).version;
}

// Renseigne a posteriori le deck joué par un joueur sur un tournoi : inscription,
// appariements (matchs, byes) et coupe éventuelle sont mis à jour.
export async function setPlayedDeck(db, tournament, userId, deck, deckVersion) {
  const id = String(userId);
  const patch = { deckId: deck._id, deckName: deck.name, deckVersion };
  for (const p of tournament.players || []) if (String(p.userId) === id) Object.assign(p, patch);
  for (const r of tournament.rounds || []) for (const m of r.matches || []) for (const side of ['p1', 'p2']) if (m[side] && String(m[side].userId) === id) Object.assign(m[side], patch);
  if (tournament.winner && String(tournament.winner.userId) === id) Object.assign(tournament.winner, patch);
  await db.collection('tournaments').updateOne(
    { _id: tournament._id },
    { $set: { players: tournament.players, rounds: tournament.rounds, winner: tournament.winner } }
  );
}

// Tournois où le joueur est inscrit sans deck renseigné.
export async function tournamentsMissingDeck(db, userId) {
  const uid = oid(userId);
  return db
    .collection('tournaments')
    .find({ players: { $elemMatch: { userId: uid, deckId: null } } }, { projection: { name: 1, date: 1, status: 1 } })
    .sort({ date: -1 })
    .toArray();
}
