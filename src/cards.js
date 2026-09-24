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
// v3 : `name` = nom complet imprimé (« Fiora, Peerless »), + `baseName` / `subtitle`.
// v4 : + `illustrator` (affiché dans le sélecteur de versions du deckbuilder).
const CATALOG_VERSION = 4;

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
  byBaseName: new Map(), // nom nu (« fiora ») -> cartes « Fiora, … », repli ambigu (voir lookup)
  byCode: new Map(), // code de collection court (« sfd-110a », voir codeKey) -> impression exacte
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

/**
 * Nom complet imprimé sur la carte, qui identifie la carte (toutes impressions confondues).
 * L'API sépare `name` (« Fiora ») et `subtitle` (« Peerless », « Victorious »…) : pour les unités,
 * le sous-titre fait partie du nom (« Fiora, Peerless » et « Fiora, Victorious » sont deux cartes
 * différentes). Pour les sorts « signature » et les légendes de starter, `subtitle` n'est qu'une
 * annotation (champion associé, « Starter ») et ne fait pas partie du nom.
 */
function fullName(c, types) {
  const subtitle = typeof c.subtitle === 'string' ? c.subtitle.trim() : '';
  return subtitle && types[0] === 'unit' ? `${c.name}, ${subtitle}` : c.name;
}

/**
 * Clé d'un code de collection, tolérante à la casse et au « /taille du set » :
 * « SFD-110a/221 », « SFD-110a », « sfd-110a » -> « sfd-110a » ; « VEN-189*\/166 » -> « ven-189* ».
 */
export function codeKey(code) {
  return String(code || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\/\d+$/, '');
}

/** Code de collection court d'une impression, tel qu'on l'écrit dans une decklist : « SFD-110a », « VEN-R04 ». */
export function shortCode(card) {
  return String(card?.publicCode || '').replace(/\/\d+$/, '');
}

// « Nom (CODE) » en fin de ligne (appliqué à une chaîne déjà trimEnd, sans `\s*` final : pas de retour arrière
// quadratique sur de longs blancs) : CODE = code de collection (« SFD-110a », « OGN-126/298 », « VEN-R04 »,
// « VEN-SP3 », « VEN-189* »). Le préfixe lettres du numéro (R, T, SP) va jusqu'à 2 caractères.
const TRAILING_CODE_RE = /^(.*)\(([A-Za-z]{2,4}-[A-Za-z]{0,2}\d+[a-z*]?(?:\/\d+)?)\)$/;

function slimCard(c) {
  const types = (c.cardType?.type || []).map((t) => t.id);
  return {
    id: c.id,
    name: fullName(c, types),
    baseName: c.name,
    subtitle: c.subtitle || null,
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
    // Illustrateur (« League Splash Team », « Six More Vodka »…), utile pour distinguer les versions.
    illustrator: c.illustrator?.values?.[0]?.label || null,
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
  const byBaseName = new Map();
  const byCode = new Map();
  for (const c of cards) {
    addIndex(byName, normalizeName(c.name), c);
    // Code de collection -> impression exacte (« 3 Fiora, Peerless (SFD-110a) » désigne l'art alternatif).
    const ck = codeKey(c.publicCode);
    if (ck && !byCode.has(ck)) byCode.set(ck, c);
    // Les légendes s'appellent « Rogue Assassin » avec le tag « Akali » ;
    // les decklists écrivent « Akali, Rogue Assassin ».
    if (c.type === 'legend') {
      for (const tag of c.tags) addIndex(byName, normalizeName(`${tag}, ${c.name}`), c);
    }
    // « Fiora » seul (sans sous-titre) : repli ambigu vers l'une des cartes « Fiora, … »,
    // uniquement si aucune carte ne porte exactement ce nom.
    if (c.baseName && c.baseName !== c.name) addIndex(byBaseName, normalizeName(c.baseName), c);
  }
  for (const key of byBaseName.keys()) if (byName.has(key)) byBaseName.delete(key);
  // Départage déterministe (l'ordre de l'API varie d'un chargement à l'autre).
  const byRank = (a, b) => rankCard(a) - rankCard(b) || String(a.publicCode).localeCompare(String(b.publicCode));
  for (const list of byName.values()) list.sort(byRank);
  for (const list of byBaseName.values()) list.sort(byRank);
  return { byName, byBaseName, byCode };
}

function setCards(cards, fetchedAt, source, meta) {
  state.cards = cards;
  if (meta) state.meta = meta;
  ({ byName: state.byName, byBaseName: state.byBaseName, byCode: state.byCode } = buildIndex(cards));
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

const RETRY_MS = 10 * 60 * 1000; // nouvel essai API quand on tourne sur un cache d'ancienne version

export async function initCatalog(db) {
  state.db = db;
  let outdated = null; // cache d'une version antérieure : repli si l'API est injoignable au démarrage
  try {
    const cached = await db.collection('cards_catalog').findOne({ _id: 'catalog' });
    if (cached?.cards?.length && cached.version === CATALOG_VERSION) {
      setCards(cached.cards, cached.fetchedAt, 'cache', cached.meta);
      console.log(`Catalogue Riftbound : ${cached.cards.length} cartes depuis le cache (${cached.fetchedAt.toISOString()}).`);
    } else if (cached?.cards?.length) {
      outdated = cached;
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
  if (state.cards.length === 0 && outdated) {
    // API injoignable et cache d'une ancienne forme : mieux vaut un catalogue un peu daté que rien du tout.
    // Les champs ajoutés depuis (`illustrator`, `baseName`…) peuvent manquer : le code les traite comme absents.
    setCards(outdated.cards, outdated.fetchedAt, 'cache-outdated', outdated.meta);
    console.warn(`Catalogue Riftbound : API injoignable, cache v${outdated.version ?? 1} utilisé (${outdated.cards.length} cartes) ; nouvel essai dans ${RETRY_MS / 60000} min.`);
    const retry = async () => {
      await refreshCatalog();
      if (state.source !== 'api') setTimeout(retry, RETRY_MS).unref();
    };
    setTimeout(retry, RETRY_MS).unref();
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

/**
 * Résolution d'un nom de carte : `{ card, ambiguous, candidates }` ou null.
 * `ambiguous` = la carte a été choisie par repli sur le nom nu (« Fiora » -> « Fiora, Victorious »
 * parmi Peerless / Victorious / Worthy) ; `candidates` liste alors les noms complets possibles.
 * Un suffixe « (CODE) » (« Fiora, Peerless (SFD-110a) ») désigne une impression précise (art alternatif,
 * showcase, réimpression) : c'est elle qui est renvoyée, si le code est connu et correspond bien au nom
 * écrit ; sinon le suffixe est ignoré et le nom seul est résolu (impression de base).
 * Les objets carte du catalogue ne sont jamais modifiés.
 */
function lookup(name, { type } = {}) {
  // Borne de sécurité (un nom réel fait < 120 caractères) : les regex ci-dessous restent linéaires.
  name = String(name || '').trim().slice(0, 300);
  const coded = TRAILING_CODE_RE.exec(name);
  if (coded) {
    const printing = state.byCode.get(codeKey(coded[2]));
    const written = coded[1].trim();
    if (printing && (!type || printing.type === type)) {
      // Le nom écrit doit désigner la même carte (garde-fou contre un code recopié de travers) : nom complet,
      // alias de légende (« Akali, Rogue Assassin »), ou nom nu ambigu (« Ahri (OGN-119a) ») dont l'impression
      // fait partie des candidates — le code lève alors l'ambiguïté.
      const byWrittenName = written ? lookup(written, { type }) : null;
      const sameCard =
        !written ||
        (byWrittenName && byWrittenName.card.name === printing.name) ||
        (byWrittenName && byWrittenName.ambiguous && (byWrittenName.candidates || []).includes(printing.name)) ||
        (printing.baseName && normalizeName(printing.baseName) === normalizeName(written));
      if (sameCard) return { card: printing, ambiguous: false };
    }
  }
  const key = normalizeName(name);
  if (!key) return null;
  const filtered = (list) => (list && type ? list.filter((c) => c.type === type) : list) || [];
  const exact = (k) => {
    const list = filtered(state.byName.get(k));
    return list.length ? { card: list[0], ambiguous: false } : null;
  };
  const fallback = (k) => {
    const list = filtered(state.byBaseName.get(k));
    if (!list.length) return null;
    const candidates = [...new Set(list.map((c) => c.name))];
    return { card: list[0], ambiguous: candidates.length > 1, candidates };
  };
  let hit = exact(key);
  if (hit) return hit;
  // « Nom (précision) » / « Fiora, Peerless (SFD-110) » -> « Fiora, Peerless », avant tout repli ambigu
  // (sur le nom brut : normalizeName remplace les parenthèses par des espaces, le suffixe ne serait plus repérable).
  // Regex sans `\s*` de tête sur une chaîne déjà trim : pas de retour arrière quadratique.
  const noParen = name.replace(/\([^)]*\)$/, '').trimEnd();
  if (noParen && noParen !== name) return lookup(noParen, { type });
  if (key.includes(',')) {
    // « Akali, Rogue Assassin » -> « Rogue Assassin » (légendes).
    const after = key.split(',').slice(1).join(',').trim();
    hit = exact(after);
    if (hit && hit.card.type === 'legend') return hit;
    // Ou l'inverse : un sous-titre inconnu (« Fiora, Victorius ») -> repli sur « Fiora ».
    const before = key.split(',')[0].trim();
    hit = exact(before) || fallback(before);
    if (hit) return hit;
  }
  // Nom nu d'une carte à sous-titre (« Fiora ») : repli ambigu vers « Fiora, … ».
  return fallback(key);
}

export function findCard(name, opts) {
  return lookup(name, opts)?.card || null;
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
 * Tolère « 3x Nom », « Nom x3 », les en-têtes FR/EN avec ou sans « : », les lignes sans en-tête (-> deck principal)
 * et un code de collection en suffixe « 3 Fiora, Peerless (SFD-110a) » (impression précise, conservé dans `name`).
 */
export function parseDecklist(text) {
  const sections = new Map(SECTIONS.map((s) => [s.key, []]));
  let current = 'main';
  for (const raw of String(text || '').split(/\r?\n/)) {
    // Une vraie ligne ne dépasse pas ~120 caractères : on borne avant toute regex (retour arrière quadratique
    // sur de longues suites de blancs, sinon ~0,5 s CPU par ligne de 20 000 caractères).
    const line = raw.trim().slice(0, 200);
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
    // Un code de collection entre parenthèses (« Fiora, Peerless (SFD-110a) ») est conservé : il désigne
    // l'impression exacte (art alternatif…) et est compris par lookup(). Il reste dans le nom pour survivre
    // à un aller-retour serializeDecklist (side deck) et être affiché tel quel si la carte est inconnue.
    name = name.trim();
    if (!name) continue;
    // Légende / champion : une seule carte ; le surplus part dans le deck principal.
    const target = (current === 'legend' || current === 'champion') && sections.get(current).length ? 'main' : current;
    sections.get(target).push({ qty: Math.max(1, qty || 1), name });
  }
  return SECTIONS.map((s) => ({ key: s.key, label: s.label, cards: sections.get(s.key) }));
}

const DOMAIN_LABELS = { fury: 'Fury', calm: 'Calm', mind: 'Mind', body: 'Body', chaos: 'Chaos', order: 'Order' };

/** Impression préférée (de base) d'un nom de carte : celle que renvoie `findCard(nom)`. */
function preferredPrinting(card) {
  const list = state.byName.get(normalizeName(card.name));
  return list && list.length ? list[0] : card;
}

/**
 * Résout une decklist texte. Chaque ligne : `{ qty, name, card }` (+ `ambiguous: true` et
 * `candidates: [noms complets]` quand le nom écrit sans sous-titre a été rattaché par repli à l'une
 * de plusieurs cartes, ex. « 3 Fiora » ; + `alt: true` quand l'impression résolue n'est pas l'impression
 * préférée de la carte, ex. « Fiora, Peerless (SFD-110a) » — une carte qui n'existe qu'en jeton « -t## »
 * n'est donc pas « alternative »). `unknown` / `ambiguous` = nombre de lignes concernées.
 */
export function resolveDecklist(text) {
  const parsed = parseDecklist(text);
  let unknown = 0;
  let ambiguous = 0;
  let total = 0;
  const sections = parsed
    .map((s) => {
      const cards = s.cards.map((line) => {
        const hit = lookup(line.name, { type: DEFAULT_TYPE_FOR_SECTION[s.key] }) || lookup(line.name);
        const card = hit?.card || null;
        if (!card) unknown++;
        if (hit?.ambiguous) ambiguous++;
        const out = hit?.ambiguous ? { ...line, card, ambiguous: true, candidates: hit.candidates } : { ...line, card };
        if (card && preferredPrinting(card).id !== card.id) out.alt = true;
        return out;
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
    ambiguous,
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

/** Libellé d'une impression alternative d'après son identifiant, sa rareté et l'impression principale. */
function variantLabel(c, primary) {
  if (c.rarity === 'showcase') return 'Showcase';
  if (/-star-/.test(c.id)) return 'Étoile';
  if (/^[a-z]+-\d+a-\d+$/.test(c.id)) return 'Art alternatif';
  if (/-sp\d/.test(c.id) || /-t\d+$/.test(c.id)) return 'Promo';
  // « VEN-187/166 » : numéro au-delà de la taille du set = tirage alternatif de fin de set.
  const m = /^[A-Z]+-(\d+)\/(\d+)$/.exec(c.publicCode || '');
  if (m && Number(m[1]) > Number(m[2])) return 'Art alternatif';
  // Même carte dans un autre set (« VEN-R04 » = Body Rune du set Vendetta) : réimpression.
  if (primary && primary.set !== c.set) return 'Réimpression';
  return 'Variante';
}

/**
 * Catalogue pour le deckbuilder : toutes les impressions avec image (sans les jetons, cartes sans type),
 * dont une « principale » par nom complet (`primary: true`, impression de base préférée) ; les autres
 * sont des variantes (`variant: true`, `variantOf` = id de la principale, `variantLabel`). `shortCode` = code
 * court (« SFD-110a ») que le client ajoute au nom dans l'export pour désigner une variante.
 * Le regroupement se fait sur `name` (nom complet, sous-titre inclus pour les unités) : « Fiora, Peerless »
 * et « Fiora, Victorious » sont deux cartes distinctes, « Fiora, Peerless » SFD-110 et SFD-110a une seule.
 * Le résultat est mémorisé jusqu'au prochain rafraîchissement du catalogue.
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
      illustrator: c.illustrator || null,
      // Code court à écrire dans une decklist pour désigner cette impression (« SFD-110a »).
      shortCode: shortCode(c),
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

const SECTION_HEADER = { legend: 'Legend', champion: 'Champion', main: 'MainDeck', battlefields: 'Battlefields', runes: 'Runes', sideboard: 'Sideboard' };

/** Recompose un texte de decklist à partir des sections de parseDecklist (lignes « qty nom »). */
export function serializeDecklist(sections) {
  return sections
    .filter((s) => s.cards.length > 0)
    .map((s) => `${SECTION_HEADER[s.key] || s.key}:\n` + s.cards.map((c) => `${c.qty} ${c.name}`).join('\n'))
    .join('\n\n');
}

/**
 * Applique un side deck à une decklist : `out` quitte le deck principal pour la réserve,
 * `in` quitte la réserve pour le deck principal. Renvoie le nouveau texte.
 */
export function applySiding(text, { out = [], in: inn = [] }) {
  const sections = parseDecklist(text);
  const get = (key) => sections.find((s) => s.key === key).cards;
  // Même carte écrite différemment : nom exact, ou même carte du catalogue (code de collection, tag de
  // légende…), ou nom nu d'un ancien side deck (« Fiora ») face au nom complet du deck (« Fiora, Peerless »).
  const sameLine = (a, b) => {
    if (normalizeName(a) === normalizeName(b)) return true;
    const ca = findCard(a);
    const cb = findCard(b);
    if (ca && cb && ca.name === cb.name) return true;
    const bare = (card, other) => !!card && card.baseName !== card.name && normalizeName(card.baseName) === normalizeName(other);
    return bare(ca, b) || bare(cb, a);
  };
  // Toutes les lignes désignant la même carte, nom exact d'abord : un deck peut mélanger plusieurs impressions
  // (« 2 Akali, Deadly Weapon (VEN-021a) » + « 1 Akali, Deadly Weapon »), le side doit pouvoir les vider toutes.
  const findLines = (lines, name) => {
    const exact = lines.filter((l) => normalizeName(l.name) === normalizeName(name));
    return [...exact, ...lines.filter((l) => !exact.includes(l) && sameLine(l.name, name))];
  };
  // Ligne de destination où fusionner : même nom écrit ; sinon même carte, mais seulement si aucune des deux
  // lignes ne porte de code d'impression (un « (VEN-021a) » sorti du deck reste une ligne à part en réserve,
  // sans se fondre dans le « Akali, Deadly Weapon » de base déjà présent — et inversement).
  const hasCode = (name) => TRAILING_CODE_RE.test(String(name).trimEnd());
  const findDst = (lines, name) =>
    lines.find((l) => normalizeName(l.name) === normalizeName(name)) ||
    (hasCode(name) ? null : lines.find((l) => !hasCode(l.name) && sameLine(l.name, name)));
  const move = (from, to, list) => {
    for (const c of list) {
      const sources = findLines(from, c.name);
      if (!sources.length) {
        // Carte absente de la source (side saisi à la main) : on la crée quand même à destination.
        const dst = findDst(to, c.name);
        if (dst) dst.qty += c.qty;
        else to.push({ qty: c.qty, name: c.name });
        continue;
      }
      let remaining = c.qty;
      for (const src of sources) {
        if (remaining <= 0) break;
        const qty = Math.min(remaining, src.qty);
        if (qty <= 0) continue;
        src.qty -= qty;
        remaining -= qty;
        // Destination cherchée avec le nom de la ligne source (complet, code compris) : « Fiora » sorti de
        // « Fiora, Peerless » ne doit pas fusionner avec un « Fiora, Victorious » déjà en réserve.
        const dst = findDst(to, src.name);
        if (dst) dst.qty += qty;
        else to.push({ qty, name: src.name });
      }
    }
    for (let i = from.length - 1; i >= 0; i--) if (from[i].qty <= 0) from.splice(i, 1);
  };
  move(get('main'), get('sideboard'), out);
  move(get('sideboard'), get('main'), inn);
  return serializeDecklist(sections);
}
