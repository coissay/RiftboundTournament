// Deckbuilder Riftbound : galerie de cartes filtrable (catalogue chargé depuis /api/cards)
// + deck en construction par sections, conservé dans localStorage, exporté au format decklist du projet.
//
// Les fonctions pures (filtrage, tri, export, validation) sont regroupées dans `Core`, aussi exposé en
// CommonJS pour être testées avec Node sans DOM (voir le bloc `module.exports` en bas de fichier).

(function (root) {
  'use strict';

  // ---------- Constantes ----------

  const SECTION_ORDER = ['legend', 'champion', 'main', 'battlefields', 'runes', 'sideboard'];
  const SECTIONS = {
    legend: { label: 'Légende', header: 'Legend', target: 1 },
    champion: { label: 'Champion', header: 'Champion', target: 1 },
    main: { label: 'Deck principal', header: 'MainDeck', target: 40 },
    battlefields: { label: 'Champs de bataille', header: 'Battlefields', target: 3 },
    runes: { label: 'Runes', header: 'Runes', target: 12 },
    sideboard: { label: 'Réserve', header: 'Sideboard', target: null },
  };
  const MAX_COPIES = 3; // exemplaires max d'une même carte (hors runes)
  const TYPE_LABELS = { unit: 'Unité', spell: 'Sort', gear: 'Équipement', rune: 'Rune', legend: 'Légende', battlefield: 'Champ de bataille' };
  const STORAGE_KEY = 'riftbound.deckbuilder.v1';
  const PAGE_SIZE = 120; // vignettes affichées avant « Afficher plus »

  // ---------- Fonctions pures ----------

  const Core = {
    /** Même normalisation que côté serveur : accents, apostrophes typographiques, casse. */
    normalize(s) {
      return String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[’`´]/g, "'")
        .toLowerCase()
        .replace(/[^a-z0-9',\- ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    /** Section de destination par défaut selon le type de carte. */
    sectionForType(type) {
      if (type === 'legend') return 'legend';
      if (type === 'battlefield') return 'battlefields';
      if (type === 'rune') return 'runes';
      return 'main';
    },

    emptyDeck() {
      return {
        deckId: null, // id Mongo si on édite un deck existant
        name: '',
        notes: '',
        domains: [], // domaines forcés à la main (formulaire classique), conservés à la mise à jour
        sections: { legend: [], champion: [], main: [], battlefields: [], runes: [], sideboard: [] },
      };
    },

    /** Code de collection court d'une impression : « SFD-110a/221 » → « SFD-110a » (idem shortCode côté serveur). */
    shortCode(card) {
      return card.shortCode || String(card.publicCode || '').replace(/\/\d+$/, '');
    },

    /**
     * Nom tel qu'il doit apparaître dans une decklist : « Akali, Rogue Assassin » pour les légendes.
     * Une impression alternative (art alternatif, showcase, réimpression) porte son code de collection en
     * suffixe, « Fiora, Peerless (SFD-110a) », que le serveur résout vers cette impression exacte ;
     * l'impression principale garde le nom nu.
     */
    exportName(card) {
      const base = card.type === 'legend' && card.tags && card.tags.length ? `${card.tags[0]}, ${card.name}` : card.name;
      const code = card.variant ? Core.shortCode(card) : '';
      return code ? `${base} (${code})` : base;
    },

    /** Identifiant de « famille » d'une carte : son impression principale (les variantes partagent la même). */
    familyOf(card) {
      return card ? card.variantOf || card.id : null;
    },

    /** Nombre d'exemplaires d'une même carte (toutes impressions) dans les sections données. */
    copiesOf(deck, family, byId, sections) {
      let n = 0;
      for (const key of sections) {
        for (const e of deck.sections[key]) {
          const c = e.id ? byId.get(e.id) : null;
          if (c && Core.familyOf(c) === family) n += e.qty;
        }
      }
      return n;
    },

    /**
     * Règles bloquantes à l'ajout d'un exemplaire dans `section`.
     * Renvoie null si OK, sinon le message d'erreur.
     */
    canAdd(deck, card, section, byId) {
      const s = deck.sections;
      const family = Core.familyOf(card);
      if (section === 'legend') return card.type === 'legend' ? null : 'Seule une carte Légende peut être la légende.';
      if (section === 'champion') {
        if (card.type !== 'unit') return 'Le champion doit être une unité.';
      }
      if (section === 'battlefields') {
        if (card.type !== 'battlefield') return 'Seuls les champs de bataille vont dans cette section.';
        if (Core.copiesOf(deck, family, byId, ['battlefields']) >= 1) return 'Un même champ de bataille ne peut être joué qu\'une fois.';
        if (Core.count(s.battlefields) >= 3) return 'Maximum 3 champs de bataille.';
        return null;
      }
      if (section === 'runes') {
        if (card.type !== 'rune') return 'Seules les runes vont dans cette section.';
        if (Core.count(s.runes) >= 12) return 'Maximum 12 runes.';
        return null;
      }
      if (card.type === 'legend' || card.type === 'battlefield' || card.type === 'rune') {
        return `Une carte ${TYPE_LABELS[card.type].toLowerCase()} ne va pas dans ${section === 'sideboard' ? 'la réserve' : 'le deck principal'}.`;
      }
      // Deck principal / champion / réserve : 3 exemplaires max d'une même carte, toutes sections et impressions confondues.
      if (Core.copiesOf(deck, family, byId, ['main', 'champion', 'sideboard']) >= MAX_COPIES) {
        return `Maximum ${MAX_COPIES} exemplaires de « ${card.name} » (deck principal, champion et réserve confondus).`;
      }
      if (section === 'main' && Core.count(s.main) + Core.count(s.champion) >= 40) return 'Le deck principal est complet (40 cartes, champion inclus).';
      return null;
    },

    /**
     * Fait passer tous les exemplaires d'une carte (toutes sections, toutes impressions) à l'impression `newId`.
     * Renvoie le nombre d'exemplaires concernés (0 si la carte n'est pas dans le deck).
     */
    swapFamily(deck, family, newId, byId) {
      const n = Core.copiesOf(deck, family, byId, SECTION_ORDER);
      if (!n) return 0;
      for (const key of SECTION_ORDER) {
        // Copie de la liste : swapPrinting peut fusionner (et donc retirer) des entrées en cours de parcours.
        for (const e of deck.sections[key].slice()) {
          const c = e.id ? byId.get(e.id) : null;
          if (c && Core.familyOf(c) === family && e.id !== newId) Core.swapPrinting(deck, key, Core.entryKey(e), newId);
        }
      }
      return n;
    },

    /** Change l'impression d'une entrée (même carte, autre version). Fusionne si la version existe déjà dans la section. */
    swapPrinting(deck, section, key, newId) {
      const list = deck.sections[section];
      const idx = list.findIndex((e) => Core.entryKey(e) === key);
      if (idx < 0) return false;
      const entry = list[idx];
      if (entry.id === newId) return false;
      const existing = list.find((e) => e.id === newId);
      if (existing) {
        existing.qty += entry.qty;
        list.splice(idx, 1);
      } else {
        entry.id = newId;
      }
      return true;
    },

    /** Clé d'identification d'une entrée (carte connue → id, inconnue → nom). */
    entryKey(entry) {
      return entry.id ? entry.id : 'name:' + Core.normalize(entry.name);
    },

    /** Clé de recherche : normalisation + suppression des apostrophes, virgules et tirets (« zauns » trouve « Zaun's »). */
    searchKey(s) {
      return Core.normalize(s).replace(/['\-,]/g, '');
    },

    /** Types de carte couverts par chaque onglet (« all » = tous). */
    TAB_TYPES: { legend: ['legend'], main: ['unit', 'spell', 'gear'], battlefields: ['battlefield'], runes: ['rune'] },

    /** Une plage [min,max] est « neutre » quand elle couvre tout l'intervalle possible. */
    rangeActive(range, bounds) {
      return !!range && (range[0] > bounds[0] || range[1] < bounds[1]);
    },

    /**
     * Filtre le catalogue. `f` = { tab, text, domains: [], type, set, rarity, energy: [min,max], power, might, variants }.
     * `variants` (bool) : inclure les impressions alternatives (art alternatif, showcase, promo).
     * `bounds` = { energy: [0,12], power: [0,4], might: [0,10] } (plages neutres).
     * Domaines : la carte est gardée si elle possède au moins un des domaines cochés.
     */
    filterCards(cards, f, bounds) {
      bounds = bounds || { energy: [0, 12], power: [0, 4], might: [0, 10] };
      const q = Core.searchKey(f.text);
      const domains = f.domains && f.domains.length ? new Set(f.domains) : null;
      const tabTypes = f.tab && f.tab !== 'all' ? Core.TAB_TYPES[f.tab] : null;
      const ranges = ['energy', 'power', 'might'].filter((k) => Core.rangeActive(f[k], bounds[k]));
      return cards.filter((c) => {
        if (c.variant && !f.variants) return false;
        if (tabTypes && !tabTypes.includes(c.type)) return false;
        if (f.type && c.type !== f.type) return false;
        if (f.set && c.set !== f.set) return false;
        if (f.rarity && c.rarity !== f.rarity) return false;
        for (const k of ranges) {
          if (c[k] == null || c[k] < f[k][0] || c[k] > f[k][1]) return false;
        }
        if (domains && !c.domains.some((d) => domains.has(d))) return false;
        if (q) {
          const hay = c._search || (c._search = Core.searchKey([c.name, ...(c.tags || []), c.publicCode].join(' ')));
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    },

    sortCards(cards, mode) {
      const byName = (a, b) => a.name.localeCompare(b.name, 'en');
      const list = cards.slice();
      if (mode === 'energy') {
        list.sort((a, b) => {
          const ea = a.energy == null ? 99 : a.energy;
          const eb = b.energy == null ? 99 : b.energy;
          return ea - eb || byName(a, b);
        });
      } else if (mode === 'set') {
        list.sort((a, b) => String(a.set).localeCompare(String(b.set)) || (a.collectorNumber || 0) - (b.collectorNumber || 0) || byName(a, b));
      } else {
        list.sort(byName);
      }
      return list;
    },

    /** Nombre de cartes d'une section. */
    count(entries) {
      return entries.reduce((n, e) => n + e.qty, 0);
    },

    /** Ajoute `qty` exemplaires d'une carte dans une section (légende/champion : remplace). */
    add(deck, card, section, qty) {
      qty = qty || 1;
      const list = deck.sections[section];
      if (section === 'legend' || section === 'champion') {
        list.length = 0;
        list.push({ id: card.id, name: card.name, qty: 1 });
        return;
      }
      const hit = list.find((e) => e.id === card.id);
      if (hit) hit.qty += qty;
      else list.push({ id: card.id, name: card.name, qty });
    },

    /** Retire `qty` exemplaires (par clé d'entrée) ; supprime la ligne à zéro. */
    remove(deck, key, section, qty) {
      qty = qty || 1;
      const list = deck.sections[section];
      const idx = list.findIndex((e) => Core.entryKey(e) === key);
      if (idx < 0) return false;
      list[idx].qty -= qty;
      if (list[idx].qty <= 0) list.splice(idx, 1);
      return true;
    },

    /** Quantité totale d'une carte dans le deck (hors réserve), pour l'affichage dans la galerie. */
    qtyInDeck(deck, id, byId) {
      // Une variante et son impression principale comptent ensemble.
      const card = byId ? byId.get(id) : null;
      const family = card ? card.variantOf || card.id : id;
      const sameFamily = (eid) => {
        if (eid === id) return true;
        const c = byId ? byId.get(eid) : null;
        return !!c && (c.variantOf || c.id) === family;
      };
      let n = 0;
      for (const key of SECTION_ORDER) {
        if (key === 'sideboard') continue;
        for (const e of deck.sections[key]) if (e.id && sameFamily(e.id)) n += e.qty;
      }
      return n;
    },

    /**
     * Definit le champion. Si la carte vient du deck principal, un exemplaire y est déplacé ;
     * l'ancien champion (s'il existe) retourne dans le deck principal.
     */
    setChampion(deck, card, fromMain) {
      const prev = deck.sections.champion[0];
      if (prev && prev.id === card.id) return;
      if (prev) Core.add(deck, prev, 'main', 1);
      if (fromMain) Core.remove(deck, card.id, 'main', 1);
      Core.add(deck, card, 'champion', 1);
    },

    /** Génère la decklist texte au format attendu par parseDecklist() côté serveur. */
    buildExport(deck, byId) {
      const blocks = [];
      for (const key of SECTION_ORDER) {
        const entries = deck.sections[key];
        if (!entries.length) continue;
        const lines = entries.map((e) => {
          const card = e.id ? byId.get(e.id) : null;
          return `${e.qty} ${card ? Core.exportName(card) : e.name}`;
        });
        blocks.push(`${SECTIONS[key].header}:\n${lines.join('\n')}`);
      }
      return blocks.join('\n\n');
    },

    /** Reconstruit les sections à partir de la réponse de /api/decklist/resolve. */
    fromResolved(resolvedSections) {
      const deck = Core.emptyDeck();
      for (const s of resolvedSections || []) {
        const list = deck.sections[s.key];
        if (!list) continue;
        for (const line of s.cards) {
          const entry = { id: line.cardId || null, name: line.name, qty: line.qty };
          const hit = list.find((e) => Core.entryKey(e) === Core.entryKey(entry));
          if (hit) hit.qty += entry.qty;
          else list.push(entry);
        }
      }
      return deck.sections;
    },

    /**
     * Rappels des règles Riftbound (jamais bloquants) :
     * légende 1, champion 1, deck principal 40 (champion inclus), champs de bataille 3, runes 12,
     * max 3 exemplaires d'une même carte hors runes, cartes hors domaines de la légende.
     */
    validate(deck, byId) {
      const s = deck.sections;
      const mainCount = Core.count(s.main) + Core.count(s.champion);
      const checks = [
        { key: 'legend', label: 'Légende', value: Core.count(s.legend), target: 1 },
        { key: 'champion', label: 'Champion', value: Core.count(s.champion), target: 1 },
        { key: 'main', label: 'Deck principal', value: mainCount, target: 40, hint: 'champion inclus' },
        { key: 'battlefields', label: 'Champs de bataille', value: Core.count(s.battlefields), target: 3 },
        { key: 'runes', label: 'Runes', value: Core.count(s.runes), target: 12 },
      ].map((c) => ({ ...c, ok: c.value === c.target }));

      // Exemplaires : champion + deck principal + réserve, par nom de carte (toutes impressions confondues).
      const copies = new Map(); // famille (ou clé) → total
      const famKey = (e) => {
        const c = e.id ? byId.get(e.id) : null;
        return c ? Core.familyOf(c) : Core.entryKey(e);
      };
      for (const e of [...s.champion, ...s.main, ...s.sideboard]) copies.set(famKey(e), (copies.get(famKey(e)) || 0) + e.qty);
      const over = [];
      const overKeys = [];
      for (const e of [...s.champion, ...s.main, ...s.sideboard]) {
        if (copies.get(famKey(e)) > MAX_COPIES) {
          if (!over.includes(e.name)) over.push(e.name);
          overKeys.push(Core.entryKey(e));
        }
      }
      checks.push({ key: 'copies', label: `Max ${MAX_COPIES} exemplaires`, ok: over.length === 0, detail: over, wide: true });

      // Domaines : les cartes du deck (champion, principal, runes) doivent rester dans ceux de la légende.
      const legend = s.legend[0] && s.legend[0].id ? byId.get(s.legend[0].id) : null;
      if (legend) {
        const allowed = new Set(legend.domains);
        const off = [];
        for (const e of [...s.champion, ...s.main, ...s.runes]) {
          const card = e.id ? byId.get(e.id) : null;
          if (!card) continue;
          if (card.domains.some((d) => d !== 'colorless' && !allowed.has(d)) && !off.includes(card.name)) off.push(card.name);
        }
        checks.push({ key: 'domains', label: 'Domaines de la légende', ok: off.length === 0, detail: off, wide: true });
      }
      return { checks, overKeys };
    },
  };

  // Export CommonJS pour les tests Node ; dans le navigateur on continue avec l'interface.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Core, SECTIONS, SECTION_ORDER, MAX_COPIES };
    return;
  }
  if (typeof document === 'undefined') return;

  // ---------- Interface ----------

  const $ = (id) => document.getElementById(id);
  const els = {
    search: $('db-search'), type: $('db-type'), set: $('db-set'), rarity: $('db-rarity'), sort: $('db-sort'), variants: $('db-variants'),
    domainChips: Array.from(document.querySelectorAll('.db-domain-btn[data-domain]')),
    tabs: Array.from(document.querySelectorAll('.db-tab[data-tab]')),
    targets: Array.from(document.querySelectorAll('.db-target-btn[data-target]')),
    drawer: $('db-drawer'), filtersToggle: $('db-filters-toggle'), filterBadge: $('db-filter-badge'), activeFilters: $('db-active-filters'),
    ranges: Array.from(document.querySelectorAll('.db-range[data-range]')),
    legendDomains: $('db-legend-domains'), resetFilters: $('db-reset-filters'), resultCount: $('db-result-count'),
    grid: $('db-grid'), more: $('db-more'),
    name: $('db-name'), source: $('db-deck-source'), rules: $('db-rules'), sections: $('db-sections'),
    save: $('db-save'), update: $('db-update'), import: $('db-import'), clear: $('db-clear'),
    copy: $('db-copy'), exportText: $('db-export-text'),
    importDialog: $('db-import-dialog'), importText: $('db-import-text'), importGo: $('db-import-go'), importError: $('db-import-error'),
    updateForm: $('db-update-form'), updateDomains: $('db-update-domains'),
    actions: $('db-actions'), mobileBar: $('db-mobile-bar'), mobileCounters: $('db-mobile-counters'), mobileDot: $('db-mobile-dot'), mobileJump: $('db-mobile-jump'),
  };
  if (!els.grid) return;

  // Pointeur : le clic droit n'existe qu'à la souris (un appui long tactile ne doit pas retirer une carte) ;
  // sur mobile (≤ 960 px) le panneau deck passe sous la galerie (sections repliables + barre de résumé).
  const mq = (q) => (window.matchMedia ? window.matchMedia(q) : null);
  const finePointer = () => { const m = mq('(pointer: fine)'); return !m || m.matches; };
  const isMobileLayout = () => { const m = mq('(max-width: 960px)'); return !!m && m.matches; };
  const collapsed = new Set(); // sections repliées par l'utilisateur sur mobile (l'état survit aux re-rendus)

  let catalog = []; // cartes du catalogue client
  const byId = new Map();
  const families = new Map(); // id principal → toutes les impressions (principale d'abord)
  let deck = Core.emptyDeck();
  let filtered = []; // résultat courant du filtrage
  let shown = PAGE_SIZE; // nombre de vignettes affichées
  const BOUNDS = { energy: [0, 12], power: [0, 4], might: [0, 10] };
  const RANGE_LABELS = { energy: 'Énergie', power: 'Puissance', might: 'Force' };
  const filters = { tab: 'legend', text: '', domains: [], type: '', set: '', rarity: '', energy: [0, 12], power: [0, 4], might: [0, 10], variants: false, sort: 'name' };
  let addTarget = 'deck'; // 'deck' | 'sideboard' | 'champion'

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const thumbUrl = (url, w) => (url.includes('?') ? `${url}&w=${w}&auto=format` : `${url}?w=${w}&auto=format`);

  // ---------- Persistance ----------

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(deck));
    } catch (e) {
      /* stockage indisponible : on continue sans persistance */
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!saved || !saved.sections) return null;
      const d = Core.emptyDeck();
      Object.assign(d, { deckId: saved.deckId || null, name: saved.name || '', notes: saved.notes || '', domains: saved.domains || [] });
      for (const key of SECTION_ORDER) if (Array.isArray(saved.sections[key])) d.sections[key] = saved.sections[key];
      return d;
    } catch (e) {
      return null;
    }
  }

  /** Charge un deck existant fourni par le serveur (?deck=<id>). */
  function loadInit(init) {
    const d = Core.emptyDeck();
    d.deckId = init.id;
    d.name = init.name || '';
    d.notes = init.notes || '';
    d.domains = init.domains || [];
    d.sections = Core.fromResolved(init.sections);
    warnAmbiguous(init.sections);
    return d;
  }

  // ---------- Rendu : galerie ----------

  function applyFilters() {
    filtered = Core.sortCards(Core.filterCards(catalog, filters, BOUNDS), filters.sort);
    shown = PAGE_SIZE;
    renderGallery();
    renderActiveFilters();
  }

  /** Résumé des filtres actifs (hors onglet et texte) + badge sur le bouton « Filtres ». */
  function renderActiveFilters() {
    const parts = [];
    if (filters.domains.length) parts.push('domaines : ' + filters.domains.join(', '));
    if (filters.set) parts.push('extension ' + filters.set);
    if (filters.type) parts.push('type ' + (TYPE_LABELS[filters.type] || filters.type).toLowerCase());
    if (filters.rarity) parts.push('rareté ' + filters.rarity);
    if (filters.variants) parts.push('versions alternatives');
    for (const k of ['energy', 'power', 'might']) {
      if (Core.rangeActive(filters[k], BOUNDS[k])) parts.push(`${RANGE_LABELS[k].toLowerCase()} ${filters[k][0]}–${filters[k][1]}`);
    }
    els.activeFilters.textContent = parts.length ? parts.join(' · ') : 'aucun';
    els.filterBadge.hidden = parts.length === 0;
    els.filterBadge.textContent = parts.length;
  }

  /** Toutes les impressions d'une carte (principale d'abord). */
  function printingsOf(card) {
    return families.get(Core.familyOf(card)) || [card];
  }

  /** Libellé du « + » de la galerie selon la cible « Ajouter à » et la carte (deck / réserve / champion). */
  function addLabelFor(card) {
    if (addTarget === 'sideboard' && card.type !== 'legend' && card.type !== 'battlefield' && card.type !== 'rune') return 'Ajouter à la réserve';
    if (addTarget === 'champion' && card.type === 'unit') return 'Définir comme champion';
    return 'Ajouter au deck';
  }

  /** Bouton « N versions » posé sur la vignette (galerie) : ouvre le sélecteur d'illustration. */
  function versionsBadgeHtml(c) {
    const n = printingsOf(c).length;
    if (n < 2) return '';
    const label = `${n} versions`;
    return `<button type="button" class="db-versions-badge" data-act="versions" aria-haspopup="dialog" aria-label="${esc(label)} de ${esc(c.name)} : choisir l'illustration" title="${esc(label)} : choisir l'illustration">🎨 ${n} versions</button>`;
  }

  /**
   * Compteur « − [qté] + » : moins à gauche, plus à droite, quantité au milieu quand > 0.
   * `plus` false = pas de bouton + (légende / champion : un seul exemplaire).
   */
  function stepperHtml(name, qty, { dec, inc, plus = true, addLabel = 'Ajouter un exemplaire' } = {}) {
    return `
      <span class="db-stepper" role="group" aria-label="Exemplaires de ${esc(name)}">
        <button type="button" data-act="${dec}" aria-label="Retirer un exemplaire de ${esc(name)}" title="Retirer un exemplaire">−</button>
        <span class="db-stepper-qty" aria-live="polite">${qty ? qty : ''}</span>
        ${plus ? `<button type="button" data-act="${inc}" aria-label="${esc(addLabel)} : ${esc(name)}" title="${esc(addLabel)}">+</button>` : ''}
      </span>`;
  }

  function cardHtml(c) {
    const qty = Core.qtyInDeck(deck, c.id, byId);
    const landscape = c.orientation === 'landscape';
    const canChampion = c.type === 'unit';
    const canSide = c.type !== 'legend' && c.type !== 'battlefield' && c.type !== 'rune';
    const secondary = [
      canChampion ? `<button type="button" data-act="champion" aria-label="Définir ${esc(c.name)} comme champion" title="Définir comme champion">★</button>` : '',
      canSide ? `<button type="button" data-act="side" aria-label="Ajouter ${esc(c.name)} à la réserve" title="Ajouter à la réserve">R</button>` : '',
    ].join('');
    return `
      <article class="db-card${qty ? ' in-deck' : ''}" data-id="${esc(c.id)}">
        <div class="card-thumb${landscape ? ' card-thumb-landscape' : ''}" data-full="${esc(c.image)}" role="img" aria-label="${esc(c.name)} · ${esc(c.publicCode)} · ${esc(TYPE_LABELS[c.type] || c.type)}" title="${esc(c.name)} · ${esc(c.publicCode)} · ${esc(TYPE_LABELS[c.type] || c.type)}${c.illustrator ? ' · ' + esc(c.illustrator) : ''}">
          <img src="${esc(thumbUrl(c.image, 250))}" alt="${esc(c.name)}" loading="lazy">
          ${c.energy != null ? `<span class="db-energy">${c.energy}</span>` : ''}
          ${c.variant ? `<span class="db-variant" title="Impression alternative · ${esc(c.publicCode)}">${esc(c.variantLabel || 'Variante')}</span>` : ''}
          ${versionsBadgeHtml(c)}
          ${qty ? `<span class="qty">×${qty}</span>` : ''}
        </div>
        <div class="db-card-name">${esc(c.name)}</div>
        <div class="db-card-actions">
          ${stepperHtml(c.name, qty, { dec: 'remove', inc: 'add', addLabel: addLabelFor(c) })}
          ${secondary ? `<span class="db-actions-sep" aria-hidden="true"></span>${secondary}` : ''}
        </div>
      </article>`;
  }

  function renderGallery() {
    const slice = filtered.slice(0, shown);
    els.grid.innerHTML = slice.length ? slice.map(cardHtml).join('') : '<div class="db-empty">Aucune carte ne correspond aux filtres.</div>';
    els.resultCount.textContent = `${filtered.length} carte${filtered.length > 1 ? 's' : ''}`;
    const rest = filtered.length - shown;
    els.more.hidden = rest <= 0;
    els.more.textContent = `Afficher plus (${rest} restante${rest > 1 ? 's' : ''})`;
  }

  /** Cible « Ajouter à » changée : libellés des « + » de la galerie et indice visuel (data-target → CSS). */
  function refreshAddTargetHints() {
    els.grid.dataset.target = addTarget;
    for (const art of els.grid.querySelectorAll('.db-card')) {
      const card = byId.get(art.dataset.id);
      const btn = art.querySelector('button[data-act="add"]');
      if (!card || !btn) continue;
      const label = addLabelFor(card);
      btn.title = label;
      btn.setAttribute('aria-label', `${label} : ${card.name}`);
    }
  }

  /** Met à jour uniquement les compteurs ×N et « − N + » de la galerie (évite de recharger toutes les images). */
  function refreshGalleryQuantities() {
    for (const art of els.grid.querySelectorAll('.db-card')) {
      const qty = Core.qtyInDeck(deck, art.dataset.id, byId);
      art.classList.toggle('in-deck', qty > 0);
      const stepQty = art.querySelector('.db-stepper-qty');
      if (stepQty) stepQty.textContent = qty ? String(qty) : '';
      let badge = art.querySelector('.qty');
      if (qty && !badge) {
        badge = document.createElement('span');
        badge.className = 'qty';
        art.querySelector('.card-thumb').appendChild(badge);
      }
      if (badge) {
        if (qty) badge.textContent = `×${qty}`;
        else badge.remove();
      }
    }
  }

  // ---------- Rendu : panneau deck ----------

  function lineHtml(e, section, overKeys) {
    const card = e.id ? byId.get(e.id) : null;
    const key = Core.entryKey(e);
    const single = section === 'legend' || section === 'champion';
    const over = overKeys.includes(key);
    const thumb = card
      ? `<span class="card-thumb db-line-thumb${card.orientation === 'landscape' ? ' card-thumb-landscape' : ''}" data-full="${esc(card.image)}"><img src="${esc(thumbUrl(card.image, 120))}" alt=""></span>`
      : '<span class="db-line-unknown" title="Carte non reconnue dans le catalogue">?</span>';
    const displayName = card ? (card.type === 'legend' && card.tags && card.tags.length ? `${card.tags[0]}, ${card.name}` : card.name) : e.name;
    const name = card
      ? `${esc(displayName)}${card.variant ? `<small class="db-line-variant" title="${esc(card.publicCode)}">${esc(card.variantLabel || 'Variante')}</small>` : ''}${card.energy != null ? `<small>${card.energy}</small>` : ''}`
      : `<span class="warn">⚠ ${esc(e.name)}</span>`;
    const nbVersions = card ? printingsOf(card).length : 0;
    const versionsBtn = nbVersions > 1 ? `<button type="button" class="db-line-versions" data-act="versions" aria-haspopup="dialog" aria-label="Changer l'illustration de ${esc(displayName)} (${nbVersions} versions)" title="Changer d'illustration (${nbVersions} versions)">🎨</button>` : '';
    const championBtn = section === 'main' && card && card.type === 'unit' ? `<button type="button" data-act="champion" aria-label="Définir ${esc(displayName)} comme champion" title="Définir comme champion (déplace 1 exemplaire)">★</button>` : '';
    const sideBtn = section === 'main'
      ? `<button type="button" data-act="to-side" aria-label="Déplacer un exemplaire de ${esc(displayName)} en réserve" title="Déplacer 1 exemplaire en réserve">R</button>`
      : section === 'sideboard' ? `<button type="button" data-act="to-main" aria-label="Déplacer un exemplaire de ${esc(displayName)} dans le deck principal" title="Déplacer 1 exemplaire dans le deck principal">↑</button>` : '';
    const secondary = `${versionsBtn}${championBtn}${sideBtn}`;
    return `
      <li class="db-line${over ? ' over' : ''}" data-section="${section}" data-key="${esc(key)}">
        ${thumb}
        <span class="db-line-name" title="${esc(card ? card.publicCode : e.name)}" aria-label="${esc(displayName)}${card ? ' · ' + esc(card.publicCode) : ' (carte non reconnue)'}">${name}</span>
        ${stepperHtml(displayName, e.qty, { dec: 'dec', inc: 'inc', plus: !single })}
        ${secondary ? `<span class="db-actions-sep" aria-hidden="true"></span>${secondary}` : ''}
      </li>`;
  }

  function sortEntries(entries, section) {
    const list = entries.slice();
    list.sort((a, b) => {
      const ca = a.id ? byId.get(a.id) : null;
      const cb = b.id ? byId.get(b.id) : null;
      if (section === 'main' || section === 'sideboard') {
        const ea = ca && ca.energy != null ? ca.energy : 99;
        const eb = cb && cb.energy != null ? cb.energy : 99;
        if (ea !== eb) return ea - eb;
      }
      return (ca ? ca.name : a.name).localeCompare(cb ? cb.name : b.name, 'en');
    });
    return list;
  }

  function renderDeck() {
    const { checks, overKeys } = Core.validate(deck, byId);

    // Rappels de règles.
    els.rules.innerHTML = checks
      .map((c) => {
        const cls = c.ok ? 'ok' : 'ko';
        if (c.target != null) {
          return `<li title="${esc(c.hint || '')}"><span>${esc(c.label)}${c.hint ? '*' : ''}</span><span class="${cls}">${c.value} / ${c.target}</span></li>`;
        }
        const detail = c.detail && c.detail.length ? ` <small>· ${esc(c.detail.join(', '))}</small>` : '';
        return `<li class="wide"><span>${esc(c.label)}${detail}</span><span class="${cls}">${c.ok ? '✓' : '⚠'}</span></li>`;
      })
      .join('');

    // Sections.
    els.sections.innerHTML = SECTION_ORDER.map((key) => {
      const meta = SECTIONS[key];
      const entries = sortEntries(deck.sections[key], key);
      const n = Core.count(entries);
      const check = checks.find((c) => c.key === key);
      let counter = `${n}`;
      let cls = '';
      if (check) {
        counter = `${check.value} / ${check.target}`;
        cls = check.ok ? 'ok' : 'ko';
      }
      const legendTag = key === 'legend' && entries[0] && entries[0].id && byId.get(entries[0].id) && byId.get(entries[0].id).tags.length ? byId.get(entries[0].id).tags[0] : '';
      const legendHelp = legendTag
        ? `<button type="button" class="db-icon-btn" data-act="search-tag" data-tag="${esc(legendTag)}" aria-label="Chercher les cartes « ${esc(legendTag)} » dans la galerie" title="Chercher les cartes « ${esc(legendTag)} » dans la galerie">🔍 ${esc(legendTag)}</button>`
        : '';
      const head = `<h3><span>${esc(meta.label)} ${legendHelp}${key === 'main' ? '<small>(champion inclus)</small>' : ''}</span><span class="db-count ${cls}">${counter}</span></h3>`;
      const body = `<ul>${entries.length ? entries.map((e) => lineHtml(e, key, overKeys)).join('') : `<li class="db-section-empty">${key === 'sideboard' ? 'Aucune carte en réserve.' : 'Vide — clique sur une carte de la galerie.'}</li>`}</ul>`;
      // Mobile : section repliable (<details>), état mémorisé dans `collapsed` ; desktop : section simple.
      if (isMobileLayout()) {
        return `<details class="db-section" data-section="${key}"${collapsed.has(key) ? '' : ' open'}><summary>${head}</summary>${body}</details>`;
      }
      return `<section class="db-section" data-section="${key}">${head}${body}</section>`;
    }).join('');

    // Export texte, boutons. Deck existant : « Mettre à jour » est l'action principale (dorée, en tête), « nouveau deck » secondaire.
    els.exportText.value = Core.buildExport(deck, byId);
    els.name.value = deck.name;
    els.update.hidden = !deck.deckId;
    els.save.textContent = deck.deckId ? 'Enregistrer comme nouveau deck' : 'Enregistrer comme deck';
    els.save.className = deck.deckId ? 'btn btn-ghost' : 'btn btn-gold';
    els.update.className = 'btn btn-gold';
    renderMobileBar(checks);
    els.source.hidden = !deck.deckId;
    if (deck.deckId) els.source.innerHTML = `Deck existant chargé : <a href="/decks/${esc(deck.deckId)}">voir la fiche</a>`;

    // Bouton « Domaines de la légende » dans les filtres.
    const legend = deck.sections.legend[0] && deck.sections.legend[0].id ? byId.get(deck.sections.legend[0].id) : null;
    els.legendDomains.hidden = !legend;

    refreshGalleryQuantities();
    saveState();
  }

  // ---------- Actions ----------

  // ---------- Barre de résumé mobile ----------

  const MOBILE_COUNTERS = [['main', 'Principal'], ['runes', 'Runes'], ['battlefields', 'CB']];
  let deckInView = false;

  /** Compteurs « Principal 12/40 · Runes 0/12 · CB 1/3 » + point de légalité, d'après les mêmes contrôles que le panneau. */
  function renderMobileBar(checks) {
    if (!els.mobileBar) return;
    const parts = MOBILE_COUNTERS.map(([key, label]) => {
      const c = checks.find((x) => x.key === key);
      return c ? `${label} ${c.value}/${c.target}` : null;
    }).filter(Boolean);
    els.mobileCounters.textContent = parts.join(' · ');
    const ok = checks.every((c) => c.ok);
    els.mobileDot.classList.toggle('ok', ok);
    els.mobileBar.title = ok ? 'Deck conforme' : 'Deck incomplet ou non conforme (voir les rappels de règles)';
    els.mobileCounters.setAttribute('aria-label', `${parts.join(', ')} — ${ok ? 'deck conforme' : 'deck non conforme'}`);
  }

  function renderMobileJump() {
    if (!els.mobileJump) return;
    els.mobileJump.textContent = deckInView ? 'Galerie ▼' : 'Voir le deck ▲';
    els.mobileJump.setAttribute('aria-label', deckInView ? 'Revenir à la galerie de cartes' : 'Aller au panneau du deck');
  }

  if (els.mobileJump) {
    els.mobileJump.addEventListener('click', () => {
      if (deckInView) window.scrollTo({ top: 0, behavior: 'smooth' });
      else document.getElementById('db-deck').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    if ('IntersectionObserver' in window) {
      const deckEl = document.getElementById('db-deck');
      new IntersectionObserver((entries) => {
        for (const e of entries) deckInView = e.isIntersecting;
        renderMobileJump();
      }, { threshold: 0.15 }).observe(deckEl);
    }
    renderMobileJump();
  }
  // Passage desktop ↔ mobile (rotation, redimensionnement) : re-rendre le panneau (sections repliables ou non).
  const mobileMq = mq('(max-width: 960px)');
  if (mobileMq && mobileMq.addEventListener) mobileMq.addEventListener('change', () => renderDeck());
  // État replié/déplié des sections mobiles (toggle ne remonte pas : écoute en phase de capture).
  els.sections.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d || d.tagName !== 'DETAILS' || !d.dataset.section) return;
    if (d.open) collapsed.delete(d.dataset.section);
    else collapsed.add(d.dataset.section);
  }, true);

  // ---------- Toast (refus ⛔ = rouge, avertissement ⚠ = ambre, sinon info neutre) ----------

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('db-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'db-toast';
      el.className = 'db-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    const text = String(msg);
    el.classList.remove('warn', 'info');
    if (text.startsWith('⚠')) el.classList.add('warn');
    else if (!text.startsWith('⛔')) el.classList.add('info');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), text.length > 80 ? 4500 : 2600);
  }

  /** Ajoute un exemplaire en respectant les règles (sinon message et refus). */
  function addCard(card, section) {
    section = section || Core.sectionForType(card.type);
    const err = Core.canAdd(deck, card, section, byId);
    if (err) {
      toast('⛔ ' + err);
      return false;
    }
    Core.add(deck, card, section, 1);
    renderDeck();
    return true;
  }

  /** Définit le champion en respectant la limite d'exemplaires. */
  function setChampion(card, fromMain) {
    if (card.type !== 'unit') return toast('⛔ Le champion doit être une unité.');
    const prev = deck.sections.champion[0];
    if (prev && prev.id === card.id) return;
    // Depuis la galerie : on ajoute un exemplaire → vérifier la limite. Depuis le deck principal : on déplace, pas de nouvel exemplaire.
    if (!fromMain && Core.copiesOf(deck, Core.familyOf(card), byId, ['main', 'champion', 'sideboard']) >= MAX_COPIES) {
      return toast(`⛔ Maximum ${MAX_COPIES} exemplaires de « ${card.name} ». Utilise ★ depuis la ligne du deck principal pour déplacer un exemplaire.`);
    }
    Core.setChampion(deck, card, fromMain);
    renderDeck();
  }

  // ---------- Sélecteur de versions (illustrations alternatives) ----------

  let versionsEl = null;
  let versionsAnchor = null; // bouton qui a ouvert le sélecteur : reprend le focus à la fermeture
  function closeVersions() {
    if (!versionsEl) return;
    const hadFocus = versionsEl.contains(document.activeElement);
    versionsEl.remove();
    versionsEl = null;
    if (hadFocus && versionsAnchor && document.body.contains(versionsAnchor)) versionsAnchor.focus();
    versionsAnchor = null;
  }

  /** Impression(s) de la carte actuellement dans le deck (toutes sections), pour surligner la version utilisée. */
  function printingsInDeck(card) {
    const family = Core.familyOf(card);
    const used = new Set();
    for (const key of SECTION_ORDER) for (const e of deck.sections[key]) {
      const c = e.id ? byId.get(e.id) : null;
      if (c && Core.familyOf(c) === family) used.add(c.id);
    }
    return used;
  }

  /**
   * Ouvre le choix des impressions d'une carte près de `anchor` (boîte de dialogue légère : boutons,
   * Échap ferme, focus sur la version utilisée puis retour sur `anchor`).
   * `onPick(card)` est appelé avec l'impression choisie.
   */
  function openVersions(card, anchor, onPick) {
    closeVersions();
    const list = printingsOf(card);
    const used = printingsInDeck(card);
    // Sans exemplaire dans le deck, la version « courante » est celle cliquée.
    const current = used.size ? used : new Set([card.id]);
    document.dispatchEvent(new CustomEvent('card-popover:hide')); // le zoom au survol ne doit pas recouvrir le sélecteur
    versionsAnchor = anchor && anchor.focus ? anchor : null;
    versionsEl = document.createElement('div');
    versionsEl.className = 'db-versions';
    versionsEl.setAttribute('role', 'dialog');
    versionsEl.setAttribute('aria-label', `Versions de ${card.name}`);
    versionsEl.setAttribute('data-popover-avoid', ''); // le zoom des versions se place à côté, jamais dessus
    const item = (p) => {
      const isCurrent = current.has(p.id);
      const label = p.primary ? 'Standard' : p.variantLabel || 'Variante';
      const set = p.set ? `${p.set} · ${Core.shortCode(p)}` : Core.shortCode(p);
      const aria = `${label}, ${set}${p.illustrator ? ', ' + p.illustrator : ''}${isCurrent ? ' (version utilisée)' : ''}`;
      return `
          <button type="button" class="db-version${isCurrent ? ' current' : ''}" data-id="${esc(p.id)}" aria-pressed="${isCurrent}" aria-label="${esc(aria)}" title="${esc(used.size ? 'Utiliser cette illustration pour tous les exemplaires' : 'Ajouter avec cette illustration')}">
            <span class="card-thumb${p.orientation === 'landscape' ? ' card-thumb-landscape' : ''}" data-full="${esc(p.image)}"><img src="${esc(thumbUrl(p.image, 160))}" alt=""></span>
            <span class="db-version-label"><b>${esc(label)}</b><small>${esc(set)}</small>${p.illustrator ? `<small class="db-version-artist">${esc(p.illustrator)}</small>` : ''}${isCurrent ? '<small class="db-version-current">✓ utilisée</small>' : ''}</span>
          </button>`;
    };
    versionsEl.innerHTML = `
      <div class="db-versions-head"><span>Versions de <b>${esc(card.name)}</b> <small class="muted">${used.size ? '· remplace tous les exemplaires du deck' : '· ajoute avec cette illustration'}</small></span><button type="button" class="db-icon-btn" data-close aria-label="Fermer" title="Fermer">×</button></div>
      <div class="db-versions-list">${list.map(item).join('')}</div>`;
    document.body.appendChild(versionsEl);
    // Position : sous l'ancre, recalée dans la fenêtre.
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, window.innerWidth - 16);
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    versionsEl.style.width = w + 'px';
    versionsEl.style.left = left + 'px';
    versionsEl.style.top = top + 'px';
    const h = versionsEl.offsetHeight;
    if (top + h > window.innerHeight - 8) versionsEl.style.top = Math.max(8, r.top - h - 6) + 'px';
    versionsEl.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-close]')) return closeVersions();
      const btn = ev.target.closest('.db-version');
      if (!btn) return;
      const picked = byId.get(btn.dataset.id);
      closeVersions();
      if (picked) onPick(picked);
    });
    // Focus sur la version utilisée (navigation clavier : flèches / Tab entre les versions, Échap ferme).
    const focusTarget = versionsEl.querySelector('.db-version.current') || versionsEl.querySelector('.db-version');
    if (focusTarget) focusTarget.focus();
    versionsEl.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft' && ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const items = Array.from(versionsEl.querySelectorAll('.db-version'));
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const next = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    });
  }

  /**
   * Choix d'une impression depuis le sélecteur : si la carte est déjà dans le deck (n'importe quelle section,
   * n'importe quelle impression), tous ses exemplaires passent à l'impression choisie ; sinon elle est ajoutée
   * avec cette impression selon la cible courante (deck / réserve / champion).
   */
  function pickPrinting(picked) {
    const swapped = Core.swapFamily(deck, Core.familyOf(picked), picked.id, byId);
    if (swapped > 0) {
      renderDeck();
      return;
    }
    if (addTarget === 'champion' && picked.type === 'unit') setChampion(picked, false);
    else if (addTarget === 'sideboard' && picked.type !== 'legend' && picked.type !== 'battlefield' && picked.type !== 'rune') addCard(picked, 'sideboard');
    else addCard(picked);
  }
  document.addEventListener('click', (ev) => {
    if (versionsEl && !versionsEl.contains(ev.target) && !ev.target.closest('[data-act="versions"]')) closeVersions();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeVersions();
  });

  /**
   * Retire un exemplaire depuis la galerie (« − » ou clic droit) : d'abord de la section visée par « Ajouter à »
   * (réserve / champion), sinon de la section par défaut de la carte, puis champion, puis réserve.
   */
  function removeCardFromGallery(card) {
    const section = Core.sectionForType(card.type);
    const family = Core.familyOf(card);
    // Même impression d'abord, sinon n'importe quelle impression de la même carte.
    const tryRemove = (sec) => {
      if (Core.remove(deck, card.id, sec, 1)) return true;
      const other = deck.sections[sec].find((e) => e.id && byId.get(e.id) && Core.familyOf(byId.get(e.id)) === family);
      return other ? Core.remove(deck, Core.entryKey(other), sec, 1) : false;
    };
    const order = addTarget === 'sideboard' ? ['sideboard', section, 'champion'] : addTarget === 'champion' ? ['champion', section, 'sideboard'] : [section, 'champion', 'sideboard'];
    for (const sec of order) if (tryRemove(sec)) break;
    renderDeck();
  }

  function flash(button, text) {
    const old = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = old), 1500);
  }

  async function copyExport() {
    const text = els.exportText.value;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      els.exportText.select();
      document.execCommand('copy');
    }
    flash(els.copy, 'Copié !');
  }

  function saveAsNew() {
    const params = new URLSearchParams({ cards: Core.buildExport(deck, byId), name: deck.name });
    location.href = `/decks/new?${params.toString()}`;
  }

  function updateExisting() {
    if (!deck.deckId) return;
    const name = deck.name.trim();
    if (!name) {
      els.name.focus();
      els.name.placeholder = 'Un nom est requis pour enregistrer';
      return;
    }
    const form = els.updateForm;
    form.action = `/decks/${encodeURIComponent(deck.deckId)}/edit`;
    form.elements.name.value = name;
    form.elements.notes.value = deck.notes || '';
    form.elements.cards.value = Core.buildExport(deck, byId);
    els.updateDomains.innerHTML = deck.domains.map((d) => `<input type="hidden" name="domains" value="${esc(d)}">`).join('');
    form.submit();
  }

  /** Lignes écrites sans sous-titre (« 3 Fiora ») rattachées par défaut à l'une des cartes « Fiora, … » : on prévient. */
  function warnAmbiguous(sections) {
    const lines = [];
    for (const s of sections || []) for (const l of s.cards || []) if (l.ambiguous) lines.push(`« ${l.written} » → ${l.name} (possible : ${(l.candidates || []).join(' / ')})`);
    if (lines.length) toast(`⚠ Nom ambigu, précise le sous-titre : ${lines.join(' ; ')}`);
  }

  async function importDecklist() {
    const text = els.importText.value.trim();
    els.importError.hidden = true;
    if (!text) return;
    els.importGo.disabled = true;
    try {
      const res = await fetch('/api/decklist/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        // Message du serveur (`error`) si présent, sinon formulation lisible plutôt qu'un code HTTP.
        let detail = '';
        try { detail = (await res.json()).error || ''; } catch (_) { /* réponse non JSON */ }
        throw new Error(detail || (res.status === 401 ? 'session expirée, reconnecte-toi' : 'liste illisible'));
      }
      const data = await res.json();
      deck.sections = Core.fromResolved(data.sections);
      renderDeck();
      els.importDialog.close();
      els.importText.value = '';
      // Les lignes non reconnues sont conservées telles quelles : affichées avec ⚠, exportées à l'identique.
      if (data.unknown) toast(`⚠ ${data.unknown} ligne${data.unknown > 1 ? 's' : ''} non reconnue${data.unknown > 1 ? 's' : ''}, marquée${data.unknown > 1 ? 's' : ''} ⚠ dans le deck.`);
      else warnAmbiguous(data.sections);
    } catch (e) {
      els.importError.textContent = 'Import impossible : ' + (e.name === 'TypeError' ? 'réseau indisponible' : e.message);
      els.importError.hidden = false;
    } finally {
      els.importGo.disabled = false;
    }
  }

  async function clearDeck() {
    const ok = window.appConfirm
      ? await window.appConfirm('Le deck en cours d’édition sera vidé. Le deck enregistré n’est pas modifié.', { title: 'Vider le deck ?', ok: 'Vider', danger: true })
      : confirm('Vider le deck en cours ? (le deck enregistré n\'est pas modifié)');
    if (!ok) return;
    deck = Core.emptyDeck();
    if (location.search) history.replaceState(null, '', '/deckbuilder');
    renderDeck();
  }

  // ---------- Événements ----------

  // Galerie : clic gauche = ajouter, clic droit = retirer, boutons d'action.
  els.grid.addEventListener('click', (ev) => {
    const art = ev.target.closest('.db-card');
    if (!art) return;
    const card = byId.get(art.dataset.id);
    if (!card) return;
    // Clic dans la barre d'actions mais hors bouton (ex. le chiffre du compteur) : rien.
    if (!ev.target.closest('button') && ev.target.closest('.db-card-actions')) return;
    let act = ev.target.closest('button') ? ev.target.closest('button').dataset.act : 'add';
    // Clic simple : suit la cible « Ajouter à » (deck / réserve / champion).
    if (act === 'add' && addTarget === 'sideboard' && card.type !== 'legend' && card.type !== 'battlefield' && card.type !== 'rune') act = 'side';
    if (act === 'add' && addTarget === 'champion' && card.type === 'unit') act = 'champion';
    if (act === 'versions') {
      // Choisir une illustration : remplace les exemplaires déjà dans le deck, sinon ajoute selon la cible courante.
      openVersions(card, ev.target.closest('button'), pickPrinting);
      return;
    }
    if (act === 'add') addCard(card);
    else if (act === 'remove') removeCardFromGallery(card);
    else if (act === 'side') addCard(card, 'sideboard');
    else if (act === 'champion') setChampion(card, false);
  });
  els.grid.addEventListener('contextmenu', (ev) => {
    if (!finePointer()) return; // tactile : l'appui long ne retire rien (menu natif conservé)
    const art = ev.target.closest('.db-card');
    if (!art) return;
    ev.preventDefault();
    const card = byId.get(art.dataset.id);
    if (card) removeCardFromGallery(card);
  });
  els.more.addEventListener('click', () => {
    shown += PAGE_SIZE;
    renderGallery();
  });

  // Panneau deck : +/−, champion, réserve, recherche par tag.
  els.sections.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'search-tag') {
      filters.text = btn.dataset.tag;
      filters.type = '';
      filters.tab = 'all';
      for (const t of els.tabs) {
        t.classList.toggle('active', t.dataset.tab === 'all');
        t.setAttribute('aria-selected', String(t.dataset.tab === 'all'));
      }
      els.search.value = filters.text;
      els.type.value = '';
      applyFilters();
      return;
    }
    const line = btn.closest('.db-line');
    if (!line) return;
    const section = line.dataset.section;
    const key = line.dataset.key;
    const entry = deck.sections[section].find((e) => Core.entryKey(e) === key);
    if (!entry) return;
    const card = entry.id ? byId.get(entry.id) : null;
    switch (btn.dataset.act) {
      case 'dec':
        Core.remove(deck, key, section, 1);
        break;
      case 'inc': {
        if (card) {
          const err = Core.canAdd(deck, card, section, byId);
          if (err) return toast('⛔ ' + err);
        }
        entry.qty += 1;
        break;
      }
      case 'versions':
        // Même sélecteur que dans la galerie : l'illustration choisie s'applique à tous les exemplaires de la carte.
        if (card) openVersions(card, btn, pickPrinting);
        return;
      case 'champion':
        if (card) setChampion(card, true);
        return;
      case 'to-side': {
        // Déplacement : le total d'exemplaires ne change pas, seule la section change.
        Core.remove(deck, key, section, 1);
        if (card) Core.add(deck, card, 'sideboard', 1);
        else deck.sections.sideboard.push({ id: null, name: entry.name, qty: 1 });
        break;
      }
      case 'to-main': {
        if (Core.count(deck.sections.main) + Core.count(deck.sections.champion) >= 40) return toast('⛔ Le deck principal est complet (40 cartes, champion inclus).');
        Core.remove(deck, key, section, 1);
        if (card) Core.add(deck, card, 'main', 1);
        else deck.sections.main.push({ id: null, name: entry.name, qty: 1 });
        break;
      }
      default:
        return;
    }
    renderDeck();
  });
  els.sections.addEventListener('contextmenu', (ev) => {
    if (!finePointer()) return;
    const line = ev.target.closest('.db-line');
    if (!line) return;
    ev.preventDefault();
    Core.remove(deck, line.dataset.key, line.dataset.section, 1);
    renderDeck();
  });

  // Filtres.
  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filters.text = els.search.value;
      applyFilters();
    }, 120);
  });
  for (const [el, key] of [[els.type, 'type'], [els.set, 'set'], [els.rarity, 'rarity'], [els.sort, 'sort']]) {
    el.addEventListener('change', () => {
      filters[key] = el.value;
      applyFilters();
    });
  }
  function setDomainFilter(domains) {
    filters.domains = domains;
    for (const chip of els.domainChips) chip.classList.toggle('active', domains.includes(chip.dataset.domain));
    applyFilters();
  }
  for (const chip of els.domainChips) {
    chip.addEventListener('click', () => {
      const d = chip.dataset.domain;
      setDomainFilter(filters.domains.includes(d) ? filters.domains.filter((x) => x !== d) : [...filters.domains, d]);
    });
  }
  els.legendDomains.addEventListener('click', () => {
    const legend = deck.sections.legend[0] && deck.sections.legend[0].id ? byId.get(deck.sections.legend[0].id) : null;
    if (legend) setDomainFilter([...legend.domains, 'colorless']);
  });
  els.resetFilters.addEventListener('click', () => {
    Object.assign(filters, { text: '', domains: [], type: '', set: '', rarity: '', variants: false, energy: BOUNDS.energy.slice(), power: BOUNDS.power.slice(), might: BOUNDS.might.slice() });
    els.search.value = '';
    els.variants.checked = false;
    els.type.value = '';
    els.set.value = '';
    els.rarity.value = '';
    for (const r of els.ranges) syncRangeInputs(r);
    setDomainFilter([]);
  });

  // Versions alternatives (art alternatif, showcase, promo).
  els.variants.addEventListener('change', () => {
    filters.variants = els.variants.checked;
    applyFilters();
  });

  // Onglets (Tout / Légende / Deck principal / Champs de bataille / Runes).
  for (const tab of els.tabs) {
    tab.addEventListener('click', () => {
      filters.tab = tab.dataset.tab;
      for (const t of els.tabs) {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      }
      // Un onglet ciblé rend le filtre « type » redondant : on le neutralise pour éviter un résultat vide.
      if (filters.tab !== 'all' && filters.type && !Core.TAB_TYPES[filters.tab].includes(filters.type)) {
        filters.type = '';
        els.type.value = '';
      }
      applyFilters();
    });
  }

  // Cible du clic : deck / réserve / champion.
  for (const btn of els.targets) {
    btn.addEventListener('click', () => {
      addTarget = btn.dataset.target;
      for (const b of els.targets) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      }
      refreshAddTargetHints();
    });
  }

  // Tiroir de filtres.
  els.filtersToggle.addEventListener('click', () => {
    const open = els.drawer.hidden;
    els.drawer.hidden = !open;
    els.filtersToggle.setAttribute('aria-expanded', String(open));
    els.filtersToggle.classList.toggle('active', open);
  });

  // Plages (double curseur) : énergie / puissance / force.
  function syncRangeInputs(rangeEl) {
    const key = rangeEl.dataset.range;
    const [minEl, maxEl] = [rangeEl.querySelector('[data-min]'), rangeEl.querySelector('[data-max]')];
    minEl.value = filters[key][0];
    maxEl.value = filters[key][1];
    const label = rangeEl.querySelector('[data-range-label]');
    label.textContent = Core.rangeActive(filters[key], BOUNDS[key]) ? `${filters[key][0]} – ${filters[key][1]}` : 'Tout';
    const lo = ((filters[key][0] - BOUNDS[key][0]) / (BOUNDS[key][1] - BOUNDS[key][0])) * 100;
    const hi = ((filters[key][1] - BOUNDS[key][0]) / (BOUNDS[key][1] - BOUNDS[key][0])) * 100;
    rangeEl.style.setProperty('--lo', lo + '%');
    rangeEl.style.setProperty('--hi', hi + '%');
  }
  for (const rangeEl of els.ranges) {
    const key = rangeEl.dataset.range;
    const [minEl, maxEl] = [rangeEl.querySelector('[data-min]'), rangeEl.querySelector('[data-max]')];
    const onInput = () => {
      let lo = Number(minEl.value);
      let hi = Number(maxEl.value);
      if (lo > hi) [lo, hi] = [hi, lo];
      filters[key] = [lo, hi];
      syncRangeInputs(rangeEl);
      applyFilters();
    };
    minEl.addEventListener('input', onInput);
    maxEl.addEventListener('input', onInput);
    syncRangeInputs(rangeEl);
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      els.search.focus();
    }
  });

  // Deck : nom, actions.
  els.name.addEventListener('input', () => {
    deck.name = els.name.value;
    saveState();
  });
  els.copy.addEventListener('click', (ev) => {
    ev.preventDefault(); // le bouton est dans le <summary> : ne pas replier le bloc
    copyExport();
  });
  els.save.addEventListener('click', saveAsNew);
  els.update.addEventListener('click', updateExisting);
  els.clear.addEventListener('click', clearDeck);
  els.import.addEventListener('click', () => {
    els.importError.hidden = true;
    if (typeof els.importDialog.showModal === 'function') els.importDialog.showModal();
    else els.importDialog.setAttribute('open', '');
  });
  els.importGo.addEventListener('click', importDecklist);

  // ---------- Démarrage ----------

  async function init() {
    try {
      // `v=3` : contourne les anciennes copies mises en cache par le navigateur (v3 : + illustrator / shortCode).
      const res = await fetch('/api/cards?v=3', { headers: { accept: 'application/json' }, cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      catalog = Array.isArray(data) ? data : data.cards || [];
    } catch (e) {
      els.resultCount.textContent = 'Catalogue indisponible (' + e.message + ')';
      els.grid.innerHTML = '<div class="db-empty">Impossible de charger le catalogue de cartes.</div>';
      return;
    }
    for (const c of catalog) byId.set(c.id, c);
    for (const c of catalog) {
      const fam = Core.familyOf(c);
      if (!families.has(fam)) families.set(fam, []);
      families.get(fam).push(c);
    }
    for (const list of families.values()) list.sort((a, b) => (a.primary ? -1 : b.primary ? 1 : 0) || String(a.publicCode).localeCompare(String(b.publicCode)));

    // Bornes réelles des plages (énergie / puissance / force) d'après le catalogue.
    for (const k of ['energy', 'power', 'might']) {
      const max = Math.max(...catalog.map((c) => (c[k] == null ? 0 : c[k])));
      if (Number.isFinite(max) && max > 0) BOUNDS[k] = [0, max];
      filters[k] = BOUNDS[k].slice();
      const rangeEl = els.ranges.find((r) => r.dataset.range === k);
      if (rangeEl) {
        for (const input of rangeEl.querySelectorAll('input')) input.max = String(max);
        syncRangeInputs(rangeEl);
      }
    }

    // Deck initial : celui demandé par ?deck=<id>, sinon le brouillon local.
    const initData = root.DECKBUILDER_INIT;
    const draft = loadState();
    deck = draft || Core.emptyDeck();
    if (initData) {
      const fromServer = loadInit(initData);
      const draftHasCards = !!draft && SECTION_ORDER.some((k) => draft.sections[k].length > 0);
      // Un brouillon non enregistré serait écrasé : autre deck, ou même deck mais modifié localement
      // (F5 sur /deckbuilder?deck=X après des changements). On demande.
      const sameDeck = draftHasCards && draft.deckId === initData.id;
      const conflict = draftHasCards && (!sameDeck || Core.buildExport(draft, byId) !== Core.buildExport(fromServer, byId));
      if (conflict && window.appConfirm) {
        if (await confirmReplaceDraft(sameDeck)) deck = fromServer;
        else toast(sameDeck ? 'Brouillon non enregistré conservé.' : 'Brouillon conservé — ouvre le deck depuis la liste pour le remplacer.');
      } else {
        deck = fromServer;
      }
      // L'URL ne garde pas ?deck= : un rechargement repart du brouillon local (qui connaît deckId) au lieu de
      // recharger la version enregistrée par-dessus.
      history.replaceState(null, '', '/deckbuilder');
    }

    applyFilters();
    renderDeck();
    refreshAddTargetHints();
  }

  /** Boîte de confirmation du projet (appConfirm) : « Remplacer » / « Garder le brouillon ». */
  function confirmReplaceDraft(sameDeck) {
    const message = sameDeck
      ? 'Ce deck a des modifications non enregistrées dans le brouillon local. Les remplacer par la version enregistrée ?'
      : 'Un brouillon non enregistré existe. Le remplacer par ce deck ?';
    return window.appConfirm(message, { title: 'Brouillon existant', ok: 'Remplacer', cancel: 'Garder le brouillon', icon: '📝' });
  }

  init();
})(typeof window !== 'undefined' ? window : globalThis);
