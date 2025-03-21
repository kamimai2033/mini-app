console.log("PDFモジュールが読み込まれました");

// PDF生成関数
async function convertToPDF() {
    const { jsPDF } = window.jspdf;

    try {
        const element = document.getElementById("pdf-preview");

        if (!element) {
            alert("PDF化するコンテンツが見つかりません");
            return;
        }

        // HTML要素を画像に変換
        const canvas = await html2canvas(element);

        // 画像データを取得
        const imgData = canvas.toDataURL("image/png");

        // PDFを生成
        const pdf = new jsPDF({
            orientation: "portrait",
            unit: "mm",
            format: "a4"
        });

        // PDFに画像を追加
        const imgWidth = 210;  // A4横幅
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        pdf.addImage(imgData, "PNG", 0, 0, imgWidth, imgHeight);

        // PDFをダウンロード
        pdf.save("sample.pdf");
    } catch (error) {
        console.error("PDF生成エラー:", error);
        alert("PDFの生成に失敗しました");
    }
}

// 画像プレビューを表示する関数
function previewImage(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const imgElement = document.getElementById("pdf-preview");
        imgElement.src = e.target.result;
        imgElement.style.display = "block";
    };
    reader.readAsDataURL(file);
}
