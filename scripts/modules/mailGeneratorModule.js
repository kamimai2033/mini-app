const RANDOM_LENGTH = 12;

function generateSecureRandomString(length) {
    const chars =
        "abcdefghijklmnopqrstuvwxyz0123456789";

    const result = [];

    while (result.length < length) {
        const random = new Uint8Array(1);
        crypto.getRandomValues(random);

        // Modulo Bias回避
        if (random[0] >= 248) continue;

        result.push(chars[random[0] % chars.length]);
    }

    return result.join("");
}

export function initMailGenerator(){

    document.getElementById("generate-btn")
        ?.addEventListener("click", () => {
            
        const service = document
            .getElementById("service-input")
            .value
            .trim()
            .toLowerCase();

        const domain = document
            .getElementById("domain-input")
            .value
            .trim()
            .toLowerCase();

        if (!service || !domain) {
            alert("サービス名とドメインを入力してください");
            return;
        }
    
        const random = generateSecureRandomString(RANDOM_LENGTH);
        const address = `${random}${service}@${domain}`;
        document.getElementById("generated-address").value = address;
    });

    document.getElementById("copy-btn")
        ?.addEventListener("click", async () => {

            const address = document.getElementById("generated-address").value;
            if (!address) return;
            await navigator.clipboard.writeText(address);
            alert("コピーしました");
        });
}