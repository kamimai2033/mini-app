import { copyText } from './utils.js';

export function generateSecureRandomString(length, random = crypto) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const limit = Math.floor(256 / chars.length) * chars.length;
  let result = '';
  while (result.length < length) {
    const bytes = random.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) {
      if (byte < limit) result += chars[byte % chars.length];
      if (result.length === length) break;
    }
  }
  return result;
}
export function buildAddress(service, domain) {
  service = service.trim().toLowerCase();
  domain = domain.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/.test(service) || service.includes('..')) {
    throw new Error('サービス名には半角英数字と . _ + - を使用してください。先頭と末尾は英数字にしてください。');
  }
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || labels.some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('ドメインを example.com の形式で入力してください。');
  }
  if (service.length + 12 > 64 || service.length + 13 + domain.length > 254) throw new Error('メールアドレスが長すぎます。');
  return `${generateSecureRandomString(12)}${service}@${domain}`;
}
export function initMailGenerator() {
  const output = document.getElementById('generated-address');
  const status = document.getElementById('mail-status');
  document.getElementById('generate-btn').addEventListener('click', () => {
    try {
      output.value = buildAddress(document.getElementById('service-input').value, document.getElementById('domain-input').value);
      status.textContent = '生成しました。受信には、このドメイン側で受信・転送の設定が必要です。';
    } catch (error) { output.value = ''; status.textContent = error.message; }
  });
  document.getElementById('copy-btn').addEventListener('click', async () => {
    try { await copyText(output.value, output); status.textContent = 'コピーしました。'; }
    catch (error) { status.textContent = error.message; }
  });
}
