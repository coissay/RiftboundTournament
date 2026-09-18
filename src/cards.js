// Catalogue de cartes Riftbound + parseur de decklist.
//
// Source : l'API de contenu Riot qui alimente https://playriftbound.com/fr-fr/card-gallery/
// (pas d'API "officielle" documentée, mais la galerie charge ses cartes depuis cet endpoint public).
// Le catalogue est gardé en mémoire et mis en cache dans Mongo (collection `cards_catalog`)
// pour démarrer même sans réseau, puis rafraîchi périodiquement.

const API_BASE = 'https://content.publishing.riotgames.com';
const API_PATH = '/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards';
const LOCALE = process.env.CARDS_LOCALE || 'en_US';
const REFRESH_MS = 24 * 3600 * 1000;
// À incrémenter quand la forme des cartes/méta stockées change : force un rechargement depuis l'API.
const CATALOG_VERSION = 2;

export const SECTIONS = [
  { key: 'legend', label: 'Légende', headers: ['legend', 'legende', 'légende'] },
  { key: 'champion', label: 'Champion', headers: ['champion', 'champions', 'chosen champion'] },
  { key: 'main', label: 'Deck principal', headers: ['maindeck', 'main deck', 'main', 'deck', 'deck principal', 'principal'] },
  { key: 'battlefields', label: 'Champs de bataille', headers: ['battlefields', 'battlefield', 'champs de bataille', 'champ de bataille'] },
  { key: 'runes', label: 'Runes', headers: ['runes', 'rune', 'rune deck', 'runedeck'] },
  { key: 'sideboard', label: 'Réserve (Sideboard)', headers: ['sideboard', 'side', 'reserve', 'réserve'] },
];

const state = {
  cards: [],
  meta: { domains: [], types: [], rarities: [], sets: [] },
  byName: new Map(),
  fetchedAt: null,
  source: null,
  error: null,
  db: null,
};

// ---------- Normalisation / index ----------

export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`´]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9',\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slimCard(c) {
  const types = (c.cardType?.type || []).map((t) => t.id);
  return {
    id: c.id,
    name: c.name,
    publicCode: c.publicCode,
    set: c.set?.value?.id || null,
    collectorNumber: c.collectorNumber ?? null,
    type: types[0] || null,
    types,
    domains: (c.domain?.values || []).map((d) => d.id),
    image: c.cardImage?.url || null,
    orientation: c.orientation || 'portrait',
    tags: c.tags?.tags || [],
    rarity: c.rarity?.value?.id || null,
    energy: c.energy?.value ?? c.energy ?? null,
    might: c.might?.value ?? c.might ?? null,
    power: c.power?.value ?? c.power ?? null,
    // Impression « de base » (ni alternative "a", ni "star", ni promo) : préférée à l'affichage.
    base: /^[a-z]+-\d+-\d+$/.test(c.id),
  };
}

function rankCard(c) {
  // Plus petit = préféré.
  return (c.base ? 0 : 10) + (c.image ? 0 : 5);
}

function addIndex(map, key, card) {
  if (!key) return;
  const list = map.get(key) || [];
  list.push(card);
  map.set(key, list);
}

function buildIndex(cards) {
  const byName = new Map();
  for (const c of cards) {
    addIndex(byName, normalizeName(c.name), c);
    // Les légendes s'appellent « Rogue Assassin » avec le tag « Akali » ;
    // les decklists écrivent « Akali, Rogue Assassin ».
    if (c.type === 'legend') {
      for (const tag of c.tags) addIndex(byName, normalizeName(`${tag}, ${c.name}`), c);
    }
  }
  for (const list of byName.values()) list.sort((a, b) => rankCard(a) - rankCard(b));
  return byName;
}

function setCards(cards, fetchedAt, source, meta) {
  state.cards = cards;
  if (meta) state.meta = meta;
  state.byName = buildIndex(cards);
  state.fetchedAt = fetchedAt;
  state.source = source;
}

// ---------- Chargement ----------

/** Extrait les référentiels (domaines, types, raretés, sets) avec leurs icônes officielles. */
function collectMeta(rawCards) {
  const domains = new Map();
  const types = new Map();
  const rarities = new Map();
  const sets = new Map();
  for (const c of rawCards) {
    for (const d of c.domain?.values || []) {
      if (!domains.has(d.id)) domains.set(d.id, { id: d.id, label: d.label, icon: d.icon?.url || null, color: d.icon?.colors?.secondary || null });
    }
    for (const t of c.cardType?.type || []) if (!types.has(t.id)) types.set(t.id, { id: t.id, label: t.label, icon: t.icon?.url || null });
    const r = c.rarity?.value;
    if (r && !rarities.has(r.id)) rarities.set(r.id, { id: r.id, label: r.label, icon: r.icon?.url || null });
    const st = c.set?.value;
    if (st && !sets.has(st.id)) sets.set(st.id, { id: st.id, label: st.label });
  }
  const DOMAIN_ORDER = ['fury', 'calm', 'mind', 'body', 'chaos', 'order', 'colorless'];
  const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'showcase'];
  return {
    domains: [...domains.values()].sort((a, b) => DOMAIN_ORDER.indexOf(a.id) - DOMAIN_ORDER.indexOf(b.id)),
    types: [...types.values()],
    rarities: [...rarities.values()].sort((a, b) => RARITY_ORDER.indexOf(a.id) - RARITY_ORDER.indexOf(b.id)),
    sets: [...sets.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function fetchAllFromApi() {
  const all = [];
  const raw = [];
  let url = `${API_BASE}${API_PATH}?locale=${encodeURIComponent(LOCALE)}&from=0&limit=1200`;
  for (let guard = 0; url && guard < 20; guard++) {
    const res = await fetch(url, { headers: { 'user-agent': 'riftbound-tournois/1.0', accept: 'application/json' } });
    if (!res.ok) throw new Error(`API cartes : HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error('API cartes : réponse inattendue');
    raw.push(...json.data);
    all.push(...json.data.map(slimCard));
    const next = json.linkdata?.next;
    url = next && next !== json.linkdata?.self && all.length < (json.metadata?.totalItems || Infinity) ? `${API_BASE}${next}` : null;
  }
  if (all.length < 100) throw new Error(`API cartes : seulement ${all.length} cartes reçues`);
  return { cards: all, meta: collectMeta(raw) };
}

export async function refreshCatalog() {
  try {
    const { cards, meta } = await fetchAllFromApi();
    const fetchedAt = new Date();
    setCards(cards, fetchedAt, 'api', meta);
    state.error = null;
    if (state.db) {
      await state.db
        .collection('cards_catalog')
        .updateOne({ _id: 'catalog' }, { $set: { fetchedAt, cards, meta, version: CATALOG_VERSION } }, { upsert: true });
    }
    console.log(`Catalogue Riftbound : ${cards.length} cartes chargées depuis l'API.`);
  } catch (err) {
    state.error = err.message;
    console.error('Catalogue Riftbound : échec du rafraîchissement —', err.message);
  }
}

export async function initCatalog(db) {
  state.db = db;
  try {
    const cached = await db.collection('cards_catalog').findOne({ _id: 'catalog' });
    if (cached?.cards?.length && cached.version === CATALOG_VERSION) {
      setCards(cached.cards, cached.fetchedAt, 'cache', cached.meta);
      console.log(`Catalogue Riftbound : ${cached.cards.length} cartes depuis le cache (${cached.fetchedAt.toISOString()}).`);
    }
  } catch (err) {
    console.error('Catalogue Riftbound : cache illisible —', err.message);
  }
  const stale = !state.fetchedAt || Date.now() - state.fetchedAt.getTime() > REFRESH_MS;
  if (stale) {
    // Sans catalogue du tout, on attend l'API (quelques secondes) ; sinon on rafraîchit en arrière-plan.
    if (state.cards.length === 0) await refreshCatalog();
    else refreshCatalog();
  }
  setInterval(refreshCatalog, REFRESH_MS).unref();
}

export function catalogStatus() {
  return { count: state.cards.length, fetchedAt: state.fetchedAt, source: state.source, error: state.error };
}

/** Référentiels (domaines, types, raretés, sets) avec icônes officielles. */
export function catalogMeta() {
  return state.meta;
}

// ---------- Recherche ----------

export function findCard(name, { type } = {}) {
  const key = normalizeName(name);
  if (!key) return null;
  const pick = (list) => {
    if (!list || !list.length) return null;
    if (type) return list.find((c) => c.type === type) || null;
    return list[0];
  };
  let hit = pick(state.byName.get(key));
  if (hit) return hit;
  // « Akali, Rogue Assassin » -> « Rogue Assassin » (légendes) ; « Nom (précision) » -> « Nom ».
  if (key.includes(',')) {
    const after = key.split(',').slice(1).join(',').trim();
    hit = pick(state.byName.get(after));
    if (hit && hit.type === 'legend') return hit;
    // Ou l'inverse : un nom écrit sans son sous-titre.
    const before = key.split(',')[0].trim();
    hit = pick(state.byName.get(before));
    if (hit) return hit;
  }
  const noParen = key.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (noParen !== key) return pick(state.byName.get(noParen));
  return null;
}

export function searchCards(query, limit = 20) {
  const q = normalizeName(query);
  if (!q) return [];
  const seen = new Set();
  const out = [];
  for (const c of state.cards) {
    if (seen.has(c.name)) continue;
    if (normalizeName(c.name).includes(q)) {
      seen.add(c.name);
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---------- Decklist ----------

const HEADER_TO_KEY = new Map();
for (const s of SECTIONS) for (const h of s.headers) HEADER_TO_KEY.set(normalizeName(h), s.key);

const DEFAULT_TYPE_FOR_SECTION = { legend: 'legend', battlefields: 'battlefield', runes: 'rune' };

/**
 * Parse une decklist texte (format export Riftbound) :
 *   Legend:\n1 Akali, Rogue Assassin\n\nMainDeck:\n3 Noxus Hopeful ...
 * Tolère « 3x Nom », « Nom x3 », les en-têtes FR/EN avec ou sans « : », et les lignes sans en-tête (-> deck principal).
 */
export function parseDecklist(text) {
  const sections = new Map(SECTIONS.map((s) => [s.key, []]));
  let current = 'main';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      // Une ligne vide clôt la section légende/champion (une seule carte chacune).
      if (current === 'legend' || current === 'champion') current = 'main';
      continue;
    }
    if (line.startsWith('#') || line.startsWith('//')) continue;
    const header = line.match(/^([^\d].*?)\s*:\s*$/) || (!/\d/.test(line) && HEADER_TO_KEY.has(normalizeName(line)) ? [line, line] : null);
    if (header && HEADER_TO_KEY.has(normalizeName(header[1]))) {
      current = HEADER_TO_KEY.get(normalizeName(header[1]));
      continue;
    }
    let qty = 1;
    let name = line;
    let m = line.match(/^(\d+)\s*[xX×]?\s+(.+)$/);
    if (m) {
      qty = parseInt(m[1], 10);
      name = m[2];
    } else if ((m = line.match(/^(.+?)\s+[xX×]\s*(\d+)$/))) {
      qty = parseInt(m[2], 10);
      name = m[1];
    }
    name = name.replace(/\s*\([A-Z]{2,4}-\d+[^)]*\)\s*$/, '').trim(); // code de collection éventuel
    if (!name) continue;
    // Légende / champion : une seule carte ; le surplus part dans le deck principal.
    const target = (current === 'legend' || current === 'champion') && sections.get(current).length ? 'main' : current;
    sections.get(target).push({ qty: Math.max(1, qty || 1), name });
  }
  return SECTIONS.map((s) => ({ key: s.key, label: s.label, cards: sections.get(s.key) }));
}

const DOMAIN_LABELS = { fury: 'Fury', calm: 'Calm', mind: 'Mind', body: 'Body', chaos: 'Chaos', order: 'Order' };

export function resolveDecklist(text) {
  const parsed = parseDecklist(text);
  let unknown = 0;
  let total = 0;
  const sections = parsed
    .map((s) => {
      const cards = s.cards.map((line) => {
        const card = findCard(line.name, { type: DEFAULT_TYPE_FOR_SECTION[s.key] }) || findCard(line.name);
        if (!card) unknown++;
        return { ...line, card };
      });
      const count = cards.reduce((n, c) => n + c.qty, 0);
      if (s.key !== 'sideboard') total += count;
      return { ...s, cards, count };
    })
    .filter((s) => s.cards.length > 0);

  const legendLine = sections.find((s) => s.key === 'legend')?.cards[0] || null;
  const legendCard = legendLine?.card || null;
  const championLine = sections.find((s) => s.key === 'champion')?.cards[0] || null;

  // Domaines : ceux de la légende, sinon ceux des runes.
  let domainIds = legendCard?.domains || [];
  if (!domainIds.length) {
    const set = new Set();
    for (const l of sections.find((s) => s.key === 'runes')?.cards || []) for (const d of l.card?.domains || []) set.add(d);
    domainIds = [...set];
  }
  const domains = domainIds.map((d) => DOMAIN_LABELS[d]).filter(Boolean);

  const battlefields = (sections.find((s) => s.key === 'battlefields')?.cards || []).map((l) => l.card?.name || l.name);

  return {
    sections,
    total,
    unknown,
    empty: sections.length === 0,
    legend: legendLine ? legendCard && legendCard.tags.length ? `${legendCard.tags[0]}, ${legendCard.name}` : legendLine.name : '',
    legendCard,
    champion: championLine ? championLine.card?.name || championLine.name : '',
    championCard: championLine?.card || null,
    domains,
    battlefields,
  };
}

/** Miniature : le CDN Sanity accepte un paramètre de largeur. */
export function thumb(url, width = 300) {
  if (!url) return null;
  return url.includes('?') ? `${url}&w=${width}&auto=format` : `${url}?w=${width}&auto=format`;
}

// ---------- Catalogue pour le client (deckbuilder) ----------

/** L'API renvoie energy/might/power sous la forme `{ id, label }` : on ramène ça à un nombre (ou null). */
function numericValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') v = v.label ?? v.id;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

let clientCatalogCache = { fetchedAt: null, cards: null };

/**
 * Catalogue allégé pour le deckbuilder côté client : une seule impression par nom (l'impression
 * « de base » de préférence), sans les jetons (cartes sans type) ni les cartes sans image.
 * Le résultat est mémorisé jusqu'au prochain rafraîchissement du catalogue.
 */
/** Libellé d'une impression alternative d'après son identifiant, sa rareté et l'impression principale. */
function variantLabel(c, primary) {
  if (c.rarity === 'showcase') return 'Showcase';
  if (/-star-/.test(c.id)) return 'Étoile';
  if (/^[a-z]+-\d+a-\d+$/.test(c.id)) return 'Art alternatif';
  if (/-sp\d/.test(c.id) || /-(r|t)\d+$/.test(c.id)) return 'Promo';
  // « VEN-187/166 » : numéro au-delà de la taille du set = tirage alternatif de fin de set.
  const m = /^[A-Z]+-(\d+)\/(\d+)$/.exec(c.publicCode || '');
  if (m && Number(m[1]) > Number(m[2])) return 'Art alternatif';
  if (primary && primary.set !== c.set) return 'Réimpression';
  return 'Variante';
}

/**
 * Catalogue pour le deckbuilder : toutes les impressions avec image, dont une « principale » par nom
 * (`primary: true`, impression de base préférée) ; les autres sont des variantes (`variant: true`,
 * `variantOf` = id de la principale, `variantLabel`).
 */
export function catalogForClient() {
  if (clientCatalogCache.cards && clientCatalogCache.fetchedAt === state.fetchedAt) return clientCatalogCache.cards;
  const primaryByName = new Map();
  const usable = state.cards.filter((c) => c.type && c.image);
  for (const c of usable) {
    const key = normalizeName(c.name);
    const prev = primaryByName.get(key);
    const better =
      !prev ||
      rankCard(c) < rankCard(prev) ||
      (rankCard(c) === rankCard(prev) && String(c.publicCode) < String(prev.publicCode));
    if (better) primaryByName.set(key, c);
  }
  const seen = new Set();
  const cards = [];
  for (const c of usable) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const primary = primaryByName.get(normalizeName(c.name));
    const isPrimary = primary.id === c.id;
    cards.push({
      id: c.id,
      name: c.name,
      publicCode: c.publicCode,
      set: c.set,
      collectorNumber: c.collectorNumber,
      type: c.type,
      domains: c.domains,
      rarity: c.rarity || null,
      image: c.image,
      orientation: c.orientation,
      tags: c.tags,
      energy: numericValue(c.energy),
      might: numericValue(c.might),
      power: numericValue(c.power),
      primary: isPrimary,
      variant: !isPrimary,
      variantOf: isPrimary ? null : primary.id,
      variantLabel: isPrimary ? null : variantLabel(c, primary),
    });
  }
  cards.sort((a, b) => a.name.localeCompare(b.name, 'en') || (a.primary ? -1 : b.primary ? 1 : 0) || String(a.publicCode).localeCompare(String(b.publicCode)));
  clientCatalogCache = { fetchedAt: state.fetchedAt, cards };
  return cards;
}

/** Image (et orientation) d'une carte par son nom, pour les noms textuels survolables. Null si inconnue. */
export function cardImageByName(name) {
  const card = findCard(name);
  if (!card || !card.image) return null;
  return { image: card.image, landscape: card.type === 'battlefield' };
}
