// Boîte de confirmation maison (remplace confirm() natif, non stylisable).
//
// Usage HTML : <form data-confirm="Question ?" data-confirm-title="Titre" data-confirm-ok="Oui, faire"> …
//   - le texte du bouton OK vaut, par défaut, celui du bouton de soumission cliqué ;
//   - le style « danger » (rouge) est repris si ce bouton porte .btn-danger ou si data-confirm-danger est présent ;
//   - un <button data-confirm="…"> hors formulaire déclenche aussi la boîte (l'événement click est stoppé si annulé).
// Usage JS : window.appConfirm(message, { title, ok, cancel, danger, icon }) → Promise<boolean>.
(function () {
  'use strict';

  let dialog = null;
  let els = null;
  let resolver = null;

  function ensure() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML =
      '<form method="dialog" class="confirm-box">' +
      '  <div class="confirm-icon" aria-hidden="true"></div>' +
      '  <h2 class="confirm-title"></h2>' +
      '  <p class="confirm-message"></p>' +
      '  <div class="confirm-actions">' +
      '    <button type="button" class="btn btn-ghost" data-act="cancel">Annuler</button>' +
      '    <button type="button" class="btn btn-gold" data-act="ok"></button>' +
      '  </div>' +
      '</form>';
    document.body.appendChild(dialog);
    els = {
      icon: dialog.querySelector('.confirm-icon'),
      title: dialog.querySelector('.confirm-title'),
      message: dialog.querySelector('.confirm-message'),
      ok: dialog.querySelector('[data-act="ok"]'),
      cancel: dialog.querySelector('[data-act="cancel"]'),
    };
    els.ok.addEventListener('click', () => close(true));
    els.cancel.addEventListener('click', () => close(false));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(false); }); // Échap
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(false); }); // clic sur le fond
  }

  function close(result) {
    if (!dialog.open) return;
    dialog.classList.add('is-closing');
    setTimeout(() => {
      dialog.classList.remove('is-closing');
      dialog.close();
      const r = resolver;
      resolver = null;
      if (r) r(result);
    }, 120);
  }

  function appConfirm(message, opts) {
    opts = opts || {};
    ensure();
    if (resolver) resolver(false);
    els.title.textContent = opts.title || 'Confirmer';
    els.message.textContent = message || '';
    els.ok.textContent = opts.ok || 'Confirmer';
    els.cancel.textContent = opts.cancel || 'Annuler';
    els.ok.className = 'btn ' + (opts.danger ? 'btn-danger-solid' : 'btn-gold');
    els.icon.textContent = opts.icon || (opts.danger ? '⚠️' : '❔');
    dialog.showModal();
    els.cancel.focus();
    return new Promise((resolve) => { resolver = resolve; });
  }
  window.appConfirm = appConfirm;

  // Libellé du bouton OK : texte du bouton cliqué, sans emoji de tête ni suffixe trop long.
  function labelOf(button, fallback) {
    const t = button && button.textContent ? button.textContent.replace(/\s+/g, ' ').trim() : '';
    return t && t.length <= 40 ? t : fallback || 'Confirmer';
  }

  function optsFor(el, button) {
    return {
      title: el.dataset.confirmTitle || undefined,
      ok: el.dataset.confirmOk || labelOf(button),
      danger: el.hasAttribute('data-confirm-danger') || (button && button.classList.contains('btn-danger')),
      icon: el.dataset.confirmIcon || undefined,
    };
  }

  // Formulaires : on intercepte la soumission, puis on soumet nous-mêmes si confirmé.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.confirm || form.dataset.confirmed === '1') return;
    e.preventDefault();
    const button = e.submitter || form.querySelector('button, input[type=submit]');
    appConfirm(form.dataset.confirm, optsFor(form, button)).then((ok) => {
      if (!ok) return;
      form.dataset.confirmed = '1';
      if (typeof form.requestSubmit === 'function') form.requestSubmit(button || undefined);
      else form.submit();
    });
  });

  // Boutons hors formulaire.
  document.addEventListener('click', (e) => {
    const button = e.target.closest && e.target.closest('button[data-confirm]');
    if (!button || button.form || button.dataset.confirmed === '1') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    appConfirm(button.dataset.confirm, optsFor(button, button)).then((ok) => {
      if (!ok) return;
      button.dataset.confirmed = '1';
      button.click();
      delete button.dataset.confirmed;
    });
  }, true);
})();
