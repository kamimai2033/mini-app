export async function copyText(text, input) {
  if (!text) throw new Error('コピーするテキストがありません。');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    input?.focus();
    input?.select();
    throw new Error('自動コピーできませんでした。選択した文字を手動でコピーしてください。');
  }
}
export function downloadText(text, name, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function fetchJSON(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function loadImageFile(file) {
  if (!file || file.size > 20 * 1024 * 1024) return Promise.reject(new Error('画像は1枚20MB以下にしてください。'));
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const finish = () => { clearTimeout(timer); URL.revokeObjectURL(url); img.onload = img.onerror = null; };
    const timer = setTimeout(() => { finish(); reject(new Error('画像の読み込みがタイムアウトしました。')); }, 30000);
    img.onload = () => {
      finish();
      if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > 25000000) {
        reject(new Error('画像は2500万画素以下にしてください。'));
      } else resolve(img);
    };
    img.onerror = () => { finish(); reject(new Error('画像を読み込めません。JPEG・PNG・WebPなどをお試しください。')); };
    img.src = url;
  });
}
