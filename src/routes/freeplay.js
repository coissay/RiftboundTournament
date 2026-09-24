import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth, flashAndRedirect, isAdmin } from '../middleware.js';
import { FORMATS, formatOf, gamesOf, resultOf, isDecided, tiebreakPending, maxGames, pickFirstPlayer, allPlayers, sideName, participantIds, computeStats } from '../freeplay.js';
import { currentVersion, ensureVersioned } from '../deckversions.js';
import { normalizeEmail, isEmail, findOrCreateGuest, versionAtDate } from '../guests.js';
import { normalizeSiding, sidingGamesFor, deckLinesFor, sidedDeckFor, baseDeckFor, sidingFromBody, isEmptySiding, sideSummary } from '../siding.js';
import { cardImageByName, thumb } from '../cards.js';
import { mailConfigured } from '../mailer.js';
import { sendGuestInvite } from '../invites.js';
import { createRateLimiter } from '../ratelimit.js';

const router = Router();
const COLL = 'free_matches';

// Ajout de joueurs sans compte : au plus 10 par utilisateur et par heure (best-effort, en mémoire).
const guestLimiter = createRateLimiter({ max: 10, windowMs: 3600 * 1000 });

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

// Side deck : visible de tous une fois le match clôturé, sinon seulement de son auteur.
function sidingVisible(match, ownerId, viewer) {
  return match.status === 'terminé' || (!!viewer && String(ownerId) === viewer.id);
}

// Déclarer / changer le deck joué par `targetId` : le joueur lui-même, ou le créateur du
// match / un admin pour n'importe quel participant (invités sans compte, notamment).
function canSetDeck(match, user, targetId) {
  if (!user || !participantIds(match).includes(targetId)) return false;
  return user.id === targetId || isOwner(match, user);
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
    mailConfigured: mailConfigured(),
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
      firstPlayer: pickFirstPlayer({ sides }), // tiré au sort parmi tous les joueurs ; en 2v2 son équipe commence
      gameResults: [],
      result: null,
      createdAt: new Date(),
    });
    flashAndRedirect(req, res, 'success', `Match ${spec.label} créé, à vous de jouer !`, `/free-play/${insertedId}`);
  } catch (err) {
    next(err);
  }
});

// ---- Ajout d'un joueur sans compte depuis le formulaire de création (appel fetch) ----
// Même mécanique que l'organisateur de tournoi (routes/tournaments.js) : l'invité
// existe dans `users` avec `guest: true` et reçoit un lien pour réclamer son compte.
// Réponse JSON pour que le formulaire garde ses places déjà remplies. Toujours du JSON,
// même en erreur (jamais err.message). JSON exigé en entrée : sans CORS, un formulaire
// cross-site ne peut pas forger ce Content-Type.
// Le lien d'invitation n'est renvoyé qu'à celui qui CRÉE l'invité : un invité déjà connu
// est simplement proposé, sans lien ni renvoi de mail (sinon n'importe quel compte connaissant
// l'e-mail pourrait récupérer le jeton et réclamer le compte).
router.post('/free-play/guests', requireAuth, async (req, res) => {
  try {
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON attendu' });
    const username = String(req.body.username || '').trim().slice(0, 40);
    const email = normalizeEmail(req.body.email);
    if (username.length < 2) return res.status(400).json({ error: 'Pseudo du joueur requis (min 2 car.).' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
    if (!guestLimiter.take(req.session.user.id)) return res.status(429).json({ error: 'Trop de joueurs ajoutés, réessaie plus tard.' });
    const { user, created, error } = await findOrCreateGuest(req.db, { username, email });
    if (error) return res.status(400).json({ error });
    const payload = { ok: true, user: { _id: String(user._id), username: user.username }, created, guest: !!user.guest, mailSent: false };
    // Compte existant (e-mail déjà rattaché) ou invité déjà connu : proposé tel quel, sans invitation.
    if (!user.guest || !created) return res.json(payload);
    const { sent, link } = await sendGuestInvite(req, user, { context: 'une partie libre (free play)' });
    res.json({ ...payload, mailSent: sent, ...(sent ? {} : { inviteLink: link }) });
  } catch (err) {
    // Course entre deux créations simultanées : index unique username / email.
    if (err && err.code === 11000) return res.status(409).json({ error: 'Pseudo ou e-mail déjà utilisé.' });
    console.error('POST /free-play/guests', err);
    res.status(500).json({ error: 'Erreur interne' });
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

// Matchs d'avant le tirage du premier joueur : on le tire à la première consultation et
// on le fige en base — seulement si le match n'a pas commencé (en cours, aucune manche) ;
// sinon on fige `null` : inventer un « tiré au sort » après coup n'aurait pas de sens.
// Le filtre `$exists: false` garantit qu'un seul tirage l'emporte si deux personnes
// ouvrent la page en même temps ; le perdant relit la valeur fixée.
async function ensureFirstPlayer(db, match) {
  if (match.firstPlayer !== undefined) return;
  const fresh_ = match.status === 'en_cours' && (match.gameResults || []).length === 0;
  const drawn = fresh_ ? pickFirstPlayer(match) : null;
  const { matchedCount } = await db.collection(COLL).updateOne({ _id: match._id, firstPlayer: { $exists: false } }, { $set: { firstPlayer: drawn } });
  if (matchedCount === 1) {
    match.firstPlayer = drawn;
  } else {
    const fresh = await db.collection(COLL).findOne({ _id: match._id }, { projection: { firstPlayer: 1 } });
    match.firstPlayer = fresh?.firstPlayer ?? null;
  }
}

// ---- Page match ----
router.get('/free-play/:id', async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    await ensureFirstPlayer(req.db, match);
    // Bilan free play de chaque participant dans ce format, façon record V-N-D des pairings.
    const ids = participantIds(match).map((id) => oid(id));
    const others = await req.db.collection(COLL).find({ status: 'terminé', format: match.format, 'sides.players.userId': { $in: ids } }).toArray();
    const { players: records } = computeStats(others, { format: match.format });
    const recordOf = Object.fromEntries(records.map((p) => [p.userId, `${p.wins}-${p.draws}-${p.losses}`]));

    // ---- Side decks : par joueur (clé userId), manche par manche ; sidables = [2..maxGames] (départage inclus), [1] en Bo1.
    const viewer = req.session.user;
    const players = allPlayers(match);
    const me = viewer ? players.find((p) => String(p.userId) === viewer.id) || null : null;
    const cap = maxGames(match);
    const games = gamesOf(match);
    const siding = {};
    const visible = {};
    const sidedDecks = {};
    const baseDecks = {};
    for (const p of players) {
      const uid = String(p.userId);
      siding[uid] = normalizeSiding((match.siding || {})[uid]);
      visible[uid] = sidingVisible(match, uid, viewer);
      sidedDecks[uid] = {};
      if (visible[uid]) {
        for (const [n, sd] of Object.entries(siding[uid].games)) {
          if (sd.out.length || sd.in.length) sidedDecks[uid][n] = await sidedDeckFor(req.db, p, sd);
        }
      }
      if (match.status === 'terminé') baseDecks[uid] = await baseDeckFor(req.db, p);
    }

    // ---- Deck joué, déclarable après coup : liste des decks de chaque joueur que le visiteur peut renseigner.
    const editable = players.filter((p) => canSetDeck(match, viewer, String(p.userId))).map((p) => p.userId);
    const deckDocs = editable.length
      ? await req.db.collection('decks').find({ ownerId: { $in: editable } }, { projection: { name: 1, ownerId: 1 } }).sort({ name: 1 }).toArray()
      : [];
    const decksByPlayer = {};
    for (const d of deckDocs) (decksByPlayer[String(d.ownerId)] ||= []).push({ id: String(d._id), name: d.name });
    const canSetDeckOf = Object.fromEntries(players.map((p) => [String(p.userId), editable.includes(p.userId)]));
    // Invités (sans compte) parmi les joueurs : le wording du callout deck en dépend.
    const guestDocs = editable.length ? await req.db.collection('users').find({ _id: { $in: editable }, guest: true }, { projection: { _id: 1 } }).toArray() : [];
    const isGuest = Object.fromEntries(guestDocs.map((u) => [String(u._id), true]));

    res.render('freeplay/match', {
      match,
      spec: formatOf(match),
      games,
      decided: isDecided(match),
      tiebreak: tiebreakPending(match),
      maxGames: cap,
      recordOf,
      canReport: canReport(match, req.session.user),
      owner: isOwner(match, req.session.user),
      sideName,
      // side deck
      me,
      siding,
      sidingVisible: visible,
      sidedDecks,
      baseDecks,
      sidingGames: sidingGamesFor(cap),
      myDeckLines: me ? await deckLinesFor(req.db, me) : null,
      mySiding: me ? siding[String(me.userId)] : null,
      cardImage: cardImageByName,
      thumb,
      sideSummary,
      // deck joué
      decksByPlayer,
      canSetDeckOf,
      isGuest,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Side deck d'une manche (joueur du match, pour lui-même ; corrigeable après coup) ----
router.post('/free-play/:id/siding', requireAuth, async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    const url = `/free-play/${match._id}#side-deck`;
    const me = allPlayers(match).find((p) => String(p.userId) === req.session.user.id);
    if (!me) return flashAndRedirect(req, res, 'error', 'Seuls les joueurs du match peuvent noter leur side deck.', url);
    const cap = maxGames(match);
    const game = parseInt(req.body.game, 10);
    if (!sidingGamesFor(cap).includes(game)) {
      const allowed = cap < 2 ? 'la manche 1 (Bo1)' : `les manches 2 à ${cap} — la manche 1 se joue avec le deck inscrit`;
      return flashAndRedirect(req, res, 'error', `Manche invalide : le side deck se note pour ${allowed}.`, url);
    }
    const sd = await sidingFromBody(req.db, me, req.body);
    const uid = req.session.user.id;
    const games = { ...normalizeSiding((match.siding || {})[uid]).games };
    if (isEmptySiding(sd)) delete games[game];
    else games[game] = { ...sd, updatedAt: new Date() };
    const key = `siding.${uid}`;
    await req.db.collection(COLL).updateOne({ _id: match._id }, Object.keys(games).length ? { $set: { [key]: { games } } } : { $unset: { [key]: '' } });
    if (!games[game]) return flashAndRedirect(req, res, 'success', `Side deck de la manche ${game} effacé.`, url);
    const hidden = match.status !== 'terminé' ? ' Il restera caché aux autres jusqu’à la clôture du match.' : '';
    flashAndRedirect(req, res, 'success', `Side deck de la manche ${game} enregistré.` + hidden, url);
  } catch (err) {
    next(err);
  }
});

// ---- Déclarer / changer le deck joué, même après coup (joueur lui-même, ou créateur / admin pour tout participant) ----
router.post('/free-play/:id/deck', requireAuth, async (req, res, next) => {
  try {
    const match = await loadMatch(req, res);
    if (!match) return;
    const url = `/free-play/${match._id}`;
    const targetId = String(req.body.userId || '');
    if (!canSetDeck(match, req.session.user, targetId)) {
      return flashAndRedirect(req, res, 'error', 'Tu peux déclarer ton propre deck ; seul le créateur du match (ou un admin) peut le faire pour un autre joueur.', url);
    }
    let i = -1;
    let j = -1;
    match.sides.forEach((s, si) => s.players.forEach((p, pj) => { if (String(p.userId) === targetId) { i = si; j = pj; } }));
    const target = match.sides[i].players[j];
    const prefix = `sides.${i}.players.${j}`;
    if (!req.body.deckId) {
      await req.db.collection(COLL).updateOne({ _id: match._id }, { $set: { [`${prefix}.deckId`]: null, [`${prefix}.deckName`]: null, [`${prefix}.deckVersion`]: null } });
      return flashAndRedirect(req, res, 'success', `Deck retiré pour ${target.username}.`, url);
    }
    const deck = await req.db.collection('decks').findOne({ _id: oid(req.body.deckId), ownerId: oid(targetId) });
    if (!deck) return flashAndRedirect(req, res, 'error', 'Choisis un deck appartenant à ce joueur.', url);
    // Version du deck en vigueur à la date du match (le deck a pu être modifié depuis), pour des stats par version justes.
    await ensureVersioned(req.db, deck);
    const deckVersion = await versionAtDate(req.db, deck._id, match.date);
    await req.db.collection(COLL).updateOne(
      { _id: match._id },
      { $set: { [`${prefix}.deckId`]: deck._id, [`${prefix}.deckName`]: deck.name, [`${prefix}.deckVersion`]: deckVersion } }
    );
    // Un side déjà noté reste stocké tel quel : il se relit par rapport au nouveau deck.
    flashAndRedirect(req, res, 'success', `Deck « ${deck.name} » (v${deckVersion}) enregistré pour ${target.username}.`, url);
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
