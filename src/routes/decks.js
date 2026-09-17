import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth, flashAndRedirect } from '../middleware.js';
import { resolveDecklist, thumb, catalogStatus } from '../cards.js';

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
    await req.db.collection('decks').insertOne({
      ...deck,
      ownerId: oid(req.session.user.id),
      ownerName: req.session.user.username,
      createdAt: new Date(),
    });
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
    res.render('deck', { deck, isOwner, resolved: resolveDecklist(deck.cards), thumb });
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
    await req.db
      .collection('decks')
      .updateOne({ _id: oid(req.params.id), ownerId: oid(req.session.user.id) }, { $set: deck });
    flashAndRedirect(req, res, 'success', 'Deck mis à jour.', '/decks');
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
