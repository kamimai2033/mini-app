import { fetchJSON } from './utils.js';
export function initJPDictionary() {
  const input = document.getElementById('query');
  const button = document.getElementById('jpdictionary-search');
  const output = document.getElementById('jpdictionary-results');
  let controller;
  async function search() {
    controller?.abort();
    const query = input.value.trim();
    if (!query) { controller = null; output.textContent = '検索語を入力してください。'; button.disabled = false; return; }
    const active = new AbortController(); controller = active;
    const timer = setTimeout(() => active.abort(), 20000);
    button.disabled = true;
    output.textContent = '検索中…';
    try {
      const url = new URL('https://ja.wikipedia.org/w/api.php');
      url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', origin: '*', generator: 'search', gsrsearch: query, gsrlimit: '5', prop: 'extracts', exintro: '1', explaintext: '1', exsentences: '3' });
      const data = await fetchJSON(url, active.signal);
      if (controller !== active) return;
      if (data.error) throw new Error(data.error.info);
      const pages = (data.query?.pages || []).sort((a, b) => a.index - b.index);
      output.replaceChildren();
      if (!pages.length) output.textContent = '該当する記事が見つかりませんでした。';
      for (const page of pages) {
        const article = document.createElement('article');
        const heading = document.createElement('h3'); heading.textContent = page.title;
        const description = document.createElement('p'); description.textContent = page.extract || '概要なし';
        const link = document.createElement('a');
        link.href = `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;
        link.textContent = '出典：Wikipedia'; link.target = '_blank'; link.rel = 'noopener noreferrer';
        article.append(heading, description, link); output.append(article);
      }
    } catch {
      if (controller === active) output.textContent = '検索できませんでした。インターネット接続を確認し、もう一度お試しください。';
    } finally { clearTimeout(timer); if (controller === active) button.disabled = false; }
  }
  button.addEventListener('click', search);
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) search(); });
}
