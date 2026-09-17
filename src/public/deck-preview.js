// Aperçu live du deck pendant la saisie : envoie la decklist au serveur, qui renvoie le HTML rendu.
(function () {
  const textarea = document.getElementById('decklist');
  const preview = document.getElementById('deck-preview');
  if (!textarea || !preview) return;

  let timer = null;
  let lastSent = textarea.value;
  let inflight = null;

  async function refresh() {
    const text = textarea.value;
    if (text === lastSent) return;
    lastSent = text;
    if (inflight) inflight.abort();
    inflight = new AbortController();
    preview.classList.add('loading');
    try {
      const res = await fetch('/api/decklist/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: inflight.signal,
      });
      if (res.ok) preview.innerHTML = await res.text();
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
    } finally {
      preview.classList.remove('loading');
    }
  }

  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 350);
  });
  textarea.addEventListener('paste', () => setTimeout(refresh, 50));
})();
