export function initializeAccountBook() {
    const addBtn = document.getElementById('ab-add-entry');
    const exportBtn = document.getElementById('ab-export-csv');
    const ledgerBody = document.getElementById('ab-ledger-body');
    const totalIncomeEl = document.getElementById('ab-total-income');
    const totalExpenseEl = document.getElementById('ab-total-expense');
    const balanceEl = document.getElementById('ab-balance');

    if (!addBtn || !exportBtn || !ledgerBody || !totalIncomeEl || !totalExpenseEl || !balanceEl) {
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

    function exportToCSV() {
        let csv = 'date,item,category,income,expense\n';
        entries.forEach(e => {
            const income = e.type === 'income' ? e.amount : '';
            const expense = e.type === 'expense' ? e.amount : '';
            csv += `"${e.date}","${e.item}","${e.category}",${income},${expense}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'accountBook.csv';
        a.click();
        URL.revokeObjectURL(url);
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

    exportBtn.addEventListener('click', exportToCSV);

    renderLedger();
}

document.addEventListener('DOMContentLoaded', initializeAccountBook);
