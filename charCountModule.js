// scripts/modules/charCountModule.js

// 動作検証用
console.log("文字数モジュールが読み込まれました")

document.addEventListener('DOMContentLoaded', function() {
    const charInput = document.getElementById('char-input');
    const charCount = document.getElementById('char-count');

    charInput.addEventListener('input', function() {
        charCount.textContent = charInput.value.length;
    });
});
