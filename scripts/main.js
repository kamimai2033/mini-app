import './app-config.js';

const config = globalThis.MINI_APP_CONFIG;
const base = new URL('../', import.meta.url);
const initialized = new Map();
const sections = [...document.querySelectorAll('main > section')];
const status = document.getElementById('app-status');
document.querySelectorAll('[data-app-version]').forEach(el => { el.textContent = `v${config.version}`; });
document.title = `ミニアプリ基盤 v${config.version}`;

function closeMenus() {
  document.querySelectorAll('.nav-toggle').forEach(button => {
    button.setAttribute('aria-expanded', 'false');
    document.getElementById(button.getAttribute('aria-controls')).hidden = true;
  });
}

async function showFeature(feature) {
  const [id, linkId, module, initializer] = feature;
  const target = document.getElementById(`${id}-section`);
  if (!target) return;
  sections.forEach(section => { section.hidden = section !== target; });
  config.features.forEach(([, navId]) => {
    document.getElementById(navId)?.setAttribute('aria-current', navId === linkId ? 'page' : 'false');
  });
  closeMenus();
  if (module && !initialized.has(id)) {
    target.setAttribute('aria-busy', 'true');
    const loading = import(`./modules/${module}`).then(exports => exports[initializer]());
    initialized.set(id, loading);
    try { await loading; }
    catch (error) {
      initialized.delete(id);
      status.textContent = '機能を読み込めませんでした。接続状態を確認してもう一度開いてください。';
      console.error(error);
    } finally { target.removeAttribute('aria-busy'); }
  }
}
config.features.forEach(feature => {
  document.getElementById(feature[1])?.addEventListener('click', () => showFeature(feature));
});
document.querySelectorAll('.nav-toggle').forEach(button => {
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    closeMenus();
    button.setAttribute('aria-expanded', String(open));
    document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
  });
});
// Keep the original desktop hover menus; touch devices use the same toggle button.
document.querySelectorAll('.dropdown').forEach(item => {
  item.addEventListener('mouseenter', () => {
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    closeMenus();
    const button = item.querySelector('.nav-toggle');
    button.setAttribute('aria-expanded', 'true');
    document.getElementById(button.getAttribute('aria-controls')).hidden = false;
  });
  item.addEventListener('mouseleave', () => {
    if (matchMedia('(hover: hover) and (pointer: fine)').matches && !item.contains(document.activeElement)) {
      const button = item.querySelector('.nav-toggle');
      button.setAttribute('aria-expanded', 'false');
      document.getElementById(button.getAttribute('aria-controls')).hidden = true;
    }
  });
});
document.addEventListener('click', event => { if (!event.target.closest('nav')) closeMenus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });

const modal = document.getElementById('changelog-modal');
document.getElementById('changelog-link').addEventListener('click', async () => {
  if (!modal.open) modal.showModal();
  const output = document.getElementById('changelog-content');
  try {
    const response = await fetch(new URL('CHANGELOG.md', base));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    output.textContent = await response.text();
  } catch { output.textContent = '更新履歴を取得できませんでした。'; }
});
document.getElementById('close-changelog').addEventListener('click', () => modal.close());
modal.addEventListener('click', event => { if (event.target === modal) modal.close(); });
function showConnection() {
  document.getElementById('connection-status').textContent = navigator.onLine ? 'オンライン' : 'オフライン';
}
window.addEventListener('online', showConnection);
window.addEventListener('offline', showConnection);
showConnection();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(new URL('service-worker.js', base), {
    scope: base.href, updateViaCache: 'none'
  }).then(registration => {
    const showWaiting = () => {
      if (registration.waiting && navigator.serviceWorker.controller) status.textContent = '新版の準備ができました。このアプリのタブ・ウィンドウをすべて閉じ、開き直すと更新されます。';
    };
    showWaiting();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') showWaiting();
        if (installing.state === 'redundant') status.textContent = navigator.serviceWorker.controller
          ? '更新用ファイルを保存できませんでした。以前のオフライン版を維持しています。'
          : 'オフライン用ファイルを保存できませんでした。オンラインでページを開き直してください。';
      });
    });
    navigator.serviceWorker.ready.then(() => {
      if (!registration.waiting && !status.textContent) status.textContent = '基本機能のオフライン準備ができました。';
    });
  }).catch(error => {
    status.textContent = 'オフライン保存を開始できませんでした。HTTPS接続と配信先の設定を確認してください。';
    console.error(error);
  });
} else {
  status.textContent = 'オフライン保存とOCRには、HTTPSまたはlocalhostで開いてください。';
}
