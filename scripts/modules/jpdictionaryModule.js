// scripts/modules/jpdictionaryModule.js

// 動作検証用
console.log("日語辞書モジュールが読み込まれました")

export async function searchjpDictionary() {
    const q = document.getElementById("query").value;
    const encoded = encodeURIComponent(q);

    const searchUrl =
        `https://ja.wikipedia.org/w/api.php?action=query&format=json&list=search&formatversion=2&srsearch=${encoded}&origin=*`;

    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    const resultsDiv = document.getElementById("jpdictionary-results");
    resultsDiv.innerHTML = "";

    for (const item of searchData.query.search) {

    // 概要取得（REST API）
    const summaryUrl =
        `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(item.title)}`;

    const summaryRes = await fetch(summaryUrl);
    const summaryData = await summaryRes.json();

    const article = document.createElement("div");
    article.innerHTML = `
        <h3>${summaryData.title}</h3>
        <p>${summaryData.extract || "概要なし"}</p>
        <hr>
        `;

        resultsDiv.appendChild(article);
    }
}
