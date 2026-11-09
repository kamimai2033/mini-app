import { loadImageFile } from './utils.js';

export function initPDFModule() {
  const input = document.getElementById('pdf-fileInput');
  const preview = document.getElementById('pdf-preview');
  const generate = document.getElementById('pdf-generateBtn');
  const landscape = document.getElementById('pdf-forceLandscape');
  const progress = document.getElementById('pdf-progress');
  const progressContainer = document.getElementById('pdf-progress-container');
  const status = document.getElementById('pdf-status');
  const info = document.getElementById('pdf-pageInfo');
  let files = [];
  let urls = [];
  let busy = false;
  const release = () => { urls.forEach(url => URL.revokeObjectURL(url)); urls = []; };
  window.addEventListener('pagehide', event => { if (!event.persisted) release(); });
  function render() {
    release();
    preview.replaceChildren();
    files.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'pdf-item';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      urls.push(img.src);
      img.alt = `${index + 1}ページ目: ${file.name}`;
      const caption = document.createElement('p');
      caption.textContent = `${index + 1}. ${file.name}`;
      const controls = document.createElement('div');
      controls.className = 'button-row';
      for (const [label, delta] of [['前へ', -1], ['後ろへ', 1], ['削除', 0]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.disabled = busy || (delta === -1 && index === 0) || (delta === 1 && index === files.length - 1);
        button.addEventListener('click', () => {
          if (busy) return;
          if (!delta) files.splice(index, 1);
          else [files[index], files[index + delta]] = [files[index + delta], files[index]];
          render();
        });
        controls.append(button);
      }
      item.append(img, caption, controls);
      preview.append(item);
    });
  }
  input.addEventListener('change', () => {
    files = Array.from(input.files || []);
    render();
  });
  generate.addEventListener('click', async () => {
    if (busy) return;
    progressContainer.hidden = false;
    if (!files.length) { status.textContent = '画像を選択してください。'; return; }
    const filename = prompt('保存ファイル名', `miniapp-${new Date().toLocaleDateString('sv-SE')}.pdf`);
    if (filename === null) return;
    const snapshot = [...files];
    busy = true;
    generate.disabled = input.disabled = landscape.disabled = true;
    render();
    progress.value = 0;
    try {
      await import('./jspdfModule.js');
      const { jsPDF } = globalThis.jspdf;
      let doc;
      for (let i = 0; i < snapshot.length; i++) {
        status.textContent = `処理中 ${i + 1}/${snapshot.length}`;
        info.textContent = snapshot[i].name;
        const img = await loadImageFile(snapshot[i]);
        const orientation = landscape.checked || img.naturalWidth > img.naturalHeight ? 'l' : 'p';
        if (!doc) doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
        else doc.addPage('a4', orientation);
        const width = doc.internal.pageSize.getWidth();
        const height = doc.internal.pageSize.getHeight();
        const ratio = Math.min((width - 10) / img.naturalWidth, (height - 10) / img.naturalHeight);
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 3200 / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('画像を処理するメモリが不足しています。');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        const w = img.naturalWidth * ratio;
        const h = img.naturalHeight * ratio;
        doc.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', (width - w) / 2, (height - h) / 2, w, h);
        canvas.width = canvas.height = 1;
        progress.value = Math.round((i + 1) / snapshot.length * 100);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const name = filename.trim() || 'miniapp.pdf';
      doc.save(/\.pdf$/i.test(name) ? name : `${name}.pdf`);
      status.textContent = 'PDFを生成しました。';
    } catch (error) {
      status.textContent = `PDFを生成できませんでした。${error.message}`;
    } finally {
      busy = false;
      generate.disabled = input.disabled = landscape.disabled = false;
      render();
    }
  });
}
