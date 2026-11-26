// Continuous barcode reading for books. janScanner keeps decoding until stopped; this
// wrapper filters ISBNs, ignores the lower 191/192 code and repeated reads.
import { startScan, stopScan, scanImage } from './janScanner.js';
import { classifyCode } from './libraryCore.js';

let audio;
export function beep(ok = true) {
  try {
    audio ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.frequency.value = ok ? 1320 : 440; gain.gain.value = 0.08;
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + (ok ? 0.08 : 0.2));
  } catch { /* sound is optional */ }
}

/**
 * Start reading with the rear camera. `onRead({ kind, isbn?, code })` is called once per
 * distinct code within `quietMs`; 'ignore' codes (191/192) are never reported.
 */
export function createContinuousScanner(video, onRead, { quietMs = 5000 } = {}) {
  const seen = new Map();
  let running = false;
  return {
    get running() { return running; },
    async start() {
      running = true; video.hidden = false; seen.clear();
      try {
        await startScan(video, code => {
          if (!running) return;
          const now = Date.now(), last = seen.get(code);
          seen.set(code, now);
          if (last && now - last < quietMs) return;
          const result = classifyCode(code);
          if (result.kind !== 'ignore') onRead(result);
        });
      } catch (error) { running = false; video.hidden = true; throw error; }
    },
    stop() { running = false; stopScan(); video.hidden = true; }
  };
}
export async function readPhoto(file) { return classifyCode(await scanImage(file)); }
export { stopScan };
