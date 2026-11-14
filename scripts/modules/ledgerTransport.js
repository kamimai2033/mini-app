// The access key lives only in this module's memory, never in persistent storage.
const preferenceKey = `mini-app-ledger:${new URL('../../', import.meta.url).pathname}:endpoint`;
export function normalizeLedgerEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('接続先は https://ホスト名[:ポート] の形式で指定してください。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('家計簿の接続先にはHTTPSを使用してください。');
  }
  return url.origin;
}
export function createLedgerTransport() {
  let endpoint = localStorage.getItem(preferenceKey) || '', accessKey = '';
  return {
    get endpoint() { return endpoint; },
    get storagePrefix() { return `${preferenceKey}:${encodeURIComponent(endpoint)}:`; },
    async connect(value, key) {
      const next = normalizeLedgerEndpoint(value), token = key.trim();
      if (token.length < 32 || /\s/.test(token)) throw new Error('アクセスキーを確認してください。');
      // Check compatibility before sending a secret or any queued household data.
      const response = await fetch(next + '/api/mobile/info', { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      const info = await response.json().catch(() => null);
      if (!response.ok || info?.protocol !== 1 || info?.mode !== 'household-ledger') {
        throw new Error('NASをmini-app対応版 v0.3.0以降へ更新し、配信元の許可設定を確認してください。');
      }
      // Verify the key before selecting the endpoint; this read never writes a ledger entry.
      const probe = await fetch(next + '/api/ledger?month=' + new Date().toISOString().slice(0, 7), {
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + token }
      });
      if (!probe.ok) throw new Error(probe.status === 401 ? 'アクセスキーが一致しません。' : `NASへの接続を確認してください（HTTP ${probe.status}）。`);
      localStorage.setItem(preferenceKey, next);
      endpoint = next; accessKey = token;
    },
    disconnect() { accessKey = ''; },
    request(path, options) {
      if (!endpoint || !accessKey) return Promise.resolve(new Response('{"error":"UNAUTHORIZED"}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
      if (!(path === '/api/ledger' || path.startsWith('/api/ledger?') || path.startsWith('/api/ledger/'))) throw new Error('未対応の家計簿APIです。');
      return fetch(endpoint + path, { ...options, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { ...options.headers, Authorization: 'Bearer ' + accessKey } });
    }
  };
}
