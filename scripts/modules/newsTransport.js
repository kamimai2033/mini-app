export function normalizeNewsEndpoint(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('接続先を https://ホスト名[:ポート] で入力してください。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('接続先にはHTTPSのホスト名と必要なポートだけを指定してください。');
  }
  return url.origin;
}
export function createNewsTransport() {
  let endpoint = '', token = '';
  async function requestTo(origin, path, body, key = '') {
    if (!path.startsWith('/api/news/')) throw new Error('未対応のニュースAPIです。');
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = typeof data?.error === 'string' ? data.error : typeof data?.error?.message === 'string' ? data.error.message : '';
      const message = response.status === 401 ? 'アクセスキーを確認して再接続してください。' : response.status === 429 ? '更新間隔を空けてから再試行してください。' : detail || `ニュースAPIへ接続できません（HTTP ${response.status}）。`;
      const error = new Error(message); error.status = response.status; error.code = data?.error?.code || data?.code || ''; throw error;
    }
    if (!data || typeof data !== 'object') throw new Error('ニュースAPIから読み取れる応答がありません。');
    return data;
  }
  return {
    get endpoint() { return endpoint; },
    get connected() { return !!(endpoint && token); },
    async connect(value, key) {
      const next = normalizeNewsEndpoint(value), secret = String(key).trim();
      if (secret.length < 32 || /\s/.test(secret)) throw new Error('32文字以上のアクセスキーを確認してください。');
      const info = await requestTo(next, '/api/news/info');
      if (info.protocol !== 1 || info.mode !== 'news') throw new Error('ニュースくん対応のNAS APIを指定してください。');
      const data = await requestTo(next, '/api/news/snapshot?view=all&limit=500', undefined, secret);
      endpoint = next; token = secret;
      return { info, data };
    },
    disconnect() { token = ''; endpoint = ''; },
    request(path, body) {
      if (!token || !endpoint) throw new Error('設定でアクセスキーを入力してNASへ接続してください。');
      return requestTo(endpoint, path, body, token);
    }
  };
}
