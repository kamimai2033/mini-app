// scripts/modules/pdfModule.js
console.log("pdfモジュールが読み込まれました");

let initialized = false;
let fileList = [];

export function initPDFModule() {
    if (initialized) return;
    initialized = true;

    const fileInput = document.getElementById("pdf-fileInput");
    const preview = document.getElementById("pdf-preview");
    const generateBtn = document.getElementById("pdf-generateBtn");

    const progressContainer = document.getElementById("pdf-progress-container");
    const progressBar = document.getElementById("pdf-progress");
    const statusText = document.getElementById("pdf-status");
    const pageInfo = document.getElementById("pdf-pageInfo");

    const forceLandscapeCheckbox = document.getElementById("pdf-forceLandscape");

    if (!fileInput || !preview || !generateBtn) {
        console.error("PDFモジュールのDOMが不足しています");
        return;
    }

    // ===== ファイル読み込み =====
    fileInput.addEventListener("change", () => {
        fileList = Array.from(fileInput.files);
        renderPreview();
    });

    // ===== プレビュー描画 =====
    function renderPreview() {
        preview.innerHTML = "";

        fileList.forEach((file, index) => {
            const url = URL.createObjectURL(file);

            const item = document.createElement("div");
            item.className = "pdf-item";
            item.draggable = true;
            item.dataset.index = index;

            const img = document.createElement("img");
            img.src = url;

            // 削除ボタン
            const removeBtn = document.createElement("button");
            removeBtn.textContent = "×";

            removeBtn.addEventListener("click", () => {
                fileList.splice(index, 1);
                renderPreview();
            });

            // ===== ドラッグ =====
            item.addEventListener("dragstart", e => {
                e.dataTransfer.setData("index", index);
            });

            item.addEventListener("dragover", e => e.preventDefault());

            item.addEventListener("drop", e => {
                const from = e.dataTransfer.getData("index");
                const to = index;

                const moved = fileList.splice(from, 1)[0];
                fileList.splice(to, 0, moved);

                renderPreview();
            });

            item.appendChild(img);
            item.appendChild(removeBtn);
            preview.appendChild(item);
        });
    }

    generateBtn.addEventListener("click", generatePDF);

    // ===== PDF生成 =====
    async function generatePDF() {
        const files = fileList; 

        if (!files.length) {
            alert("画像を選択してください");
            return;
        }

        if (!window.jspdf) {
            alert("jsPDFが読み込まれていません");
            return;
        }

        const totalPages = files.length;

        generateBtn.disabled = true;
        progressContainer.style.display = "flex";

        progressBar.value = 0;
        statusText.textContent = "処理開始";
        pageInfo.textContent = `0 / ${totalPages}`;

        const now = new Date();
        const defaultName =
            `miniapp-${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}.pdf`;

        const fileName = prompt("保存ファイル名", defaultName) || defaultName;
        const finalName = fileName.endsWith(".pdf") ? fileName : fileName + ".pdf";

        const { jsPDF } = window.jspdf;
        let doc;

        const forceLandscape = forceLandscapeCheckbox?.checked;

        for (let i = 0; i < totalPages; i++) {
            progressBar.value = Math.round((i / totalPages) * 100);
            statusText.textContent = `処理中 ${i + 1}/${totalPages}`;
            pageInfo.textContent = `${i + 1}/${totalPages}`;

            const dataUrl = await readFile(files[i]);
            const img = await loadImage(dataUrl);

            const orientation = forceLandscape
                ? "l"
                : (img.width > img.height ? "l" : "p");

            if (i === 0) {
                doc = new jsPDF({
                    orientation,
                    unit: "mm",
                    format: "a4"
                });
            } else {
                doc.addPage(orientation);
            }

            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();

            const margin = 5;

            const ratio = Math.min(
                (pageWidth - margin * 2) / img.width,
                (pageHeight - margin * 2) / img.height
            );

            const imgW = img.width * ratio;
            const imgH = img.height * ratio;

            const x = (pageWidth - imgW) / 2;
            const y = (pageHeight - imgH) / 2;

            doc.addImage(dataUrl, "JPEG", x, y, imgW, imgH, undefined, "FAST");
        }

        progressBar.value = 100;
        statusText.textContent = "完了";

        doc.save(finalName);

        generateBtn.disabled = false;
        progressContainer.style.display = "none";
    }

    // ===== ユーティリティ =====
    function readFile(file) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.readAsDataURL(file);
        });
    }

    function loadImage(src) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = src;
        });
    }
}
