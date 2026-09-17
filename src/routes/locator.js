import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth, flashAndRedirect } from '../middleware.js';
import * as locator from '../locator.js';
import { normalizeName } from '../cards.js';

const router = Router();

function authOf(user) {
  if (!user?.locator?.tokenEnc) return null;
  return { token: locator.decryptToken(user.locator.tokenEnc), scheme: user.locator.scheme || 'Token' };
}

/** Rapproche le deck joué (locator) d'un deck de l'outil : par légende (carte définissante) ou par nom. */
function matchDeck(extDeck, myDecks) {
  if (!extDeck) return null;
  const card = normalizeName(extDeck.definingCard?.name);
  const name = normalizeName(extDeck.name);
  const byLegend = card && myDecks.find((d) => normalizeName(d.legend).includes(card) || normalizeName(d.champion).includes(card));
  const byName = name && myDecks.find((d) => normalizeName(d.name) === name);
  const hit = byName || byLegend;
  return hit ? { deckId: hit._id, deckName: hit.name } : null;
}

// Page « Lier avec le locator » : état de la liaison + les deux méthodes de connexion.
router.get('/locator', requireAuth, async (req, res, next) => {
  try {
    const user = await req.db.collection('users').findOne({ _id: oid(req.session.user.id) });
    const eventCount = await req.db.collection('external_events').countDocuments({ ownerId: user._id });
    res.render('locator', { locatorInfo: user.locator || null, eventCount });
  } catch (err) {
    next(err);
  }
});

// Liaison par jeton collé à la main (pour les comptes « Sign in with Google » sans mot de passe).
router.post('/locator/token', requireAuth, async (req, res, next) => {
  try {
    const { token, scheme, profile } = await locator.verifyToken(req.body.token);
    await req.db.collection('users').updateOne(
      { _id: oid(req.session.user.id) },
      { $set: { locator: { email: profile?.email || profile?.username || 'compte UVS', tokenEnc: locator.encryptToken(token), scheme, connectedAt: new Date() } } }
    );
    flashAndRedirect(req, res, 'success', 'Compte locator lié. Tu peux importer tes résultats.', `/players/${req.session.user.id}`);
  } catch (err) {
    if (err instanceof locator.LocatorError) return flashAndRedirect(req, res, 'error', `Liaison refusée : ${err.message}`, '/locator');
    next(err);
  }
});

// Connexion au compte UVS : on échange email + mot de passe contre un jeton, que l'on garde chiffré.
router.post('/locator/connect', requireAuth, async (req, res, next) => {
  const back = `/players/${req.session.user.id}`;
  try {
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    if (!email || !password) return flashAndRedirect(req, res, 'error', 'Email et mot de passe UVS requis.', '/locator');
    const { token, scheme } = await locator.login(email, password);
    await req.db.collection('users').updateOne(
      { _id: oid(req.session.user.id) },
      { $set: { locator: { email, tokenEnc: locator.encryptToken(token), scheme, connectedAt: new Date() } } }
    );
    flashAndRedirect(req, res, 'success', 'Compte locator connecté. Tu peux importer tes résultats.', back);
  } catch (err) {
    if (err instanceof locator.LocatorError) return flashAndRedirect(req, res, 'error', `Connexion locator refusée : ${err.message}`, '/locator');
    next(err);
  }
});

router.post('/locator/disconnect', requireAuth, async (req, res, next) => {
  const back = `/players/${req.session.user.id}`;
  try {
    const user = await req.db.collection('users').findOne({ _id: oid(req.session.user.id) });
    const auth = authOf(user);
    if (auth) await locator.logout(auth);
    await req.db.collection('users').updateOne({ _id: user._id }, { $unset: { locator: '' } });
    flashAndRedirect(req, res, 'success', 'Compte locator déconnecté (jeton supprimé).', back);
  } catch (err) {
    next(err);
  }
});

// Import : récupère l'historique et l'enregistre dans `external_events` (upsert par événement).
router.post('/locator/import', requireAuth, async (req, res, next) => {
  const back = `/players/${req.session.user.id}`;
  try {
    const user = await req.db.collection('users').findOne({ _id: oid(req.session.user.id) });
    const auth = authOf(user);
    if (!auth) return flashAndRedirect(req, res, 'error', 'Connecte d’abord ton compte locator.', back);

    const [history, myDecks, existingEvents] = await Promise.all([
      locator.fetchTournamentHistory(auth),
      req.db.collection('decks').find({ ownerId: user._id }).toArray(),
      req.db.collection('external_events').find({ ownerId: user._id }, { projection: { eventId: 1, matchedDeck: 1, matchedDeckManual: 1 } }).toArray(),
    ]);
    const existingById = new Map(existingEvents.map((e) => [e.eventId, e]));
    let stats = null;
    try {
      stats = await locator.fetchStats(auth);
    } catch {
      stats = null;
    }

    let created = 0;
    let updated = 0;
    for (const raw of history) {
      const ev = locator.normalizeEvent(raw);
      if (!ev.eventId) continue;
      const existing = existingById.get(ev.eventId);
      const matched = existing?.matchedDeckManual ? existing.matchedDeck : matchDeck(ev.deck, myDecks);
      await req.db.collection('external_events').updateOne(
        { ownerId: user._id, eventId: ev.eventId },
        {
          $set: { ...ev, ownerId: user._id, ownerName: user.username, source: 'locator', matchedDeck: matched, importedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
      existing ? updated++ : created++;
    }
    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { 'locator.lastImportAt': new Date(), 'locator.stats': stats, 'locator.eventCount': history.length } }
    );
    flashAndRedirect(req, res, 'success', `Import terminé : ${created} nouvel(aux) événement(s), ${updated} mis à jour.`, back);
  } catch (err) {
    if (err instanceof locator.LocatorError) {
      if (err.status === 401 || err.status === 403) {
        await req.db.collection('users').updateOne({ _id: oid(req.session.user.id) }, { $unset: { locator: '' } });
        return flashAndRedirect(req, res, 'error', 'Le jeton locator a expiré : reconnecte ton compte.', back);
      }
      return flashAndRedirect(req, res, 'error', `Import locator impossible : ${err.message}`, back);
    }
    next(err);
  }
});

// Rapprochement manuel du deck joué avec un deck de l'outil.
router.post('/locator/events/:id/deck', requireAuth, async (req, res, next) => {
  const back = `/players/${req.session.user.id}`;
  try {
    const ev = await req.db.collection('external_events').findOne({ _id: oid(req.params.id), ownerId: oid(req.session.user.id) });
    if (!ev) return flashAndRedirect(req, res, 'error', 'Événement introuvable.', back);
    let matched = null;
    if (req.body.deckId) {
      const deck = await req.db.collection('decks').findOne({ _id: oid(req.body.deckId), ownerId: ev.ownerId });
      if (deck) matched = { deckId: deck._id, deckName: deck.name };
    }
    await req.db.collection('external_events').updateOne({ _id: ev._id }, { $set: { matchedDeck: matched, matchedDeckManual: true } });
    flashAndRedirect(req, res, 'success', matched ? `Deck associé : « ${matched.deckName} ».` : 'Association de deck retirée.', back);
  } catch (err) {
    next(err);
  }
});

export default router;
