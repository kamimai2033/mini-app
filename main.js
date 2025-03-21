import { searchDictionary } from './modules/dictionaryModule.js';

document.addEventListener('DOMContentLoaded', () => {
    // すべてのセクションとリンクを取得
    const sections = document.querySelectorAll('main section');
    const links = {
        "home": document.getElementById('home-link'),
        "char-count": document.getElementById('char-count-link'),
        "dictionary": document.getElementById('dictionary-link'),
        "editor": document.getElementById('editor-link'),
        "ocr": document.getElementById('ocr-link'), // OCR機能がある場合
        "pos": document.getElementById('pos-link'),
        "audio": document.getElementById('audio-link'),
        "changelog": document.getElementById('changelog-link') // 更新履歴リンク
    };


    const dictionarySearchBtn = document.getElementById('dictionary-search');

    // セクションを表示する関数（他のセクションを非表示）
    function showSection(sectionId) {
        sections.forEach(section => section.style.display = 'none');
        const targetSection = document.getElementById(sectionId);
        if (targetSection) {
            targetSection.style.display = 'block';
        } else {
            console.warn(`セクション ${sectionId} が見つかりません`);
        }
    }

    // 各リンクにイベントリスナーを設定
    Object.keys(links).forEach(key => {
        if (links[key]) {
            links[key].addEventListener('click', () => showSection(`${key}-section`));
        }
    });

    // 辞書検索ボタンのイベントリスナー
    if (dictionarySearchBtn) {
        dictionarySearchBtn.addEventListener('click', searchDictionary);
    }

    // POSモジュールの初期化（未定義チェック）
    if (typeof initializePOS !== 'undefined' && typeof initializePOS === 'function') {
        initializePOS();
    }

    // Service Worker の登録
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/mini-app/service-worker.js')
            .then(registration => console.log('ServiceWorker registration successful with scope:', registration.scope))
            .catch(error => console.error('ServiceWorker registration failed:', error));
    }

    // ------------- ここから CHANGELOG.md の読み込み処理 -------------
    const changelogModal = document.getElementById('changelog-modal');
    const changelogContent = document.getElementById('changelog-content');
    const closeChangelogModal = document.querySelector('.modal .close');

    // 更新履歴の取得
    async function loadChangelog() {
        try {
            const response = await fetch('CHANGELOG.md'); // CHANGELOG.md を読み込む
            if (!response.ok) throw new Error('CHANGELOG.md の取得に失敗');
            const text = await response.text();
            changelogContent.textContent = text; // テキストを表示
        } catch (error) {
            changelogContent.textContent = '更新履歴の読み込みに失敗しました。';
            console.error(error);
        }
    }

    // クリック時に更新履歴を開く
    if (links.changelog) {
        links.changelog.addEventListener('click', () => {
            loadChangelog(); // 更新履歴を読み込む
            changelogModal.style.display = 'block';
        });
    }

    // モーダルを閉じる
    if (closeChangelogModal) {
        closeChangelogModal.addEventListener('click', () => {
            changelogModal.style.display = 'none';
        });
    }

    // モーダル外クリックで閉じる
    window.addEventListener('click', event => {
        if (event.target === changelogModal) {
            changelogModal.style.display = 'none';
        }
    });
});
