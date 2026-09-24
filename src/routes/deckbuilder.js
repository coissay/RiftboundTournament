import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth } from '../middleware.js';
import { catalogForClient, catalogMeta, resolveDecklist, normalizeName } from '../cards.js';

const router = Router();

/**
 * Résout une decklist texte et rattache chaque ligne à l'id de la carte telle que le client la connaît.
 * Une ligne avec code de collection (« 3 Fiora, Peerless (SFD-110a) ») est résolue vers cette impression
 * précise : c'est son id qui est renvoyé, pour que le builder réaffiche l'art choisi. Sans code, l'impression
 * de base ; si l'impression résolue n'existe pas côté client (sans image), repli sur la principale du nom.
 */
function linesForClient(text) {
  const client = catalogForClient();
  const clientIds = new Set(client.map((c) => c.id));
  const idByName = new Map(client.filter((c) => c.primary).map((c) => [normalizeName(c.name), c.id]));
  const cardIdFor = (card) => (clientIds.has(card.id) ? card.id : idByName.get(normalizeName(card.name)) || null);
  const resolved = resolveDecklist(text);
  return {
    unknown: resolved.unknown,
    ambiguous: resolved.ambiguous,
    sections: resolved.sections.map((s) => ({
      key: s.key,
      cards: s.cards.map((line) => ({
        qty: line.qty,
        name: line.card ? line.card.name : line.name,
        cardId: line.card ? cardIdFor(line.card) : null,
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

// Catalogue allégé (toutes les impressions avec image, une principale par nom) + référentiels (icônes) pour le client.
router.get('/api/cards', requireAuth, (req, res) => {
  // Revalidation à chaque chargement (ETag → 304 si inchangé) : pas de catalogue périmé côté navigateur.
  res.set('Cache-Control', 'private, no-cache');
  res.json({ meta: catalogMeta(), cards: catalogForClient() });
});

// Import d'une decklist collée dans le builder : renvoie les lignes avec l'id de carte trouvé.
router.post('/api/decklist/resolve', requireAuth, (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 20000) : '';
  if (!text.trim()) return res.status(400).json({ error: 'Liste vide ou illisible.' });
  res.json(linesForClient(text));
});

export default router;
