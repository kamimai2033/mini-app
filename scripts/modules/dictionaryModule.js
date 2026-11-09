import { fetchJSON } from './utils.js';
export function initDictionary() {
  const input = document.getElementById('dictionary-input');
  const button = document.getElementById('dictionary-search');
  const output = document.getElementById('dictionary-result');
  let controller;
  async function search() {
    const query = input.value.trim();
    controller?.abort();
    if (!query) { controller = null; output.textContent = '単語を入力してください。'; button.disabled = false; return; }
    const active = new AbortController();
    controller = active;
    const timer = setTimeout(() => active.abort(), 15000);
    button.disabled = true;
    output.textContent = '検索中…';
    try {
      const url = new URL('https://en.wiktionary.org/w/api.php');
      url.search = new URLSearchParams({ origin: '*', action: 'query', titles: query, prop: 'extracts', explaintext: '1', redirects: '1', format: 'json' });
      const data = await fetchJSON(url, active.signal);
      if (controller !== active) return;
      if (data.error) throw new Error(data.error.info);
      const page = Object.values(data.query?.pages || {})[0];
      output.replaceChildren();
      const description = document.createElement('p');
      description.textContent = page?.extract || '意味が見つかりませんでした。';
      output.append(description);
      if (page?.extract) {
        const link = document.createElement('a');
        link.href = `https://en.wiktionary.org/wiki/${encodeURIComponent(page.title)}`;
        link.textContent = '出典：Wiktionary'; link.target = '_blank'; link.rel = 'noopener noreferrer';
        output.append(link);
      }
    } catch {
      if (controller === active) output.textContent = '検索できませんでした。インターネット接続を確認し、もう一度お試しください。';
    } finally { clearTimeout(timer); if (controller === active) button.disabled = false; }
  }
  button.addEventListener('click', search);
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) search(); });
}
