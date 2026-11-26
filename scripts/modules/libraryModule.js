import { createLibraryTransport } from './libraryTransport.js';
import { mountLibrary } from './libraryView.js';

export async function initLibrary() {
  const host = document.getElementById('library-root');
  const response = await fetch(new URL('../../library/fragment.html', import.meta.url));
  if (!response.ok) throw new Error('本棚・図書館の画面を取得できませんでした。');
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  // A fixed same-origin fragment; book titles and notes are always rendered with textContent.
  root.innerHTML = await response.text();
  const css = document.createElement('link'); css.rel = 'stylesheet';
  css.href = new URL('../../styles/library.css', import.meta.url).href; root.prepend(css);
  await mountLibrary(root, createLibraryTransport());
}
