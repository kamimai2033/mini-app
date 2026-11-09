/* Shared by the page and the classic Service Worker. Keep paths relative. */
globalThis.MINI_APP_CONFIG = Object.freeze({
  version: '1.8.4',
  features: [
    ['home', 'home-link', null, null],
    ['char-count', 'char-count-link', 'charCountModule.js', 'initCharCount'],
    ['pos', 'pos-link', 'posModule.js', 'initializePOS'],
    ['dictionary', 'dictionary-link', 'dictionaryModule.js', 'initDictionary'],
    ['jpdictionary', 'jpdictionary-link', 'jpdictionaryModule.js', 'initJPDictionary'],
    ['editor', 'editor-link', 'editorModule.js', 'initEditor'],
    ['pdf', 'pdf-link', 'pdfModule.js', 'initPDFModule'],
    ['audio', 'audio-link', 'audioPlayerModule.js', 'initAudioPlayer'],
    ['mail', 'addressgen-link', 'mailGeneratorModule.js', 'initMailGenerator'],
    ['ocr', 'ocr-link', 'ocrModule.js', 'initOCR']
  ],
  shellFiles: [
    './', './index.html', './styles/main.css', './scripts/main.js',
    './scripts/app-config.js', './scripts/modules/utils.js',
    './scripts/modules/jspdfModule.js', './manifest.json', './CHANGELOG.md',
    './favicon.ico', './images/icon-192x192.png', './images/icon-512x512.png'
  ],
  ocrVersion: 'tesseract-6.0.1-core-6.0.0-data-1.0.0',
  ocrAssets: [
    ['tesseract.min.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js', '10fff78484067759c43028a02a72d76d0b90eb17302bb23b58a9ec5410bc928b'],
    ['worker.min.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js', '38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842'],
    ['core/tesseract-core-lstm.wasm.js', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-lstm.wasm.js', '775a35df6f2ae100e02609443e6bd5cafcd07983dd6175454ca4a432a7730687'],
    ['core/tesseract-core-simd-lstm.wasm.js', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js', '9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7'],
    ['lang/eng.traineddata.gz', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz', '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'],
    ['lang/jpn.traineddata.gz', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int/jpn.traineddata.gz', '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88']
  ]
});
