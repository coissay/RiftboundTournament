import { Router } from 'express';
import { oid } from '../db.js';
import { requireAuth, flashAndRedirect, isAdmin } from '../middleware.js';
import { AUTO_CLOSE_DAYS } from '../housekeeping.js';
import { computeStandings, pairRound, suggestedRounds, winsNeeded } from '../swiss.js';
import { currentVersion, playedVersion, ensureVersioned } from '../deckversions.js';
import { resolveDecklist, parseDecklist } from '../cards.js';
import { normalizeEmail, isEmail, findOrCreateGuest, newInviteToken, versionAtDate, setPlayedDeck } from '../guests.js';
import { sendMail, inviteMail, absoluteUrl, mailConfigured } from '../mailer.js';

const router = Router();

async function loadTournament(req, res) {
  const tournament = await req.db.collection('tournaments').findOne({ _id: oid(req.params.id) });
  if (!tournament) {
    res.status(404).render('error', { message: 'Tournoi introuvable' });
    return null;
  }
  return tournament;
}

// L'organisateur du tournoi, ou un admin (ADMIN_USERS), a la main sur le tournoi.
function isOrganizer(tournament, user) {
  return !!user && (String(tournament.organizerId) === user.id || isAdmin(user));
}

// ---- Liste (page d'accueil, façon locator) ----
router.get('/', async (req, res, next) => {
  try {
    // La liste n'affiche ni les rondes ni la description : on ne les charge pas.
    const tournaments = await req.db
      .collection('tournaments')
      .find({}, { projection: { rounds: 0, description: 0 } })
      .sort({ date: -1 })
      .toArray();
    res.render('index', { tournaments });
  } catch (err) {
    next(err);
  }
});

// ---- Création ----
router.get('/tournaments/new', requireAuth, (req, res) => res.render('tournament-form'));

router.post('/tournaments/new', requireAuth, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const durationMinutes = parseInt(req.body.durationMinutes, 10) || 120;
    const roundLength = parseInt(req.body.roundLength, 10) || 50;
    const bestOf = [1, 3, 5].includes(parseInt(req.body.bestOf, 10)) ? parseInt(req.body.bestOf, 10) : 1;
    if (!name) return flashAndRedirect(req, res, 'error', 'Le nom du tournoi est requis.', '/tournaments/new');
    const { insertedId } = await req.db.collection('tournaments').insertOne({
      name,
      description: (req.body.description || '').trim(),
      date: req.body.date ? new Date(req.body.date) : new Date(),
      durationMinutes,
      roundLength,
      bestOf,
      status: 'inscriptions', // inscriptions → en_cours → terminé
      organizerId: oid(req.session.user.id),
      organizerName: req.session.user.username,
      players: [],
      rounds: [],
      winner: null,
      createdAt: new Date(),
    });
    flashAndRedirect(req, res, 'success', 'Tournoi créé ! Les joueurs peuvent s’inscrire.', `/tournaments/${insertedId}`);
  } catch (err) {
    next(err);
  }
});

// ---- Détail ----
router.get('/tournaments/:id', async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const standings = computeStandings(tournament);
    let myDecks = [];
    if (req.session.user) {
      myDecks = await req.db
        .collection('decks')
        .find({ ownerId: oid(req.session.user.id) })
        .sort({ createdAt: -1 })
        .toArray();
    }
    const activePlayers = (tournament.players || []).filter((p) => !p.dropped);
    const organizer = isOrganizer(tournament, req.session.user);
    // Invités (compte non réclamé) : l'organisateur voit l'e-mail et le lien d'invitation.
    const guestInfo = {};
    if (organizer && tournament.players.length) {
      const guests = await req.db.collection('users').find({ _id: { $in: tournament.players.map((p) => p.userId) }, guest: true }).toArray();
      for (const g of guests) {
        guestInfo[String(g._id)] = { email: g.email, sentAt: g.invite?.sentAt || null, link: g.invite?.token ? absoluteUrl(req, `/register?invite=${encodeURIComponent(g.invite.token)}`) : null };
      }
    }
    const me = req.session.user ? tournament.players.find((p) => String(p.userId) === req.session.user.id) : null;
    res.render('tournament', {
      tournament,
      standings,
      myDecks,
      organizer,
      registered: !!me,
      myDeckMissing: !!me && !me.deckId,
      guestInfo,
      mailConfigured: mailConfigured(),
      tab: req.query.tab || 'rondes',
      plannedRounds: suggestedRounds(activePlayers.length, tournament.durationMinutes, tournament.roundLength),
      autoCloseDays: AUTO_CLOSE_DAYS,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Inscription / désinscription ----
router.post('/tournaments/:id/join', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}`;
    if (tournament.status !== 'inscriptions') {
      return flashAndRedirect(req, res, 'error', 'Les inscriptions sont closes.', url);
    }
    const deck = await req.db.collection('decks').findOne({ _id: oid(req.body.deckId), ownerId: oid(req.session.user.id) });
    if (!deck) return flashAndRedirect(req, res, 'error', 'Choisis un de tes decks pour t’inscrire.', url);
    if (tournament.players.some((p) => String(p.userId) === req.session.user.id)) {
      // Déjà inscrit : on met juste à jour le deck choisi.
      await req.db.collection('tournaments').updateOne(
        { _id: tournament._id, 'players.userId': oid(req.session.user.id) },
        { $set: { 'players.$.deckId': deck._id, 'players.$.deckName': deck.name, 'players.$.deckVersion': currentVersion(deck) } }
      );
      return flashAndRedirect(req, res, 'success', `Deck changé pour « ${deck.name} ».`, url);
    }
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id },
      {
        $push: {
          players: {
            userId: oid(req.session.user.id),
            username: req.session.user.username,
            deckId: deck._id,
            deckName: deck.name,
            deckVersion: currentVersion(deck), // version du deck au moment de l'inscription (stats par version)
            dropped: false,
          },
        },
      }
    );
    flashAndRedirect(req, res, 'success', `Inscrit avec « ${deck.name} » !`, url);
  } catch (err) {
    next(err);
  }
});

router.post('/tournaments/:id/leave', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}`;
    if (tournament.status !== 'inscriptions') {
      return flashAndRedirect(req, res, 'error', 'Le tournoi a commencé, demande un drop à l’organisateur.', url);
    }
    await req.db
      .collection('tournaments')
      .updateOne({ _id: tournament._id }, { $pull: { players: { userId: oid(req.session.user.id) } } });
    flashAndRedirect(req, res, 'success', 'Désinscription effectuée.', url);
  } catch (err) {
    next(err);
  }
});

// ---- Ajout d'un joueur invité par l'organisateur (pseudo + e-mail) ----
// L'invité existe dans `users` sans mot de passe ; il reçoit un lien pour créer son
// compte et conserver son historique. S'il a déjà un compte avec cet e-mail, il est
// simplement inscrit (sans deck : il le renseignera lui-même).
async function sendInvite(req, guest, tournament) {
  const token = guest.invite?.token || newInviteToken();
  const link = absoluteUrl(req, `/register?invite=${encodeURIComponent(token)}`);
  const mail = inviteMail({ guestName: guest.username, tournamentName: tournament.name, organizerName: req.session.user.username, link });
  const { sent } = await sendMail({ to: guest.email, ...mail });
  await req.db.collection('users').updateOne(
    { _id: guest._id },
    { $set: { 'invite.token': token, 'invite.sentAt': sent ? new Date() : guest.invite?.sentAt || null, 'invite.lastTournamentId': tournament._id } }
  );
  return { sent, link };
}

router.post('/tournaments/:id/guests', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}?tab=joueurs`;
    if (!isOrganizer(tournament, req.session.user)) return flashAndRedirect(req, res, 'error', 'Réservé à l’organisateur.', url);
    if (tournament.status !== 'inscriptions') return flashAndRedirect(req, res, 'error', 'Les inscriptions sont closes.', url);
    const username = String(req.body.username || '').trim().slice(0, 40);
    const email = normalizeEmail(req.body.email);
    if (username.length < 2) return flashAndRedirect(req, res, 'error', 'Pseudo de l’invité requis (min 2 car.).', url);
    if (!isEmail(email)) return flashAndRedirect(req, res, 'error', 'Adresse e-mail invalide.', url);
    const { user, created, error } = await findOrCreateGuest(req.db, { username, email });
    if (error) return flashAndRedirect(req, res, 'error', error, url);
    if (tournament.players.some((p) => String(p.userId) === String(user._id))) {
      return flashAndRedirect(req, res, 'error', `${user.username} est déjà inscrit·e.`, url);
    }
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id },
      { $push: { players: { userId: user._id, username: user.username, deckId: null, deckName: null, deckVersion: null, dropped: false, addedBy: oid(req.session.user.id) } } }
    );
    if (!user.guest) {
      return flashAndRedirect(req, res, 'success', `${user.username} a déjà un compte : inscrit·e au tournoi, il/elle pourra indiquer son deck.`, url);
    }
    const { sent, link } = await sendInvite(req, user, tournament);
    const how = sent ? `Invitation envoyée à ${email}.` : `E-mail non configuré (SMTP_URL) : transmets-lui ce lien — ${link}`;
    flashAndRedirect(req, res, 'success', `${user.username} ajouté·e${created ? '' : ' (invité·e déjà connu·e)'}. ${how}`, url);
  } catch (err) {
    next(err);
  }
});

router.post('/tournaments/:id/guests/:userId/invite', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}?tab=joueurs`;
    if (!isOrganizer(tournament, req.session.user)) return flashAndRedirect(req, res, 'error', 'Réservé à l’organisateur.', url);
    const guest = await req.db.collection('users').findOne({ _id: oid(req.params.userId), guest: true });
    if (!guest || !tournament.players.some((p) => String(p.userId) === String(guest._id))) {
      return flashAndRedirect(req, res, 'error', 'Invité introuvable sur ce tournoi (compte déjà créé ?).', url);
    }
    const { sent, link } = await sendInvite(req, guest, tournament);
    flashAndRedirect(req, res, 'success', sent ? `Invitation renvoyée à ${guest.email}.` : `E-mail non configuré : lien d’invitation — ${link}`, url);
  } catch (err) {
    next(err);
  }
});

// ---- Renseigner a posteriori le deck joué (joueur inscrit sans deck, ex-invité) ----
router.post('/tournaments/:id/my-deck', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const back = req.body.back === 'player' ? `/players/${req.session.user.id}` : `/tournaments/${tournament._id}?tab=joueurs`;
    const me = tournament.players.find((p) => String(p.userId) === req.session.user.id);
    if (!me) return flashAndRedirect(req, res, 'error', 'Tu n’es pas inscrit·e à ce tournoi.', back);
    if (me.deckId) return flashAndRedirect(req, res, 'error', 'Ton deck est déjà renseigné pour ce tournoi.', back);
    const deck = await req.db.collection('decks').findOne({ _id: oid(req.body.deckId), ownerId: oid(req.session.user.id) });
    if (!deck) return flashAndRedirect(req, res, 'error', 'Choisis un de tes decks.', back);
    const deckVersion = await versionAtDate(req.db, deck._id, tournament.date);
    await setPlayedDeck(req.db, tournament, req.session.user.id, deck, deckVersion);
    flashAndRedirect(req, res, 'success', `Deck « ${deck.name} » (v${deckVersion}) enregistré pour « ${tournament.name} ».`, back);
  } catch (err) {
    next(err);
  }
});

// ---- Drop d'un joueur (organisateur) ----
router.post('/tournaments/:id/players/:userId/drop', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}?tab=joueurs`;
    if (!isOrganizer(tournament, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Réservé à l’organisateur.', url);
    }
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id, 'players.userId': oid(req.params.userId) },
      { $set: { 'players.$.dropped': true } }
    );
    flashAndRedirect(req, res, 'success', 'Joueur retiré des prochaines rondes.', url);
  } catch (err) {
    next(err);
  }
});

// ---- Lancement du tournoi + ronde 1 ----
router.post('/tournaments/:id/start', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}`;
    if (!isOrganizer(tournament, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Réservé à l’organisateur.', url);
    }
    if (tournament.status !== 'inscriptions') {
      return flashAndRedirect(req, res, 'error', 'Le tournoi est déjà lancé.', url);
    }
    if ((tournament.players || []).length < 2) {
      return flashAndRedirect(req, res, 'error', 'Il faut au moins 2 joueurs inscrits.', url);
    }
    const matches = pairRound(tournament);
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id },
      {
        $set: { status: 'en_cours' },
        $push: { rounds: { number: 1, startedAt: new Date(), matches } },
      }
    );
    flashAndRedirect(req, res, 'success', 'Tournoi lancé, ronde 1 appariée ! ⏱️ 50 minutes.', url);
  } catch (err) {
    next(err);
  }
});

// ---- Nouvelle ronde ----
router.post('/tournaments/:id/rounds', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}`;
    if (!isOrganizer(tournament, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Réservé à l’organisateur.', url);
    }
    if (tournament.status !== 'en_cours') {
      return flashAndRedirect(req, res, 'error', 'Le tournoi n’est pas en cours.', url);
    }
    const lastRound = tournament.rounds[tournament.rounds.length - 1];
    if (lastRound && lastRound.matches.some((m) => !m.result)) {
      return flashAndRedirect(req, res, 'error', 'Tous les résultats de la ronde en cours doivent être saisis.', url);
    }
    const matches = pairRound(tournament);
    if (!matches || matches.length === 0) {
      return flashAndRedirect(req, res, 'error', 'Impossible d’apparier une nouvelle ronde.', url);
    }
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id },
      { $push: { rounds: { number: tournament.rounds.length + 1, startedAt: new Date(), matches } } }
    );
    flashAndRedirect(req, res, 'success', `Ronde ${tournament.rounds.length + 1} appariée ! ⏱️ ${tournament.roundLength} minutes.`, url);
  } catch (err) {
    next(err);
  }
});

// ---- Page match (versus façon locator) ----
// Renvoie aussi `path`, le chemin Mongo du match trouvé (par index réels dans les
// tableaux, et non `number - 1` / `table - 1`), pour que les écritures ciblent
// exactement l'élément lu.
function findMatch(tournament, roundNumber, table) {
  const rounds = tournament.rounds || [];
  const roundIndex = rounds.findIndex((r) => r.number === roundNumber);
  const round = roundIndex >= 0 ? rounds[roundIndex] : null;
  const matchIndex = round ? (round.matches || []).findIndex((m) => m.table === table) : -1;
  const match = matchIndex >= 0 ? round.matches[matchIndex] : null;
  return { round, match, path: match ? `rounds.${roundIndex}.matches.${matchIndex}` : null };
}

function canReportMatch(tournament, round, match, user) {
  if (!user || !match || match.bye) return false;
  if (tournament.status !== 'en_cours' || round.number !== tournament.rounds.length) return false;
  return isOrganizer(tournament, user) || [String(match.p1.userId), String(match.p2.userId)].includes(user.id);
}

// ---- Side deck : cartes échangées avec la réserve pour ce match ----
// Chaque joueur de la table peut noter ses échanges (pendant le tournoi ou après coup).
// Ils restent cachés à tout le monde sauf lui tant que le tournoi n'est pas clôturé.
function sidingVisible(tournament, ownerId, viewer) {
  if (tournament.status === 'terminé') return true;
  return !!viewer && String(ownerId) === viewer.id;
}

// Deck principal + réserve du joueur, dans la version jouée (pour le formulaire de side deck).
async function deckLinesFor(db, player) {
  // Dans les appariements, deckId est une chaîne (copié depuis le classement) : on le reconvertit.
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
  const lines = (key) => (resolved.sections.find((s) => s.key === key)?.cards || []).map((l) => ({ name: l.card ? l.card.name : l.name, qty: l.qty, image: l.card?.image || null }));
  return { main: lines('main'), sideboard: lines('sideboard') };
}

router.get('/tournaments/:id/rounds/:roundNumber/tables/:table', async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const { round, match } = findMatch(tournament, parseInt(req.params.roundNumber, 10), parseInt(req.params.table, 10));
    if (!match || match.bye) return res.status(404).render('error', { message: 'Match introuvable' });
    const standings = computeStandings(tournament);
    const recordOf = Object.fromEntries(standings.map((s) => [s.userId, `${s.wins}-${s.draws}-${s.losses}`]));
    const viewer = req.session.user;
    const me = viewer ? [match.p1, match.p2].find((p) => String(p.userId) === viewer.id) || null : null;
    const siding = match.siding || {};
    res.render('match', {
      tournament,
      round,
      match,
      recordOf,
      canReport: canReportMatch(tournament, round, match, viewer),
      siding,
      sidingVisible: { p1: sidingVisible(tournament, match.p1.userId, viewer), p2: sidingVisible(tournament, match.p2.userId, viewer) },
      me,
      myDeckLines: me ? await deckLinesFor(req.db, me) : null,
      mySiding: me ? siding[String(me.userId)] || null : null,
    });
  } catch (err) {
    next(err);
  }
});

// Lignes « qty nom » saisies à la main (deck introuvable) : réutilise le parseur de decklist.
function parseFreeLines(text) {
  return parseDecklist(String(text || '').slice(0, 5000))
    .flatMap((s) => s.cards)
    .map((c) => ({ name: c.name.slice(0, 120), qty: Math.min(c.qty, 40) }));
}

router.post('/tournaments/:id/rounds/:roundNumber/tables/:table/siding', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const roundNumber = parseInt(req.params.roundNumber, 10);
    const table = parseInt(req.params.table, 10);
    const url = `/tournaments/${tournament._id}/rounds/${roundNumber}/tables/${table}#side-deck`;
    const { match, path } = findMatch(tournament, roundNumber, table);
    if (!match || match.bye) return flashAndRedirect(req, res, 'error', 'Match introuvable.', `/tournaments/${tournament._id}`);
    const me = [match.p1, match.p2].find((p) => String(p.userId) === req.session.user.id);
    if (!me) return flashAndRedirect(req, res, 'error', 'Seuls les joueurs de la table peuvent noter leur side deck.', url);

    let out = [];
    let inn = [];
    if (req.body.mode === 'text') {
      out = parseFreeLines(req.body.outText);
      inn = parseFreeLines(req.body.inText);
    } else {
      // Quantités par carte du deck principal (sorties) et de la réserve (entrées), bornées par le deck joué.
      const lines = await deckLinesFor(req.db, me);
      const pick = (prefix, ref) =>
        (ref || [])
          .map((c, i) => ({ name: c.name, qty: Math.max(0, Math.min(c.qty, parseInt(req.body[`${prefix}_${i}`], 10) || 0)) }))
          .filter((c) => c.qty > 0);
      out = pick('out', lines?.main);
      inn = pick('in', lines?.sideboard);
    }
    const note = String(req.body.note || '').trim().slice(0, 300);
    const key = `${path}.siding.${req.session.user.id}`;
    if (out.length === 0 && inn.length === 0 && !note) {
      await req.db.collection('tournaments').updateOne({ _id: tournament._id }, { $unset: { [key]: '' } });
      return flashAndRedirect(req, res, 'success', 'Side deck effacé pour ce match.', url);
    }
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id },
      { $set: { [key]: { out, in: inn, note, updatedAt: new Date() } } }
    );
    const hidden = tournament.status !== 'terminé' ? ' Il restera caché aux autres jusqu’à la clôture du tournoi.' : '';
    flashAndRedirect(req, res, 'success', 'Side deck enregistré.' + hidden, url);
  } catch (err) {
    next(err);
  }
});

// ---- Enregistrer UNE manche (un clic sur un des 3 boutons win/draw/loose) ----
router.post('/tournaments/:id/rounds/:roundNumber/tables/:table/games', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const roundNumber = parseInt(req.params.roundNumber, 10);
    const table = parseInt(req.params.table, 10);
    const url = `/tournaments/${tournament._id}/rounds/${roundNumber}/tables/${table}`;
    const { round, match, path } = findMatch(tournament, roundNumber, table);
    if (!match || match.bye) return flashAndRedirect(req, res, 'error', 'Match introuvable.', `/tournaments/${tournament._id}`);
    if (!canReportMatch(tournament, round, match, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Cette ronde n’est plus modifiable, ou tu n’es ni joueur de la table ni organisateur.', url);
    }
    const value = req.body.gameResult;
    if (!['p1', 'p2', 'draw'].includes(value)) return flashAndRedirect(req, res, 'error', 'Résultat de manche invalide.', url);

    const bestOf = tournament.bestOf || 1;
    const need = winsNeeded(bestOf);
    const previous = Array.isArray(match.gameResults) ? match.gameResults : null;
    const gameResults = previous ? [...previous] : [];
    const w = { p1: 0, p2: 0 };
    for (const g of gameResults) if (w[g] !== undefined) w[g] += 1;
    if (gameResults.length >= bestOf || w.p1 === need || w.p2 === need) {
      return flashAndRedirect(req, res, 'error', 'Le match est déjà terminé — réinitialise la saisie pour corriger.', url);
    }
    gameResults.push(value);
    if (w[value] !== undefined) w[value] += 1;
    const draws = gameResults.filter((r) => r === 'draw').length;
    // Le résultat du match est recalculé après chaque manche : il reflète le
    // score courant (règle du temps écoulé : plus de manches gagnées = victoire).
    const result = w.p1 > w.p2 ? 'p1' : w.p2 > w.p1 ? 'p2' : 'draw';
    // Compare-and-swap : l'écriture n'a lieu que si les manches en base sont encore
    // celles qu'on a lues. Les deux joueurs de la table sont sur la même page ; sans
    // ça, deux clics simultanés se lisaient mutuellement à 0-0 et une manche était perdue.
    const { matchedCount } = await req.db.collection('tournaments').updateOne(
      { _id: tournament._id, [`${path}.gameResults`]: previous === null ? { $exists: false } : previous },
      {
        $set: {
          [`${path}.result`]: result,
          [`${path}.gameResults`]: gameResults,
          [`${path}.games`]: { p1: w.p1, p2: w.p2, draws },
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

// ---- Réinitialiser la saisie d'un match ----
router.post('/tournaments/:id/rounds/:roundNumber/tables/:table/reset', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const roundNumber = parseInt(req.params.roundNumber, 10);
    const table = parseInt(req.params.table, 10);
    const url = `/tournaments/${tournament._id}/rounds/${roundNumber}/tables/${table}`;
    const { round, match, path } = findMatch(tournament, roundNumber, table);
    if (!match || match.bye) return flashAndRedirect(req, res, 'error', 'Match introuvable.', `/tournaments/${tournament._id}`);
    if (!canReportMatch(tournament, round, match, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Cette ronde n’est plus modifiable.', url);
    }
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id },
      {
        $set: {
          [`${path}.result`]: null,
          [`${path}.gameResults`]: [],
          [`${path}.games`]: { p1: 0, p2: 0, draws: 0 },
        },
      }
    );
    flashAndRedirect(req, res, 'success', 'Saisie réinitialisée, c’est reparti de 0-0.', url);
  } catch (err) {
    next(err);
  }
});

// ---- Clôture : le premier du classement prend la coupe ----
router.post('/tournaments/:id/finish', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}`;
    if (!isOrganizer(tournament, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Réservé à l’organisateur.', url);
    }
    if (tournament.status !== 'en_cours') {
      return flashAndRedirect(req, res, 'error', 'Le tournoi n’est pas en cours.', url);
    }
    const lastRound = tournament.rounds[tournament.rounds.length - 1];
    if (lastRound && lastRound.matches.some((m) => !m.result)) {
      return flashAndRedirect(req, res, 'error', 'Saisis tous les résultats avant de clôturer.', url);
    }
    const standings = computeStandings(tournament);
    const champion = standings[0];
    if (!champion) return flashAndRedirect(req, res, 'error', 'Aucun joueur au classement, impossible de clôturer.', url);
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id },
      {
        $set: {
          status: 'terminé',
          finishedAt: new Date(),
          winner: { userId: champion.userId, username: champion.username, deckName: champion.deckName, deckId: champion.deckId, deckVersion: champion.deckVersion || 1 },
        },
      }
    );
    flashAndRedirect(req, res, 'success', `🏆 ${champion.username} remporte la coupe avec « ${champion.deckName} » !`, url);
  } catch (err) {
    next(err);
  }
});

// ---- Réouverture d'un tournoi clôturé (auto ou à la main) : organisateur ou admin ----
// Reprend là où il en était : en cours s'il y a des rondes, sinon en inscriptions.
// La coupe éventuelle est retirée jusqu'à la prochaine clôture.
router.post('/tournaments/:id/reopen', requireAuth, async (req, res, next) => {
  try {
    const tournament = await loadTournament(req, res);
    if (!tournament) return;
    const url = `/tournaments/${tournament._id}`;
    if (!isOrganizer(tournament, req.session.user)) {
      return flashAndRedirect(req, res, 'error', 'Réservé à l’organisateur ou à un admin.', url);
    }
    if (tournament.status !== 'terminé') {
      return flashAndRedirect(req, res, 'error', 'Le tournoi n’est pas clôturé.', url);
    }
    const rounds = tournament.rounds || [];
    const status = rounds.length > 0 ? 'en_cours' : 'inscriptions';
    await req.db.collection('tournaments').updateOne(
      { _id: tournament._id, status: 'terminé' },
      { $set: { status, reopenedAt: new Date(), winner: null }, $unset: { finishedAt: '', autoClosed: '' } }
    );
    const where = status === 'en_cours' ? `reprise à la ronde ${rounds.length}` : 'inscriptions rouvertes';
    const cup = tournament.winner ? ' La coupe est retirée jusqu’à la prochaine clôture.' : '';
    flashAndRedirect(req, res, 'success', `Tournoi rouvert (${where}).${cup}`, url);
  } catch (err) {
    next(err);
  }
});

export default router;
