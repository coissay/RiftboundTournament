import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth, flashAndRedirect } from '../middleware.js';
import { resolveDecklist, thumb, catalogStatus } from '../cards.js';
import { gamesOf } from '../swiss.js';
import { countsForStats, outcomeForSide } from '../freeplay.js';
import { createInitialVersion, bumpVersionIfChanged, ensureVersioned, currentVersion, statsByVersion } from '../deckversions.js';

const router = Router();

export const DOMAINS = ['Fury', 'Calm', 'Mind', 'Body', 'Chaos', 'Order'];

/**
 * Le deck est saisi comme un seul bloc texte (export Riftbound : Legend / Champion / MainDeck /
 * Battlefields / Runes / Sideboard). Légende, champion, domaines et champs de bataille en sont déduits
 * via le catalogue de cartes ; les domaines peuvent être forcés à la main.
 */
function parseDeckForm(body) {
  const cards = (body.cards || '').replace(/\r\n/g, '\n').trim();
  const resolved = resolveDecklist(cards);
  const manual = DOMAINS.filter((d) => (Array.isArray(body.domains) ? body.domains.includes(d) : body.domains === d));
  return {
    name: (body.name || '').trim(),
    cards,
    notes: (body.notes || '').trim(),
    legend: resolved.legend,
    champion: resolved.champion,
    battlefields: resolved.battlefields.join(', '),
    domains: manual.length ? manual : resolved.domains,
    domainsManual: manual.length > 0,
    cardCount: resolved.total,
  };
}

router.get('/decks', requireAuth, async (req, res, next) => {
  try {
    const decks = await req.db
      .collection('decks')
      .find({ ownerId: oid(req.session.user.id) })
      .sort({ createdAt: -1 })
      .toArray();
    for (const d of decks) d.resolved = resolveDecklist(d.cards);
    res.render('decks', { decks, thumb });
  } catch (err) {
    next(err);
  }
});

// `?cards=<decklist>&name=<nom>` : préremplissage depuis le deckbuilder (« Enregistrer comme deck »).
router.get('/decks/new', requireAuth, (req, res) => {
  const prefill = {
    name: typeof req.query.name === 'string' ? req.query.name.slice(0, 80) : '',
    cards: typeof req.query.cards === 'string' ? req.query.cards.slice(0, 20000) : '',
    notes: '',
  };
  res.render('deck-form', { deck: null, prefill, domains: DOMAINS, resolved: resolveDecklist(prefill.cards), thumb });
});

router.post('/decks/new', requireAuth, async (req, res, next) => {
  try {
    const deck = parseDeckForm(req.body);
    if (!deck.name) return flashAndRedirect(req, res, 'error', 'Le nom du deck est requis.', '/decks/new');
    const { insertedId } = await req.db.collection('decks').insertOne({
      ...deck,
      version: 1,
      ownerId: oid(req.session.user.id),
      ownerName: req.session.user.username,
      createdAt: new Date(),
    });
    await createInitialVersion(req.db, insertedId, deck.cards);
    flashAndRedirect(req, res, 'success', `Deck « ${deck.name} » créé.`, '/decks');
  } catch (err) {
    next(err);
  }
});

// Aperçu live pour le formulaire : renvoie le partial HTML du deck résolu.
router.post('/api/decklist/preview', requireAuth, (req, res, next) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 20000) : '';
  res.render('partials/deck-view', { resolved: resolveDecklist(text), thumb }, (err, html) => {
    if (err) return next(err);
    res.type('html').send(html);
  });
});

router.get('/api/cards/status', requireAuth, (req, res) => res.json(catalogStatus()));

router.get('/decks/:id', requireAuth, async (req, res, next) => {
  try {
    const deck = await req.db.collection('decks').findOne({ _id: oid(req.params.id) });
    if (!deck) return res.status(404).render('error', { message: 'Deck introuvable' });
    const isOwner = String(deck.ownerId) === String(req.session.user.id);
    await ensureVersioned(req.db, deck);
    const [versions, tournaments, freeMatches] = await Promise.all([
      req.db.collection('deck_versions').find({ deckId: deck._id }).sort({ version: -1 }).toArray(),
      req.db.collection('tournaments').find({ 'players.deckId': deck._id }).toArray(),
      req.db.collection('free_matches').find({ 'sides.players.deckId': deck._id }).toArray(),
    ]);
    const versionStats = statsByVersion(deck._id, tournaments, freeMatches, {
      gamesOfTournamentMatch: gamesOf,
      freePlayCountsForStats: countsForStats,
      freePlayOutcomeForSide: outcomeForSide,
    });
    res.render('deck', { deck, isOwner, resolved: resolveDecklist(deck.cards), thumb, versions, versionStats, currentVersion: currentVersion(deck) });
  } catch (err) {
    next(err);
  }
});

// Cartes d'une version passée du deck, telles qu'elles étaient à l'époque.
router.get('/decks/:id/versions/:version', requireAuth, async (req, res, next) => {
  try {
    const deck = await req.db.collection('decks').findOne({ _id: oid(req.params.id) });
    if (!deck) return res.status(404).render('error', { message: 'Deck introuvable' });
    await ensureVersioned(req.db, deck);
    const version = await req.db.collection('deck_versions').findOne({ deckId: deck._id, version: parseInt(req.params.version, 10) });
    if (!version) return res.status(404).render('error', { message: 'Version introuvable' });
    res.render('deck-version', { deck, version, resolved: resolveDecklist(version.cards), thumb, isCurrent: version.version === currentVersion(deck) });
  } catch (err) {
    next(err);
  }
});

router.get('/decks/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const deck = await req.db.collection('decks').findOne({ _id: oid(req.params.id), ownerId: oid(req.session.user.id) });
    if (!deck) return res.status(404).render('error', { message: 'Deck introuvable' });
    res.render('deck-form', { deck, domains: DOMAINS, resolved: resolveDecklist(deck.cards), thumb });
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const deck = parseDeckForm(req.body);
    if (!deck.name) return flashAndRedirect(req, res, 'error', 'Le nom du deck est requis.', `/decks/${req.params.id}/edit`);
    const existing = await req.db.collection('decks').findOne({ _id: oid(req.params.id), ownerId: oid(req.session.user.id) });
    if (!existing) return res.status(404).render('error', { message: 'Deck introuvable' });
    // Les cartes ont changé → nouvelle version (l'ancienne reste consultable, avec ses stats).
    const { version, changed, diff } = await bumpVersionIfChanged(req.db, existing, deck.cards);
    await req.db.collection('decks').updateOne({ _id: existing._id }, { $set: { ...deck, version } });
    const count = (list) => list.reduce((n, c) => n + c.qty, 0);
    const summary = changed
      ? ` Nouvelle version v${version} : +${count(diff.added)} / −${count(diff.removed)}${diff.moved.length ? ` / ⇄ ${count(diff.moved)} déplacée(s) main ↔ réserve` : ''}.`
      : '';
    flashAndRedirect(req, res, 'success', 'Deck mis à jour.' + summary, `/decks/${existing._id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/delete', requireAuth, async (req, res, next) => {
  try {
    await req.db.collection('decks').deleteOne({ _id: oid(req.params.id), ownerId: oid(req.session.user.id) });
    flashAndRedirect(req, res, 'success', 'Deck supprimé. (Ses stats passées sont conservées.)', '/decks');
  } catch (err) {
    next(err);
  }
});

export default router;
