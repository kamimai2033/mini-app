export function initAudioPlayer() {
  const input = document.getElementById('fileInput');
  const player = document.getElementById('audioPlayer');
  const playlist = document.getElementById('playlist');
  const play = document.getElementById('playBtn');
  const shuffle = document.getElementById('shuffleBtn');
  const loop = document.getElementById('loopBtn');
  const status = document.getElementById('audio-status');
  let files = [], urls = [], index = 0, shuffled = false;
  function release() { urls.forEach(url => URL.revokeObjectURL(url)); urls = []; }
  window.addEventListener('pagehide', event => { if (!event.persisted) release(); });
  async function start() {
    if (!urls.length) { status.textContent = '音声ファイルを選択してください。'; return; }
    try { await player.play(); status.textContent = files[index].name; }
    catch { status.textContent = '再生できませんでした。再生ボタンを押すか、別の形式の音声を選んでください。'; }
  }
  function highlight() {
    [...playlist.children].forEach((li, i) => {
      li.classList.toggle('active', i === index);
      li.firstElementChild.setAttribute('aria-pressed', String(i === index));
    });
  }
  function track(next) {
    if (!urls.length) return;
    index = (next + urls.length) % urls.length;
    player.src = urls[index];
    highlight();
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: files[index].name });
    }
    start();
  }
  function next() {
    if (shuffled && urls.length > 1) track(index + 1 + Math.floor(Math.random() * (urls.length - 1)));
    else track(index + 1);
  }
  input.addEventListener('change', () => {
    player.pause(); player.removeAttribute('src'); player.load(); release();
    files = [...(input.files || [])];
    urls = files.map(file => URL.createObjectURL(file)); index = 0;
    playlist.replaceChildren();
    files.forEach((file, i) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = file.name;
      button.addEventListener('click', () => track(i));
      li.append(button); playlist.append(li);
    });
    if (urls.length) track(0);
  });
  play.addEventListener('click', () => player.paused ? start() : player.pause());
  player.addEventListener('play', () => { play.textContent = '一時停止'; });
  player.addEventListener('pause', () => { play.textContent = '再生'; });
  player.addEventListener('ended', () => {
    if (!player.loop && (shuffled || index < urls.length - 1)) next();
  });
  player.addEventListener('error', () => { if (player.getAttribute('src')) status.textContent = 'この音声を再生できません。別のファイルをお試しください。'; });
  document.getElementById('nextBtn').addEventListener('click', next);
  document.getElementById('prevBtn').addEventListener('click', () => track(index - 1));
  shuffle.addEventListener('click', () => {
    shuffled = !shuffled;
    shuffle.setAttribute('aria-pressed', String(shuffled)); shuffle.classList.toggle('is-active', shuffled);
  });
  loop.addEventListener('click', () => {
    player.loop = !player.loop;
    loop.setAttribute('aria-pressed', String(player.loop)); loop.classList.toggle('is-active', player.loop);
  });
  document.getElementById('volumeSlider').addEventListener('input', event => { player.volume = Number(event.target.value); });
  if ('mediaSession' in navigator) {
    for (const [action, handler] of [['play', start], ['pause', () => player.pause()], ['nexttrack', next], ['previoustrack', () => track(index - 1)]]) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Some browsers support only a subset. */ }
    }
  }
}
