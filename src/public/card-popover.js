// Popover « carte en grand » au survol d'une vignette.
//
// Contrat :
//   - cible : tout élément `.card-thumb` contenant un `<img>` ;
//   - URL pleine résolution : attribut `data-full` de la `.card-thumb`, sinon `href` (si c'est un lien),
//     sinon `src` de l'img ;
//   - attaché par délégation d'événements sur `document` : fonctionne aussi sur du HTML injecté
//     dynamiquement (aperçu live du formulaire de deck, futur deckbuilder…) ;
//   - désactivé sur écran tactile / pointeur imprécis (pas de « hover » réel) ;
//   - un conteneur `[data-popover-avoid]` (ex. sélecteur de versions) : tant qu'il est présent, seules ses
//     propres vignettes déclenchent le zoom, et le popover se place à côté du conteneur, jamais dessus ;
//   - l'événement `card-popover:hide` sur document masque le popover (à déclencher à l'ouverture d'un menu) ;
//   - aucune dépendance.
(function () {
  'use strict';

  const WIDTH = 340;        // largeur cible du popover (px)
  const OFFSET = 18;        // écart entre le curseur et le popover (px)
  const MARGIN = 8;         // marge minimale avec les bords de la fenêtre (px)
  const SHOW_DELAY = 120;   // délai avant apparition (ms), évite le clignotement en balayant la grille
  const HIDE_GRACE = 80;    // délai avant masquage (ms) : le temps de passer sur la carte voisine sans clignoter

  // Le popover n'a de sens qu'avec une vraie souris : on teste à chaque survol (appareils hybrides).
  const fineHover = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;
  function hoverAllowed() {
    return !fineHover || fineHover.matches;
  }

  let popover = null;       // conteneur du popover (créé à la demande)
  let popImg = null;        // <img> pleine résolution dans le popover
  let current = null;       // vignette actuellement survolée
  let showTimer = null;     // timer du délai d'apparition
  let ratio = 744 / 1039;   // ratio largeur/hauteur de l'image affichée (portrait par défaut)
  let lastX = 0, lastY = 0; // dernière position connue du curseur
  let hideTimer = null;     // courte grâce avant masquage (passage fluide d'une carte à sa voisine)

  function ensurePopover() {
    if (popover) return;
    popover = document.createElement('div');
    popover.className = 'card-popover';
    popover.setAttribute('aria-hidden', 'true');
    popImg = document.createElement('img');
    popImg.alt = '';
    popImg.decoding = 'async';
    popImg.addEventListener('load', onFullLoaded);
    popImg.addEventListener('error', () => popover.classList.remove('is-loading'));
    popover.appendChild(popImg);
    document.body.appendChild(popover);
  }

  // URL pleine résolution selon le contrat data-full > href > src.
  function fullUrl(thumb, img) {
    if (thumb.dataset.full) return thumb.dataset.full;
    if (thumb.tagName === 'A' && thumb.getAttribute('href')) return thumb.href;
    return img.currentSrc || img.src;
  }

  // Quand l'image HD est chargée, on ajuste le ratio (portrait ou paysage) et on l'affiche.
  function onFullLoaded() {
    if (popImg.naturalWidth && popImg.naturalHeight) {
      ratio = popImg.naturalWidth / popImg.naturalHeight;
    }
    popover.classList.remove('is-loading');
    position();
  }

  // Dimensions du popover : largeur cible, hauteur déduite du ratio, réduites si la fenêtre est petite.
  function computeSize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    let w = Math.min(WIDTH, vw - 2 * MARGIN);
    let h = w / ratio;
    const maxH = vh - 2 * MARGIN;
    if (h > maxH) { h = maxH; w = h * ratio; }
    return { w, h };
  }

  // Conteneur à ne pas recouvrir (sélecteur de versions…), s'il est ouvert.
  function avoidBox() {
    return document.querySelector('[data-popover-avoid]');
  }

  // Placement près du curseur : à droite par défaut, à gauche s'il manque de place ; recalé verticalement.
  function position() {
    if (!popover || !current) return;
    const { w, h } = computeSize();
    const vw = window.innerWidth, vh = window.innerHeight;

    // Vignette dans un conteneur à éviter : on se place à côté du conteneur, pas du curseur.
    const box = avoidBox();
    if (box && box.contains(current)) {
      const r = box.getBoundingClientRect();
      let x = r.right + OFFSET;
      if (x + w + MARGIN > vw) x = r.left - OFFSET - w;
      x = Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
      let y = r.top + r.height / 2 - h / 2;
      y = Math.max(MARGIN, Math.min(y, vh - h - MARGIN));
      popover.style.width = w + 'px';
      popover.style.height = h + 'px';
      popover.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
      return;
    }

    let x = lastX + OFFSET;
    if (x + w + MARGIN > vw) x = lastX - OFFSET - w;   // pas la place à droite → à gauche
    x = Math.max(MARGIN, Math.min(x, vw - w - MARGIN)); // et on reste dans la fenêtre quoi qu'il arrive

    let y = lastY - h / 2;                              // centré verticalement sur le curseur
    y = Math.max(MARGIN, Math.min(y, vh - h - MARGIN));

    popover.style.width = w + 'px';
    popover.style.height = h + 'px';
    popover.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
  }

  function show(thumb) {
    const img = thumb.querySelector('img');
    if (!img) return;
    ensurePopover();

    // Ratio provisoire : celui de la vignette (déjà chargée), identique à celui de l'image HD.
    if (img.naturalWidth && img.naturalHeight) {
      ratio = img.naturalWidth / img.naturalHeight;
    } else {
      ratio = thumb.closest('.card-grid-landscape') ? 1039 / 744 : 744 / 1039;
    }

    const url = fullUrl(thumb, img);
    popImg.alt = img.alt || '';
    if (popImg.src !== url) {
      // Cache l'ancienne image le temps que la nouvelle arrive (évite d'afficher la mauvaise carte).
      popover.classList.add('is-loading');
      popImg.src = url;
      // Image déjà en cache : `load` ne sera pas forcément re-déclenché de façon visible, on force.
      if (popImg.complete && popImg.naturalWidth) onFullLoaded();
    }

    position();
    popover.classList.add('is-visible');
    popover.setAttribute('aria-hidden', 'false');
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = null;
    hideTimer = null;
    current = null;
    if (!popover) return;
    popover.classList.remove('is-visible');
    popover.setAttribute('aria-hidden', 'true');
  }

  // Entrée sur une vignette (délégation : mouseover remonte depuis l'img ou le badge quantité).
  document.addEventListener('mouseover', (e) => {
    if (!hoverAllowed()) return;
    const thumb = e.target.closest && e.target.closest('.card-thumb');
    if (!thumb || thumb === current) return;
    if (!thumb.querySelector('img')) return; // ex. carte non reconnue, sans image
    // Un conteneur à éviter est ouvert : seules ses vignettes zooment (le reste de la page reste calme).
    const box = avoidBox();
    if (box && !box.contains(thumb)) return;

    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = null;
    current = thumb;
    lastX = e.clientX;
    lastY = e.clientY;
    // Popover encore visible (passage d'une carte à la voisine) : on enchaîne sans délai.
    if (popover && popover.classList.contains('is-visible')) {
      show(thumb);
    } else {
      showTimer = setTimeout(() => { if (current === thumb) show(thumb); }, SHOW_DELAY);
    }
  });

  // Sortie de la vignette : on masque (après une courte grâce) si la souris n'est pas restée dans la vignette.
  // La grâce permet, en glissant vers la carte voisine, de la remplacer directement sans clignotement.
  document.addEventListener('mouseout', (e) => {
    if (!current) return;
    const thumb = e.target.closest && e.target.closest('.card-thumb');
    if (thumb !== current) return;
    const to = e.relatedTarget;
    if (to && current.contains(to)) return;
    clearTimeout(showTimer);
    showTimer = null;
    if (!hideTimer) hideTimer = setTimeout(hide, HIDE_GRACE);
  });

  // Suivi du curseur pendant le survol (+ garde-fou si la vignette a été retirée du DOM entre-temps).
  document.addEventListener('mousemove', (e) => {
    if (!current) return;
    lastX = e.clientX;
    lastY = e.clientY;
    if (!document.body.contains(current)) { hide(); return; }
    if (popover && popover.classList.contains('is-visible')) position();
  });

  // Défilement, redimensionnement, perte de focus, Échap : on masque pour éviter un popover orphelin.
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  document.addEventListener('card-popover:hide', hide);
})();
