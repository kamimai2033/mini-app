export function initializeAccountBook() {
    const addBtn = document.getElementById('ab-add-entry');
    const ledgerBody = document.getElementById('ab-ledger-body');
    const totalIncomeEl = document.getElementById('ab-total-income');
    const totalExpenseEl = document.getElementById('ab-total-expense');
    const balanceEl = document.getElementById('ab-balance');

    if (!addBtn || !ledgerBody || !totalIncomeEl || !totalExpenseEl || !balanceEl) {
        console.error('家計簿UIの要素が見つかりません');
        return;
    }

    let entries = JSON.parse(localStorage.getItem('accountEntries') || '[]');

    function saveEntries() {
        localStorage.setItem('accountEntries', JSON.stringify(entries));
    }

    function renderLedger() {
        ledgerBody.innerHTML = '';
        let totalIncome = 0;
        let totalExpense = 0;
        entries.forEach((e) => {
            const row = document.createElement('tr');
            row.innerHTML = `<td>${e.date}</td><td>${e.item}</td><td>${e.category}</td><td>${e.type === 'income' ? e.amount : ''}</td><td>${e.type === 'expense' ? e.amount : ''}</td>`;
            ledgerBody.appendChild(row);
            if (e.type === 'income') totalIncome += e.amount;
            else totalExpense += e.amount;
        });
        totalIncomeEl.textContent = totalIncome.toFixed(2);
        totalExpenseEl.textContent = totalExpense.toFixed(2);
        balanceEl.textContent = (totalIncome - totalExpense).toFixed(2);
    }

    addBtn.addEventListener('click', () => {
        const itemInput = document.getElementById('ab-item');
        const categoryInput = document.getElementById('ab-category');
        const amountInput = document.getElementById('ab-amount');
        const type = document.querySelector('input[name="ab-type"]:checked').value;

        const item = itemInput.value.trim();
        const category = categoryInput.value.trim();
        const amount = parseFloat(amountInput.value);
        if (!item || isNaN(amount)) return;

        const entry = {
            date: new Date().toLocaleString(),
            item,
            category,
            amount,
            type
        };
        entries.push(entry);
        saveEntries();
        renderLedger();

        itemInput.value = '';
        categoryInput.value = '';
        amountInput.value = '';
    });

    renderLedger();
}

document.addEventListener('DOMContentLoaded', initializeAccountBook);
