// scripts/modules/dictionaryModule.js

// 動作検証用
console.log("辞書モジュールが読み込まれました")

export async function searchDictionary() {
    const query = document.getElementById('dictionary-input').value.trim();
    const url = `https://en.wiktionary.org/w/api.php?origin=*&action=query&titles=${query}&prop=extracts&format=json`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        const page = Object.values(data.query.pages)[0];
        if (page.extract) {
            document.getElementById('dictionary-result').innerHTML = page.extract;
        } else {
            document.getElementById('dictionary-result').textContent = '意味が見つかりませんでした。';
        }
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('dictionary-result').textContent = 'エラーが発生しました。';
    }
}
