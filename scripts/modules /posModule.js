// scripts/modules/posModule.js

// 動作検証用
console.log("POSモジュールが読み込まれました");


// scripts/modules/posModule.js
export function initializePOS() {
    const addProductButton = document.getElementById('add-product');
    const checkoutButton = document.getElementById('checkout');
    const productList = document.getElementById('product-list');
    const cartList = document.getElementById('cart-list');
    const historyList = document.getElementById('history-list');
    const totalPriceElement = document.getElementById('total-price');

    if (!addProductButton || !checkoutButton || !productList || !cartList || !historyList || !totalPriceElement) {
        console.error("POSシステムの要素が見つかりません");
        return;
    }

    // 他のPOSロジック（例：商品を追加、カートに商品を追加など）を実装
    console.log("POSモジュールが初期化されました");
}



document.addEventListener('DOMContentLoaded', function () {
    const productList = [];
    const cart = [];

    // 商品追加機能
    const addProductButton = document.getElementById('add-product');
    addProductButton.addEventListener('click', () => {
        const name = document.getElementById('product-name').value;
        const price = parseFloat(document.getElementById('product-price').value);
        const quantity = parseInt(document.getElementById('product-quantity').value, 10);

        if (name && !isNaN(price) && !isNaN(quantity)) {
            const product = { name, price, quantity };
            productList.push(product);
            updateProductList();
            document.getElementById('product-name').value = '';
            document.getElementById('product-price').value = '';
            document.getElementById('product-quantity').value = '';
        }
    });

    // 商品リストの表示
    function updateProductList() {
        const productListElement = document.getElementById('product-list');
        productListElement.innerHTML = '';
        productList.forEach((product, index) => {
            const item = document.createElement('li');
            item.textContent = `${product.name} - ${product.price}円 - 在庫: ${product.quantity}`;
            const addToCartButton = document.createElement('button');
            addToCartButton.textContent = 'カートに追加';
            addToCartButton.addEventListener('click', () => addToCart(index));
            item.appendChild(addToCartButton);
            productListElement.appendChild(item);
        });
    }

    // カートに商品を追加
    function addToCart(index) {
        const product = productList[index];
        if (product.quantity > 0) {
            cart.push({ name: product.name, price: product.price });
            product.quantity -= 1;
            updateProductList();
            updateCart();
        } else {
            alert('在庫が不足しています');
        }
    }

    // カートの表示更新
    function updateCart() {
        const cartListElement = document.getElementById('cart-list');
        cartListElement.innerHTML = '';
        let totalPrice = 0;
        cart.forEach((item) => {
            const cartItem = document.createElement('li');
            cartItem.textContent = `${item.name} - ${item.price}円`;
            cartListElement.appendChild(cartItem);
            totalPrice += item.price;
        });
        document.getElementById('total-price').textContent = totalPrice;
    }

    // チェックアウト
    document.getElementById('checkout').addEventListener('click', () => {
        if (cart.length > 0) {
            const historyItem = document.createElement('li');
            historyItem.textContent = `合計: ${document.getElementById('total-price').textContent}円 - ${new Date().toLocaleString()}`;
            document.getElementById('history-list').appendChild(historyItem);

            cart.length = 0;
            updateCart();
            alert('購入が完了しました');
        } else {
            alert('カートが空です');
        }
    });
});
