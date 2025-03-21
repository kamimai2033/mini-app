console.log("PDFモジュールが読み込まれました");

// PDF生成関数
async function convertToPDF() {
    const { jsPDF } = window.jspdf;
    const element = document.getElementById("pdf-preview");

    if (!element) {
        alert("PDF化するコンテンツが見つかりません");
        return;
    }

    // HTML要素を画像に変換
    const canvas = await html2canvas(element);
    const imgData = canvas.toDataURL("image/png");

    const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4"
    });

    const imgWidth = 210;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    pdf.addImage(imgData, "PNG", 0, 0, imgWidth, imgHeight);
    pdf.save("sample.pdf");
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
