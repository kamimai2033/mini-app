document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    const audioPlayer = document.getElementById('audioPlayer');
    const playBtn = document.getElementById('playBtn');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const shuffleBtn = document.getElementById('shuffleBtn');
    const loopBtn = document.getElementById('loopBtn');
    const playlist = document.getElementById('playlist');
    const volumeSlider = document.getElementById('volumeSlider');
    const albumArt = document.getElementById('albumArt');

    let fileList = [];
    let blobURLs = [];
    let currentIndex = 0;
    let isShuffle = false;
    let isLoop = false;

    // ミニアプリ基盤との統合
    document.getElementById('audio-link').addEventListener('click', () => {
        document.querySelectorAll('main section').forEach(section => section.style.display = 'none');
        document.getElementById('audio-section').style.display = 'block';
    });

    // ファイル選択時
    fileInput.addEventListener('change', () => {
        fileList = Array.from(fileInput.files);
        blobURLs = fileList.map(file => URL.createObjectURL(file));
        currentIndex = 0;
        updatePlaylist();
        if (blobURLs.length > 0) {
            audioPlayer.src = blobURLs[currentIndex];
            audioPlayer.play();
        }
    });

    // 再生
    playBtn.addEventListener('click', () => {
        audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause();
    });

    // 次の曲
    nextBtn.addEventListener('click', playNext);
    prevBtn.addEventListener('click', playPrevious);
    shuffleBtn.addEventListener('click', toggleShuffle);
    loopBtn.addEventListener('click', toggleLoop);
    volumeSlider.addEventListener('input', adjustVolume);

    function playNext() {
        if (blobURLs.length === 0) return;
        currentIndex = isShuffle ? Math.floor(Math.random() * blobURLs.length) : (currentIndex + 1) % blobURLs.length;
        updateTrack();
    }

    function playPrevious() {
        if (blobURLs.length === 0) return;
        currentIndex = isShuffle ? Math.floor(Math.random() * blobURLs.length) : (currentIndex - 1 + blobURLs.length) % blobURLs.length;
        updateTrack();
    }

    function toggleShuffle() {
        isShuffle = !isShuffle;
        shuffleBtn.classList.toggle("bg-blue-600", isShuffle);
    }

    function toggleLoop() {
        isLoop = !isLoop;
        audioPlayer.loop = isLoop;
        loopBtn.classList.toggle("bg-blue-600", isLoop);
    }

    function adjustVolume() {
        audioPlayer.volume = volumeSlider.value;
    }

    function updateTrack() {
        audioPlayer.src = blobURLs[currentIndex];
        audioPlayer.play();
        highlightCurrentTrack();
    }

    function updatePlaylist() {
        playlist.innerHTML = "";
        fileList.forEach((file, index) => {
            const li = document.createElement('li');
            li.textContent = file.name;
            li.classList.add("cursor-pointer", "p-2", "hover:bg-gray-300", "rounded");

            if (index === currentIndex) {
                li.classList.add("bg-gray-400", "text-white");
            }

            li.addEventListener("click", () => {
                currentIndex = index;
                updateTrack();
            });

            playlist.appendChild(li);
        });
    }

    function highlightCurrentTrack() {
        document.querySelectorAll("#playlist li").forEach((item, index) => {
            item.classList.remove("bg-gray-400", "text-white");
            if (index === currentIndex) {
                item.classList.add("bg-gray-400", "text-white");
            }
        });
    }
});
