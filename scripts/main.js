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
        "account": document.getElementById('account-link'),
        "audio": document.getElementById('audio-link'),
        "pdf": document.getElementById('pdf-link'), // PDF生成リンク
        "changelog": document.getElementById('changelog-link') // 更新履歴リンク
    };

    const dictionarySearchBtn = document.getElementById('dictionary-search');
    const changelogModal = document.getElementById('changelog-modal');
    const changelogContent = document.getElementById('changelog-content');
    const closeChangelogModal = document.querySelector('.modal .close');

    // 汎用モジュール初期化関数
    function initializeModule(moduleName) {
        if (typeof window[moduleName] === 'function') {
            try {
                window[moduleName]();
                console.log(`モジュール ${moduleName} が初期化されました`);
            } catch (error) {
                console.error(`モジュール ${moduleName} の初期化に失敗しました`, error);
            }
        }
    }

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

    // PDF生成機能のリンク設定
    if (links.pdf) {
        links.pdf.addEventListener('click', () => showSection('pdf-section'));
    }

    // 画像選択のイベントリスナー設定
    const imageInput = document.getElementById('image-input');
    if (imageInput) {
        imageInput.addEventListener('change', previewImage);
    }

    // 辞書検索ボタンのイベントリスナー
    if (dictionarySearchBtn) {
        dictionarySearchBtn.addEventListener('click', searchDictionary);
    }

    // Service Worker の登録
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/mini-app/service-worker.js')
            .then(registration => console.log('ServiceWorker registration successful with scope:', registration.scope))
            .catch(error => console.error('ServiceWorker registration failed:', error));
    }

    // 更新履歴の取得
    async function loadChangelog() {
        try {
            const response = await fetch('CHANGELOG.md');
            if (!response.ok) throw new Error('CHANGELOG.md の取得に失敗');
            const text = await response.text();
            changelogContent.textContent = text;
        } catch (error) {
            changelogContent.textContent = '更新履歴の読み込みに失敗しました。';
            console.error(error);
        }
    }

    // クリック時に更新履歴を開く
    if (links.changelog) {
        links.changelog.addEventListener('click', () => {
            loadChangelog();
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

    // POSモジュールや他モジュールの初期化（汎用化）
    initializeModule('initializePOS');
    initializeModule('initializeAccountBook');
    initializeModule('initializeOCR'); // OCRがある場合
    initializeModule('initializeAudioPlayer'); // オーディオプレイヤーがある場合
    initializeModule('initializePDFModule'); // PDF生成モジュールがある場合
});
