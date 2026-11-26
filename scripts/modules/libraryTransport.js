// HTTPS + Bearer connection to the NAS library API. The access key lives in memory only.
export function normalizeLibraryEndpoint(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('接続先を https://ホスト名[:ポート] で入力してください。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('接続先にはHTTPSのホスト名と必要なポートだけを指定してください（パスは不要です）。');
  }
  return url.origin;
}
export function createLibraryTransport() {
  let endpoint = '', token = '', info = null;
  const covers = new Map();
  async function requestTo(origin, path, body, key = '', { binary = false, timeout = 30000 } = {}) {
    if (!path.startsWith('/api/library/')) throw new Error('未対応のAPIです。');
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (binary && response.ok) return response.blob();
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = typeof data?.error?.message === 'string' ? data.error.message : '';
      const message = response.status === 401 ? 'アクセスキーを確認して再接続してください。' : detail || `ライブラリAPIへ接続できません（HTTP ${response.status}）。`;
      const error = new Error(message); error.status = response.status; error.code = data?.error?.code || ''; throw error;
    }
    if (!data || typeof data !== 'object') throw new Error('ライブラリAPIから読み取れる応答がありません。');
    return data;
  }
  return {
    get endpoint() { return endpoint; },
    get connected() { return !!(endpoint && token); },
    get info() { return info; },
    async probe(value) {
      const next = normalizeLibraryEndpoint(value);
      const result = await requestTo(next, '/api/library/info');
      if (result.protocol !== 1 || result.mode !== 'library' || typeof result.server_id !== 'string') throw new Error('本棚・図書館に対応したNAS APIを指定してください。');
      return { endpoint: next, info: result };
    },
    async connect(value, key) {
      const secret = String(key).trim();
      if (secret.length < 24 || /\s/.test(secret)) throw new Error('アクセスキー（24文字以上）を確認してください。');
      const probed = await this.probe(value);
      await requestTo(probed.endpoint, '/api/library/snapshot?since=999999999999999', undefined, secret).catch(error => {
        // 409 (cursor ahead) proves the key is valid without downloading everything.
        if (error.status !== 409) throw error;
      });
      endpoint = probed.endpoint; token = secret; info = probed.info;
      return probed;
    },
    disconnect() {
      token = ''; endpoint = ''; info = null;
      for (const url of covers.values()) if (url) URL.revokeObjectURL(url);
      covers.clear();
    },
    request(path, body) {
      if (!token || !endpoint) throw new Error('共通設定でアクセスキーを入力してNASへ接続してください。');
      return requestTo(endpoint, path, body, token);
    },
    /** Object URL for a cover image, or '' when none. Cached for this page session. */
    async cover(bibId) {
      if (!token || !endpoint || !/^[0-9a-f-]{36}$/.test(bibId)) return '';
      if (covers.has(bibId)) return covers.get(bibId);
      covers.set(bibId, '');
      try {
        const blob = await requestTo(endpoint, `/api/library/cover/${bibId}`, undefined, token, { binary: true, timeout: 20000 });
        const url = blob.type.startsWith('image/') ? URL.createObjectURL(blob) : '';
        covers.set(bibId, url); return url;
      } catch (error) {
        if (error.status !== 404) covers.delete(bibId); // retry later unless the NAS says there is no cover
        return '';
      }
    }
  };
}
