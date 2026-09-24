// Formulaire de création d'un match free play : génère les places (joueur + deck)
// selon le format choisi et filtre la liste des decks sur le joueur sélectionné.
// Permet aussi d'ajouter un joueur sans compte (invité) sans perdre les places déjà remplies.
(function () {
  const cfg = window.FP_FORM;
  const formatSelect = document.getElementById('fp-format');
  const slots = document.getElementById('fp-slots');
  if (!cfg || !formatSelect || !slots) return;

  const TEAM_LABELS = ['Équipe A', 'Équipe B'];

  // Mémorise les choix pour ne pas les perdre quand on change de format.
  const remembered = {};
  // Selects « joueur » actuellement affichés, pour les rafraîchir quand un invité est ajouté.
  let playerSelects = [];

  function option(value, label, selected) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (selected) o.selected = true;
    return o;
  }

  function fillPlayers(playerSelect, userId) {
    playerSelect.innerHTML = '';
    playerSelect.appendChild(option('', '— choisir un joueur —'));
    for (const u of cfg.users) playerSelect.appendChild(option(u.id, u.username, u.id === userId));
  }

  // Remplit le select des decks du joueur ; `hint` (élément .form-hint) explique pourquoi il est désactivé.
  function fillDecks(deckSelect, userId, keepDeckId, hint) {
    deckSelect.innerHTML = '';
    deckSelect.appendChild(option('', '— sans deck —'));
    const decks = (userId && cfg.decksByOwner[userId]) || [];
    for (const d of decks) {
      deckSelect.appendChild(option(d.id, d.legend ? d.name + ' (' + d.legend + ')' : d.name, d.id === keepDeckId));
    }
    deckSelect.disabled = decks.length === 0;
    if (hint) {
      hint.textContent = !userId ? 'Choisis d’abord le joueur.' : decks.length === 0 ? 'Ce joueur n’a aucun deck enregistré : la place reste sans deck.' : '';
      hint.hidden = !hint.textContent;
    }
  }

  function slot(name, label, defaultUserId) {
    const wrap = document.createElement('div');
    wrap.className = 'fp-slot';
    const saved = remembered[name] || {};
    const userId = saved.userId !== undefined ? saved.userId : defaultUserId || '';

    const playerLabel = document.createElement('label');
    playerLabel.textContent = label + ' ';
    const playerSelect = document.createElement('select');
    playerSelect.name = name.replace('slot', 'side').replace('_', '_player');
    playerSelect.required = true;
    fillPlayers(playerSelect, userId);
    playerLabel.appendChild(playerSelect);
    playerSelects.push(playerSelect);

    const deckLabel = document.createElement('label');
    deckLabel.textContent = 'Deck ';
    const deckSelect = document.createElement('select');
    deckSelect.name = name.replace('slot', 'side').replace('_', '_deck');
    deckLabel.appendChild(deckSelect);
    const deckHint = document.createElement('span');
    deckHint.className = 'form-hint muted fp-deck-hint';
    deckLabel.appendChild(deckHint);
    fillDecks(deckSelect, userId, saved.deckId, deckHint);

    playerSelect.addEventListener('change', function () {
      remembered[name] = { userId: playerSelect.value, deckId: '' };
      fillDecks(deckSelect, playerSelect.value, '', deckHint);
    });
    deckSelect.addEventListener('change', function () {
      remembered[name] = { userId: playerSelect.value, deckId: deckSelect.value };
    });

    wrap.appendChild(playerLabel);
    wrap.appendChild(deckLabel);
    return wrap;
  }

  const formatNote = document.getElementById('fp-format-note');

  function render() {
    const spec = cfg.formats[formatSelect.value] || cfg.formats['1v1'];
    slots.innerHTML = '';
    playerSelects = [];
    for (let i = 0; i < spec.sides; i++) {
      const box = document.createElement('fieldset');
      box.className = 'fp-side-box';
      const legend = document.createElement('legend');
      legend.textContent = spec.perSide > 1 ? TEAM_LABELS[i] : 'Joueur ' + (i + 1);
      box.appendChild(legend);
      for (let j = 0; j < spec.perSide; j++) {
        const label = spec.perSide > 1 ? 'Joueur ' + (j + 1) : 'Joueur';
        const isFirst = i === 0 && j === 0;
        box.appendChild(slot('slot' + i + '_' + j, label, isFirst ? cfg.me : ''));
      }
      slots.appendChild(box);
    }
    if (formatNote) {
      formatNote.textContent = spec.note || '';
      formatNote.hidden = !spec.note;
    }
  }

  formatSelect.addEventListener('change', render);
  render();

  // Date et heure préremplies à « maintenant » (heure locale du navigateur).
  const dateInput = document.querySelector('input[name="date"]');
  if (dateInput && !dateInput.value) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    dateInput.value = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  }

  // ---- Joueur sans compte ----
  const guestBtn = document.getElementById('fp-guest-add');
  const guestUsername = document.getElementById('fp-guest-username');
  const guestEmail = document.getElementById('fp-guest-email');
  const guestMsg = document.getElementById('fp-guest-msg');
  if (!guestBtn || !guestUsername || !guestEmail || !guestMsg) return;

  function showGuestMsg(kind, nodes) {
    guestMsg.className = 'fp-guest-msg is-' + kind;
    guestMsg.innerHTML = '';
    for (const n of nodes) guestMsg.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
    guestMsg.hidden = false;
  }

  // Ajoute l'utilisateur à la liste (trié par pseudo) et rafraîchit tous les selects joueur
  // sans toucher aux choix en cours.
  function addUser(user) {
    if (!cfg.users.some((u) => u.id === user.id)) {
      cfg.users.push(user);
      cfg.users.sort((a, b) => a.username.localeCompare(b.username, 'fr', { sensitivity: 'base' }));
    }
    for (const sel of playerSelects) fillPlayers(sel, sel.value);
  }

  // Sélectionne l'utilisateur dans la première place vide (le change() met à jour la mémoire et le deck).
  // Renvoie 'placed', 'already' (déjà sur une place) ou 'full' (aucune place libre).
  function placeUser(userId) {
    if (playerSelects.some((sel) => sel.value === userId)) return 'already';
    const empty = playerSelects.find((sel) => !sel.value);
    if (!empty) return 'full';
    empty.value = userId;
    empty.dispatchEvent(new Event('change'));
    return 'placed';
  }

  async function addGuest() {
    const username = guestUsername.value.trim();
    const email = guestEmail.value.trim();
    if (username.length < 2) return showGuestMsg('error', ['Pseudo du joueur requis (min 2 car.).']);
    if (!email) return showGuestMsg('error', ['Adresse e-mail requise.']);
    guestBtn.disabled = true;
    try {
      const res = await fetch('/free-play/guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, email }),
      });
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      const data = isJson ? await res.json() : null;
      if (!data) return showGuestMsg('error', ['Session expirée ou erreur serveur — recharge la page et reconnecte-toi.']);
      if (!res.ok || !data.ok) return showGuestMsg('error', [data.error || 'Impossible d’ajouter ce joueur.']);

      const user = { id: data.user._id, username: data.user.username };
      addUser(user);
      const placed = placeUser(user.id);
      const where = placed === 'placed' ? ' et placé·e sur une place libre' : placed === 'already' ? ' (déjà sur une place du match)' : ' (toutes les places sont prises : choisis-le/la dans une liste)';
      const nodes = [];
      if (!data.guest) {
        nodes.push(user.username + ' a déjà un compte avec cet e-mail : ajouté·e à la liste' + where + '.');
      } else if (!data.created) {
        // Invité déjà connu : pas de lien renvoyé (il a déjà reçu le sien), on le sélectionne simplement.
        nodes.push(user.username + ' est déjà dans la liste' + where + '.');
      } else if (data.mailSent) {
        nodes.push(user.username + ' ajouté·e' + where + '. Invitation envoyée à ' + email + '.');
      } else if (data.inviteLink) {
        nodes.push(user.username + ' ajouté·e' + where + '. E-mail non configuré : envoie ce lien à ' + user.username + ' pour qu’il/elle réclame son compte — ');
        const a = document.createElement('a');
        a.href = data.inviteLink;
        a.textContent = data.inviteLink;
        nodes.push(a);
      } else {
        nodes.push(user.username + ' ajouté·e' + where + '.');
      }
      showGuestMsg('success', nodes);
      guestUsername.value = '';
      guestEmail.value = '';
    } catch (err) {
      showGuestMsg('error', ['Erreur réseau : ' + err.message]);
    } finally {
      guestBtn.disabled = false;
    }
  }

  guestBtn.addEventListener('click', addGuest);
  // Entrée dans un des deux champs = Ajouter, sans soumettre le formulaire du match.
  for (const input of [guestUsername, guestEmail]) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addGuest();
      }
    });
  }
})();
