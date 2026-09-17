// Admins : pseudos listés dans ADMIN_USERS (séparés par des virgules). Ils ont les
// droits de l'organisateur sur tous les tournois (utile quand celui-ci est absent).
const ADMIN_USERS = new Set((process.env.ADMIN_USERS || '').split(',').map((s) => s.trim()).filter(Boolean));

export function isAdmin(user) {
  return !!user && ADMIN_USERS.has(user.username);
}

export function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'error', text: 'Connecte-toi pour accéder à cette page.' };
    return res.redirect('/login');
  }
  next();
}

export function flashAndRedirect(req, res, type, text, url) {
  req.session.flash = { type, text };
  res.redirect(url);
}
