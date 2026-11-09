export function initCharCount() {
  const input = document.getElementById('char-input');
  const count = document.getElementById('char-count');
  input.addEventListener('input', () => { count.textContent = input.value.length; });
}
