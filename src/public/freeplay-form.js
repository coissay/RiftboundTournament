// Formulaire de création d'un match free play : génère les places (joueur + deck)
// selon le format choisi et filtre la liste des decks sur le joueur sélectionné.
(function () {
  const cfg = window.FP_FORM;
  const formatSelect = document.getElementById('fp-format');
  const slots = document.getElementById('fp-slots');
  if (!cfg || !formatSelect || !slots) return;

  const TEAM_LABELS = ['Équipe A', 'Équipe B'];

  // Mémorise les choix pour ne pas les perdre quand on change de format.
  const remembered = {};

  function option(value, label, selected) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (selected) o.selected = true;
    return o;
  }

  function fillDecks(deckSelect, userId, keepDeckId) {
    deckSelect.innerHTML = '';
    deckSelect.appendChild(option('', '— sans deck —'));
    const decks = (userId && cfg.decksByOwner[userId]) || [];
    for (const d of decks) {
      deckSelect.appendChild(option(d.id, d.legend ? d.name + ' (' + d.legend + ')' : d.name, d.id === keepDeckId));
    }
    deckSelect.disabled = decks.length === 0;
    if (!userId) {
      deckSelect.firstChild.textContent = '— choisis d’abord le joueur —';
    } else if (decks.length === 0) {
      deckSelect.firstChild.textContent = '— ce joueur n’a aucun deck enregistré —';
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
    playerSelect.appendChild(option('', '— choisir un joueur —'));
    for (const u of cfg.users) playerSelect.appendChild(option(u.id, u.username, u.id === userId));
    playerLabel.appendChild(playerSelect);

    const deckLabel = document.createElement('label');
    deckLabel.textContent = 'Deck ';
    const deckSelect = document.createElement('select');
    deckSelect.name = name.replace('slot', 'side').replace('_', '_deck');
    deckLabel.appendChild(deckSelect);
    fillDecks(deckSelect, userId, saved.deckId);

    playerSelect.addEventListener('change', function () {
      remembered[name] = { userId: playerSelect.value, deckId: '' };
      fillDecks(deckSelect, playerSelect.value, '');
    });
    deckSelect.addEventListener('change', function () {
      remembered[name] = { userId: playerSelect.value, deckId: deckSelect.value };
    });

    wrap.appendChild(playerLabel);
    wrap.appendChild(deckLabel);
    return wrap;
  }

  function render() {
    const spec = cfg.formats[formatSelect.value] || cfg.formats['1v1'];
    slots.innerHTML = '';
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
})();
