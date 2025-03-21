// scripts/modules/editorModule.js

// 動作検証用
console.log("editorモジュールが読み込まれました");

document.addEventListener('DOMContentLoaded', () => {
    const runCodeButton = document.getElementById('run-code');
    if (runCodeButton) {
        runCodeButton.addEventListener('click', () => {
            const html = document.getElementById('html-code').value;
            const css = `<style>${document.getElementById('css-code').value}</style>`;
            const js = `<script>${document.getElementById('js-code').value}<\/script>`;
            const output = document.getElementById('output');

            // iframe内にコードを反映
            output.srcdoc = html + css + js;
        });
    } else {
        console.error("実行ボタンが見つかりません");
    }
});
