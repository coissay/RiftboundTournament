import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { flashAndRedirect } from '../middleware.js';

const router = Router();

router.get('/register', (req, res) => res.render('register'));

router.post('/register', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    if (username.length < 2 || password.length < 4) {
      return flashAndRedirect(req, res, 'error', 'Pseudo (min 2 car.) et mot de passe (min 4 car.) requis.', '/register');
    }
    const existing = await req.db.collection('users').findOne({ username });
    if (existing) {
      return flashAndRedirect(req, res, 'error', 'Ce pseudo est déjà pris.', '/register');
    }
    const hash = await bcrypt.hash(password, 10);
    const { insertedId } = await req.db.collection('users').insertOne({
      username,
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
    if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) {
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
