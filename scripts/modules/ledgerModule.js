import { createLedgerTransport } from './ledgerTransport.js';
import { mountLedger } from './ledgerView.js';

export async function initLedger() {
  const host = document.getElementById('ledger-root');
  const templateURL = new URL('../../ledger/fragment.html', import.meta.url);
  const response = await fetch(templateURL);
  if (!response.ok) throw new Error('家計簿の画面を取得できませんでした。');
  const fragment = await response.text();
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  // This fixed, same-origin fragment contains no user or Google data.
  root.innerHTML = fragment;
  const css = document.createElement('link'); css.rel = 'stylesheet';
  css.href = new URL('../../styles/ledger.css', import.meta.url).href;
  root.prepend(css);
  mountLedger(root, createLedgerTransport());
}
