// Client pour l'API du locator UVS (https://locator.riftbound.uvsgames.com).
//
// API non documentée mais publique : c'est celle qu'utilise le site lui-même.
//  - POST /api/v2/auth/dj-rest-auth/login/ { email, password } -> { key }
//  - GET  /api/v2/player/games/riftbound/tournament-history/   (authentifié) -> événements + matchs + deck joué
//  - GET  /api/v2/player/games/riftbound/stats/                (authentifié)
// Le jeton (« key ») est stocké chiffré en base ; le mot de passe n'est jamais conservé.

import crypto from 'node:crypto';

const API_BASE = process.env.LOCATOR_API || 'https://api.riftbound.uvsgames.com';
const GAME = 'riftbound';
const UA = 'riftbound-tournois/1.0 (outil interne)';

export class LocatorError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------- Chiffrement du jeton (AES-256-GCM, clé dérivée du SESSION_SECRET) ----------

const secret = process.env.SESSION_SECRET || 'riftbound-nperf-interne';
const KEY = crypto.scryptSync(secret, 'riftbound-locator-token', 32);

export function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptToken(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---------- Appels HTTP ----------

async function call(path, { method = 'GET', body, token, scheme = 'Token' } = {}) {
  const headers = { accept: 'application/json', 'user-agent': UA, origin: 'https://locator.riftbound.uvsgames.com' };
  if (body) headers['content-type'] = 'application/json';
  if (token && scheme === 'Cookie') headers.cookie = `sessionid=${token}`;
  else if (token) headers.authorization = `${scheme} ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    let msg = json?.non_field_errors?.join(' ') || json?.message || json?.detail || `HTTP ${res.status}`;
    // Erreurs de validation (« Form is invalid ») : le détail par champ est dans `extra`.
    const extra = json?.extra && typeof json.extra === 'object' ? json.extra : null;
    const details = extra
      ? Object.entries(extra)
          .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
          .map(([k, v]) => `${k} : ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`)
      : [];
    if (details.length) msg += ` (${details.join(' ; ')})`;
    console.error(`[locator] ${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
    throw new LocatorError(msg, res.status);
  }
  return json;
}

/** Connexion : renvoie { token, scheme } (le schéma d'en-tête qui fonctionne : « Token » ou « Bearer »). */
export async function login(email, password) {
  const data = await call('/api/v2/auth/dj-rest-auth/login/', { method: 'POST', body: { email, password } });
  if (!data?.key) throw new LocatorError('Réponse de connexion inattendue (pas de jeton).');
  const token = data.key;
  // dj-rest-auth utilise « Token <key> » par défaut, certains déploiements « Bearer ». On détecte.
  for (const scheme of ['Token', 'Bearer']) {
    try {
      await call('/api/v2/auth/dj-rest-auth/user/', { token, scheme });
      return { token, scheme };
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err;
    }
  }
  throw new LocatorError('Jeton obtenu mais refusé par l’API (schéma d’authentification inconnu).');
}

/**
 * Vérifie un jeton collé à la main (clé API « Token »/« Bearer », ou valeur du cookie sessionid)
 * et renvoie { token, scheme, profile } avec le schéma qui fonctionne.
 */
export async function verifyToken(raw) {
  let token = String(raw || '').trim();
  token = token.replace(/^(Token|Bearer)\s+/i, '').replace(/^sessionid=/i, '').replace(/;.*$/, '').trim();
  if (!token) throw new LocatorError('Jeton vide.');
  let lastErr = null;
  for (const scheme of ['Token', 'Bearer', 'Cookie']) {
    try {
      const profile = await call('/api/v2/auth/dj-rest-auth/user/', { token, scheme });
      return { token, scheme, profile };
    } catch (err) {
      lastErr = err;
      if (err.status !== 401 && err.status !== 403) throw err;
    }
  }
  throw new LocatorError(`Jeton refusé par l’API (${lastErr?.message || 'non autorisé'}).`);
}

export async function logout(auth) {
  try {
    await call('/api/v2/auth/dj-rest-auth/logout/', { method: 'POST', body: {}, ...auth });
  } catch {
    // Best effort : on supprime le jeton localement dans tous les cas.
  }
}

export async function fetchProfile(auth) {
  return call('/api/v2/auth/dj-rest-auth/user/', auth);
}

export async function fetchStats(auth) {
  return call(`/api/v2/player/games/${GAME}/stats/`, auth);
}

/**
 * Historique complet des tournois (toutes les pages).
 * L'API valide les paramètres de requête (« Form is invalid » en 400) : on essaie plusieurs
 * variantes de pagination, de la plus efficace à la plus simple, et on garde celle qui passe.
 */
const HISTORY_QUERY_VARIANTS = [
  (page) => `?page=${page}&page_size=100`,
  (page) => `?page=${page}&page_size=20`,
  (page) => `?page=${page}`,
  () => '',
];

export async function fetchTournamentHistory(auth) {
  const all = [];
  const seen = new Set();
  let page = 1;
  let variant = null;
  for (let guard = 0; guard < 100; guard++) {
    let data = null;
    if (variant === null) {
      let lastErr = null;
      for (const v of HISTORY_QUERY_VARIANTS) {
        try {
          data = await call(`/api/v2/player/games/${GAME}/tournament-history/${v(page)}`, auth);
          variant = v;
          break;
        } catch (err) {
          lastErr = err;
          if (err.status !== 400) throw err; // 401/403/5xx : inutile d'insister
        }
      }
      if (variant === null) throw lastErr;
    } else {
      data = await call(`/api/v2/player/games/${GAME}/tournament-history/${variant(page)}`, auth);
    }
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    for (const r of results) {
      const key = r?.event_id ?? JSON.stringify(r);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(r);
    }
    const next = data?.next_page_number ?? (data?.has_next && data?.current_page_number ? data.current_page_number + 1 : null);
    if (!next || results.length === 0 || variant === HISTORY_QUERY_VARIANTS[3]) break;
    page = next;
  }
  return all;
}

/** Normalise un événement de l'historique locator en document pour la collection `external_events`. */
export function normalizeEvent(ev) {
  const matches = (ev.matches || []).map((m) => ({
    round: m.round_number,
    oppName: m.opponent_display_name || null,
    oppId: m.opponent_id ?? null,
    gamesWon: m.games_won ?? 0,
    gamesLost: m.games_lost ?? 0,
    outcome: m.is_bye ? 'bye' : m.is_draw ? 'draw' : m.is_winner ? 'win' : m.is_loss ? 'loss' : 'unknown',
  }));
  const deck = ev.deck
    ? {
        id: ev.deck.deck_id || ev.deck_id || null,
        name: ev.deck.deck_name || null,
        archetype: ev.deck.archetype_display_name || null,
        definingCard: ev.deck.deck_defining_card
          ? { name: ev.deck.deck_defining_card.name || null, image: ev.deck.deck_defining_card.image_url || null }
          : null,
      }
    : null;
  return {
    eventId: ev.event_id,
    name: ev.event_name,
    date: ev.event_date ? new Date(ev.event_date) : null,
    store: ev.store_name || null,
    format: ev.gameplay_format_name || null,
    finalPlace: ev.final_place ?? ev.current_rank ?? null,
    participants: ev.total_participants ?? null,
    wins: ev.matches_won ?? 0,
    losses: ev.matches_lost ?? 0,
    draws: ev.matches_drawn ?? 0,
    droppedAtRound: ev.dropped_at_round_number ?? null,
    status: ev.event_lifecycle_status || null,
    deck,
    matches,
  };
}
