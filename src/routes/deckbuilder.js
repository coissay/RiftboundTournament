import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth } from '../middleware.js';
import { catalogForClient, catalogMeta, resolveDecklist, normalizeName } from '../cards.js';

const router = Router();

/**
 * Résout une decklist texte et rattache chaque ligne à l'id de la carte telle que le client la connaît
 * (le catalogue client ne garde qu'une impression par nom : on passe donc par le nom).
 */
function linesForClient(text) {
  const idByName = new Map(catalogForClient().filter((c) => c.primary).map((c) => [normalizeName(c.name), c.id]));
  const resolved = resolveDecklist(text);
  return {
    unknown: resolved.unknown,
    ambiguous: resolved.ambiguous,
    sections: resolved.sections.map((s) => ({
      key: s.key,
      cards: s.cards.map((line) => ({
        qty: line.qty,
        name: line.card ? line.card.name : line.name,
        cardId: line.card ? idByName.get(normalizeName(line.card.name)) || null : null,
        // Nom écrit sans sous-titre (« Fiora ») rattaché par repli : `candidates` = noms complets possibles.
        ...(line.ambiguous ? { ambiguous: true, written: line.name, candidates: line.candidates } : {}),
      })),
    })),
  };
}

// Page du deckbuilder. `?deck=<id>` charge un deck existant de l'utilisateur dans le builder.
router.get('/deckbuilder', requireAuth, async (req, res, next) => {
  try {
    let init = null;
    if (req.query.deck) {
      const deck = await req.db
        .collection('decks')
        .findOne({ _id: oid(req.query.deck), ownerId: oid(req.session.user.id) });
      if (!deck) return res.status(404).render('error', { message: 'Deck introuvable' });
      init = {
        id: String(deck._id),
        name: deck.name,
        notes: deck.notes || '',
        // Domaines forcés à la main dans le formulaire classique : on les conserve à la mise à jour.
        domains: deck.domainsManual ? deck.domains || [] : [],
        ...linesForClient(deck.cards),
      };
    }
    res.render('deckbuilder', { init, meta: catalogMeta() });
  } catch (err) {
    next(err);
  }
});

// Catalogue allégé (une impression par nom) + référentiels (icônes) pour le filtrage côté client.
router.get('/api/cards', requireAuth, (req, res) => {
  // Revalidation à chaque chargement (ETag → 304 si inchangé) : pas de catalogue périmé côté navigateur.
  res.set('Cache-Control', 'private, no-cache');
  res.json({ meta: catalogMeta(), cards: catalogForClient() });
});

// Import d'une decklist collée dans le builder : renvoie les lignes avec l'id de carte trouvé.
router.post('/api/decklist/resolve', requireAuth, (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 20000) : '';
  res.json(linesForClient(text));
});

export default router;
