import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, MONGO_URL, DB_NAME, oid } from './db.js';
import { initCatalog } from './cards.js';
import { isAdmin } from './middleware.js';
import { startHousekeeping } from './housekeeping.js';
import { migrateDecks } from './deckversions.js';
import authRoutes from './routes/auth.js';
import deckRoutes from './routes/decks.js';
import deckbuilderRoutes from './routes/deckbuilder.js';
import tournamentRoutes from './routes/tournaments.js';
import statsRoutes from './routes/stats.js';
import playerRoutes from './routes/players.js';
import locatorRoutes from './routes/locator.js';
import freeplayRoutes from './routes/freeplay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const db = await connect();
await initCatalog(db); // catalogue de cartes Riftbound (API galerie officielle, cache Mongo)
await migrateDecks(db); // decks d'avant les versions : v1 = cartes actuelles

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// JSON à insérer dans un <script> inline : JSON.stringify n'échappe ni « < » (fermeture de
// balise → XSS stocké via un pseudo) ni U+2028/U+2029 (fin de ligne JS). À utiliser avec <%- %>.
app.locals.jsonForScript = (x) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'riftbound-nperf-interne',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URL, dbName: DB_NAME }),
    cookie: { maxAge: 30 * 24 * 3600 * 1000 },
  })
);

// Contexte commun à toutes les vues.
app.use((req, res, next) => {
  req.db = db;
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.isAdmin = isAdmin(req.session.user);
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// Bannière persistante : un match m'attend dans la ronde en cours d'un tournoi (résultat non saisi).
app.use(async (req, res, next) => {
  res.locals.pendingMatch = null;
  if (!req.session.user || req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  try {
    const me = req.session.user.id;
    const live = await db
      .collection('tournaments')
      .find({ status: 'en_cours', 'players.userId': oid(me) }, { projection: { name: 1, rounds: 1, roundLength: 1 } })
      .toArray();
    for (const t of live) {
      const round = (t.rounds || [])[t.rounds.length - 1];
      if (!round) continue;
      const m = (round.matches || []).find((x) => !x.bye && !x.result && [String(x.p1.userId), String(x.p2?.userId)].includes(me));
      if (!m) continue;
      const opp = String(m.p1.userId) === me ? m.p2 : m.p1;
      const url = `/tournaments/${t._id}/rounds/${round.number}/tables/${m.table}`;
      if (req.path.startsWith(`/tournaments/${t._id}`)) break; // déjà sur le tournoi (barre « Ma table ») ou le match
      res.locals.pendingMatch = { url, tournamentName: t.name, round: round.number, table: m.table, opponent: opp.username, startedAt: round.startedAt, roundLength: t.roundLength };
      break;
    }
  } catch (err) {
    console.error('pendingMatch', err.message);
  }
  next();
});

app.use(authRoutes);
app.use(deckRoutes);
app.use(deckbuilderRoutes);
app.use(tournamentRoutes);
app.use(freeplayRoutes);
app.use(statsRoutes);
app.use(playerRoutes);
app.use(locatorRoutes);

app.use((req, res) => res.status(404).render('error', { message: 'Page introuvable' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Erreur interne : ' + err.message });
});

startHousekeeping(db); // clôture automatique des tournois en attente

app.listen(PORT, () => console.log(`Riftbound Tournois → http://localhost:${PORT}`));
