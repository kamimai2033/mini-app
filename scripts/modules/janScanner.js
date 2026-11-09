// Vendored decoder is part of the initial shell cache: camera and photo input work offline.
import '../vendor/zxing-library.min.js';
let reader, generation = 0;
export function stopScan() { generation++; reader?.reset(); reader = null; }
function decoder() {
  const hints = new Map();
  hints.set(globalThis.ZXing.DecodeHintType.POSSIBLE_FORMATS, [globalThis.ZXing.BarcodeFormat.EAN_13, globalThis.ZXing.BarcodeFormat.EAN_8]);
  return new globalThis.ZXing.BrowserMultiFormatReader(hints, 300);
}
export async function startScan(video, found) {
  stopScan(); const token = generation;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラを使えません。HTTPS・カメラ権限を確認するか写真から読み取ってください。');
  reader = decoder(); const current = reader;
  try {
    await current.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } }, video, result => {
      if (generation === token && result) found(result.getText());
    });
    if (generation !== token) current.reset();
  } catch { current.reset(); throw new Error('カメラを開始できません。権限を確認するか、写真から読み取ってください。'); }
}
export async function scanImage(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('画像は20MB以下を指定してください。');
  stopScan(); const url = URL.createObjectURL(file), current = decoder();
  try { return (await current.decodeFromImageUrl(url)).getText(); }
  catch { throw new Error('JANコードを認識できません。バーコードが鮮明な写真か、手入力をお試しください。'); }
  finally { current.reset(); URL.revokeObjectURL(url); }
}
