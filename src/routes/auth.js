import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { flashAndRedirect } from '../middleware.js';
import { normalizeEmail, isEmail, claimGuest } from '../guests.js';

const router = Router();

// `?invite=<jeton>` : lien reçu par un joueur invité — le formulaire est prérempli et
// le compte créé reprend l'identité (et donc l'historique) de l'invité.
router.get('/register', async (req, res, next) => {
  try {
    let invite = null;
    if (typeof req.query.invite === 'string' && req.query.invite) {
      const guest = await req.db.collection('users').findOne({ 'invite.token': req.query.invite, guest: true });
      if (guest) invite = { token: req.query.invite, username: guest.username, email: guest.email };
      else req.session.flash = { type: 'error', text: 'Lien d’invitation invalide ou déjà utilisé — tu peux quand même créer un compte.' };
    }
    // Le flash posé ci-dessus s'ajoute à celui déjà lu par le middleware (res.locals.flash).
    res.render('register', { invite, flash: req.session.flash || res.locals.flash });
    delete req.session.flash;
  } catch (err) {
    next(err);
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const email = normalizeEmail(req.body.email);
    const token = typeof req.body.invite === 'string' ? req.body.invite : '';
    const back = token ? `/register?invite=${encodeURIComponent(token)}` : '/register';
    if (username.length < 2 || password.length < 4) {
      return flashAndRedirect(req, res, 'error', 'Pseudo (min 2 car.) et mot de passe (min 4 car.) requis.', back);
    }
    if (email && !isEmail(email)) return flashAndRedirect(req, res, 'error', 'Adresse e-mail invalide.', back);
    const users = req.db.collection('users');

    // Invité qui réclame son compte : même _id, l'historique suit.
    if (token) {
      const guest = await users.findOne({ 'invite.token': token, guest: true });
      if (!guest) return flashAndRedirect(req, res, 'error', 'Lien d’invitation invalide ou déjà utilisé.', '/register');
      if (username !== guest.username && (await users.findOne({ username }))) {
        return flashAndRedirect(req, res, 'error', 'Ce pseudo est déjà pris.', back);
      }
      await claimGuest(req.db, guest, { username, passwordHash: await bcrypt.hash(password, 10) });
      req.session.user = { id: String(guest._id), username };
      const n = await req.db.collection('tournaments').countDocuments({ 'players.userId': guest._id });
      return flashAndRedirect(req, res, 'success', `Bienvenue ${username} ! Ton historique (${n} tournoi${n > 1 ? 's' : ''}) est conservé — pense à indiquer les decks que tu as joués.`, `/players/${guest._id}`);
    }

    if (await users.findOne({ username })) return flashAndRedirect(req, res, 'error', 'Ce pseudo est déjà pris.', back);
    if (email) {
      const sameEmail = await users.findOne({ email });
      if (sameEmail && sameEmail.guest) {
        return flashAndRedirect(req, res, 'error', 'Cet e-mail correspond à un joueur invité : utilise le lien reçu par e-mail (ou demande à l’organisateur de le renvoyer) pour récupérer ton historique.', back);
      }
      if (sameEmail) return flashAndRedirect(req, res, 'error', 'Un compte existe déjà avec cet e-mail.', back);
    }
    const hash = await bcrypt.hash(password, 10);
    const { insertedId } = await users.insertOne({
      username,
      ...(email ? { email } : {}),
      passwordHash: hash,
      createdAt: new Date(),
    });
    req.session.user = { id: String(insertedId), username };
    flashAndRedirect(req, res, 'success', `Bienvenue ${username} ! Crée ton premier deck.`, '/decks');
  } catch (err) {
    next(err);
  }
});

router.get('/login', (req, res) => res.render('login'));

router.post('/login', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const user = await req.db.collection('users').findOne({ username });
    // Un invité n'a pas de mot de passe : il doit passer par son lien d'invitation.
    if (!user || !user.passwordHash || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) {
      return flashAndRedirect(req, res, 'error', 'Pseudo ou mot de passe incorrect.', '/login');
    }
    req.session.user = { id: String(user._id), username: user.username };
    flashAndRedirect(req, res, 'success', `Content de te revoir, ${user.username} !`, '/');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

export default router;
