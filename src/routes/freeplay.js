import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth, flashAndRedirect, isAdmin } from '../middleware.js';
import { FORMATS, formatOf, gamesOf, resultOf, isDecided, sideName, participantIds, computeStats } from '../freeplay.js';
import { currentVersion } from '../deckversions.js';

const router = Router();
const COLL = 'free_matches';

function parseFormat(value) {
  return FORMATS[value] ? value : null;
}

async function loadMatch(req, res) {
  const match = await req.db.collection(COLL).findOne({ _id: oid(req.params.id) });
  if (!match) {
    res.status(404).render('error', { message: 'Match introuvable' });
    return null;
  }
  return match;
}

// Le créateur du match ou un admin en a la main (suppression, réouverture).
function isOwner(match, user) {
  return !!user && (String(match.creatorId) === user.id || isAdmin(user));
}

// Saisie des manches : les participants, le créateur ou un admin, tant que le match est en cours.
function canReport(match, user) {
  if (!user || match.status !== 'en_cours') return false;
  return isOwner(match, user) || participantIds(match).includes(user.id);
}

// ---- Liste ----
router.get('/free-play', async (req, res, next) => {
  try {
    const format = parseFormat(req.query.format);
    const [matches, counts] = await Promise.all([
      req.db.collection(COLL).find(format ? { format } : {}).sort({ date: -1 }).limit(200).toArray(),
      req.db.collection(COLL).aggregate([{ $group: { _id: '$format', n: { $sum: 1 } } }]).toArray(),
    ]);
    const byFormat = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    res.render('freeplay/index', { matches, format, byFormat, FORMATS, gamesOf, sideName });
  } catch (err) {
    next(err);
  }
});

// ---- Création ----
async function renderForm(req, res, values = {}) {
  const [users, decks] = await Promise.all([
    req.db.collection('users').find({}, { projection: { username: 1 } }).sort({ username: 1 }).toArray(),
    req.db.collection('decks').find({}, { projection: { name: 1, ownerId: 1, legend: 1 } }).sort({ name: 1 }).toArray(),
  ]);
  const decksByOwner = {};
  for (const d of decks) {
    (decksByOwner[String(d.ownerId)] ||= []).push({ id: String(d._id), name: d.name, legend: d.legend || null });
  }
  res.render('freeplay/new', {
    users: users.map((u) => ({ id: String(u._id), username: u.username })),
    decksByOwner,
    FORMATS,
    values: { format: '1v1', bestOf: 3, ...values },
  });
}

router.get('/free-play/new', requireAuth, (req, res, next) => renderForm(req, res).catch(next));

router.post('/free-play/new', requireAuth, async (req, res, next) => {
  try {
    const format = parseFormat(req.body.format);
    if (!format) return flashAndRedirect(req, res, 'error', 'Format de match invalide.', '/free-play/new');
    const spec = FORMATS[format];
    const bestOf = [1, 3, 5].includes(parseInt(req.body.bestOf, 10)) ? parseInt(req.body.bestOf, 10) : 1;

    // Lecture des slots : side{i}_player{j} / side{i}_deck{j}.
    const wanted = [];
    for (let i = 0; i < spec.sides; i++) {
      for (let j = 0; j < spec.perSide; j++) {
        wanted.push({ side: i, userId: oid(req.body[`side${i}_player${j}`]), deckId: oid(req.body[`side${i}_deck${j}`]) });
      }
    }
    if (wanted.some((w) => !w.userId)) {
      return flashAndRedirect(req, res, 'error', 'Choisis un joueur pour chaque place.', '/free-play/new');
    }
    const ids = wanted.map((w) => String(w.userId));
    if (new Set(ids).size !== ids.length) {
      return flashAndRedirect(req, res, 'error', 'Un même joueur ne peut pas occuper deux places.', '/free-play/new');
    }
    const [users, decks] = await Promise.all([
      req.db.collection('users').find({ _id: { $in: wanted.map((w) => w.userId) } }).toArray(),
      req.db.collection('decks').find({ _id: { $in: wanted.map((w) => w.deckId).filter(Boolean) } }).toArray(),
    ]);
    if (users.length !== wanted.length) {
      return flashAndRedirect(req, res, 'error', 'Un des joueurs choisis n’existe pas.', '/free-play/new');
    }
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const deckById = new Map(decks.map((d) => [String(d._id), d]));
    const sides = Array.from({ length: spec.sides }, () => ({ players: [] }));
    for (const w of wanted) {
      const user = userById.get(String(w.userId));
      // Le deck doit appartenir au joueur de la place ; sinon on l'ignore (place « sans deck »).
      const deck = w.deckId ? deckById.get(String(w.deckId)) : null;
      const ownDeck = deck && String(deck.ownerId) === String(user._id) ? deck : null;
      sides[w.side].players.push({
        userId: user._id,
        username: user.username,
        deckId: ownDeck ? ownDeck._id : null,
        deckName: ownDeck ? ownDeck.name : null,
        deckVersion: ownDeck ? currentVersion(ownDeck) : null,
      });
    }

    const { insertedId } = await req.db.collection(COLL).insertOne({
      format,
      bestOf,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      notes: (req.body.notes || '').trim().slice(0, 500),
      status: 'en_cours', // en_cours → terminé
      creatorId: oid(req.session.user.id),
      creatorName: req.session.user.username,
      sides,
      gameResults: [],
      result: null,
      createdAt: new Date(),
    });
    flashAndRedirect(req, res, 'success', `Match ${spec.label} créé, à vous de jouer !`, `/free-play/${insertedId}`);
  } catch (err) {
    next(err);
  }
});

// ---- Stats free play (section à part des stats tournois) ----
router.get('/free-play/stats', async (req, res, next) => {
  try {
    const format = parseFormat(req.query.format);
    const matches = await req.db.collection(COLL).find({ status: 'terminé' }).toArray();
    const stats = computeStats(matches, { format });
    res.render('freeplay/stats', { stats, format, FORMATS });
  } catch (err) {
    next(err);
  }
});

// ---- Page match ----
router.get('/free-play/:id', async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    // Bilan free play de chaque participant dans ce format, façon record V-N-D des pairings.
    const ids = participantIds(match).map((id) => oid(id));
    const others = await req.db.collection(COLL).find({ status: 'terminé', format: match.format, 'sides.players.userId': { $in: ids } }).toArray();
    const { players } = computeStats(others, { format: match.format });
    const recordOf = Object.fromEntries(players.map((p) => [p.userId, `${p.wins}-${p.draws}-${p.losses}`]));
    res.render('freeplay/match', {
      match,
      spec: formatOf(match),
      games: gamesOf(match),
      decided: isDecided(match),
      recordOf,
      canReport: canReport(match, req.session.user),
      owner: isOwner(match, req.session.user),
      sideName,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Enregistrer UNE manche ----
router.post('/free-play/:id/games', requireAuth, async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    const url = `/free-play/${match._id}`;
    if (!canReport(match, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Le match est clôturé, ou tu n’es ni participant ni créateur du match.', url);
    }
    const raw = req.body.gameResult;
    const value = raw === 'draw' ? 'draw' : parseInt(raw, 10);
    const n = formatOf(match).sides;
    if (value !== 'draw' && !(Number.isInteger(value) && value >= 0 && value < n)) {
      return flashAndRedirect(req, res, 'error', 'Résultat de manche invalide.', url);
    }
    if (isDecided(match)) {
      return flashAndRedirect(req, res, 'error', 'Le match est déjà décidé — réinitialise la saisie pour corriger.', url);
    }
    const previous = match.gameResults || [];
    const next_ = { ...match, gameResults: [...previous, value] };
    const decided = isDecided(next_);
    // Compare-and-swap sur les manches déjà en base : deux participants peuvent cliquer en même temps.
    const { matchedCount } = await req.db.collection(COLL).updateOne(
      { _id: match._id, gameResults: previous },
      {
        $set: {
          gameResults: next_.gameResults,
          result: resultOf(next_),
          ...(decided ? { status: 'terminé', finishedAt: new Date() } : {}),
        },
      }
    );
    if (matchedCount === 0) {
      return flashAndRedirect(req, res, 'error', 'Une manche vient d’être enregistrée par quelqu’un d’autre — vérifie le score avant de recliquer.', url);
    }
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// ---- Réinitialiser la saisie ----
router.post('/free-play/:id/reset', requireAuth, async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    const url = `/free-play/${match._id}`;
    if (!canReport(match, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Le match est clôturé, ou tu n’es ni participant ni créateur du match.', url);
    }
    await req.db.collection(COLL).updateOne({ _id: match._id }, { $set: { gameResults: [], result: null } });
    flashAndRedirect(req, res, 'success', 'Saisie réinitialisée, c’est reparti de zéro.', url);
  } catch (err) {
    next(err);
  }
});

// ---- Clôturer au score en l'état (temps écoulé, abandon…) ----
router.post('/free-play/:id/finish', requireAuth, async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    const url = `/free-play/${match._id}`;
    if (!canReport(match, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Le match est déjà clôturé, ou tu n’es ni participant ni créateur du match.', url);
    }
    if ((match.gameResults || []).length === 0) {
      return flashAndRedirect(req, res, 'error', 'Saisis au moins une manche avant de clôturer (ou supprime le match).', url);
    }
    await req.db.collection(COLL).updateOne(
      { _id: match._id, status: 'en_cours' },
      { $set: { status: 'terminé', finishedAt: new Date(), result: resultOf(match) } }
    );
    flashAndRedirect(req, res, 'success', 'Match clôturé au score en l’état.', url);
  } catch (err) {
    next(err);
  }
});

// ---- Rouvrir un match clôturé (créateur, participant ou admin) ----
router.post('/free-play/:id/reopen', requireAuth, async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    const url = `/free-play/${match._id}`;
    const allowed = isOwner(match, req.session.user) || participantIds(match).includes(req.session.user.id);
    if (!allowed) return flashAndRedirect(req, res, 'error', 'Réservé aux participants ou au créateur du match.', url);
    if (match.status !== 'terminé') return flashAndRedirect(req, res, 'error', 'Le match n’est pas clôturé.', url);
    await req.db.collection(COLL).updateOne({ _id: match._id, status: 'terminé' }, { $set: { status: 'en_cours' }, $unset: { finishedAt: '' } });
    flashAndRedirect(req, res, 'success', 'Match rouvert : la saisie est de nouveau possible.', url);
  } catch (err) {
    next(err);
  }
});

// ---- Suppression (créateur ou admin) ----
router.post('/free-play/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    if (!isOwner(match, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Seul le créateur du match (ou un admin) peut le supprimer.', `/free-play/${match._id}`);
    }
    await req.db.collection(COLL).deleteOne({ _id: match._id });
    flashAndRedirect(req, res, 'success', 'Match supprimé.', '/free-play');
  } catch (err) {
    next(err);
  }
});

export default router;
