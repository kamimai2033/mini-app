export function initEditor() {
  document.getElementById('run-code').addEventListener('click', () => {
    const html = document.getElementById('html-code').value;
    const css = document.getElementById('css-code').value.replace(/<\/style/gi, '<\\/style');
    const js = document.getElementById('js-code').value.replace(/<\/script/gi, '<\\/script');
    document.getElementById('output').srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}<script>${js}<\/script></body></html>`;
  });
}
