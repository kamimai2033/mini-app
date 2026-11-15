import { createNewsTransport } from './newsTransport.js';
import { mountNews } from './newsView.js';

export async function initNews() {
  const host = document.getElementById('news-root');
  const response = await fetch(new URL('../../news/fragment.html', import.meta.url));
  if (!response.ok) throw new Error('ニュースの画面を取得できませんでした。');
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  // A fixed same-origin fragment; feed contents are always rendered with textContent.
  root.innerHTML = await response.text();
  const css = document.createElement('link'); css.rel = 'stylesheet';
  css.href = new URL('../../styles/news.css', import.meta.url).href; root.prepend(css);
  await mountNews(root, createNewsTransport());
}
