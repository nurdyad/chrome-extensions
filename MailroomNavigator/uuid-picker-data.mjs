// Pure result queries shared by the picker controls, counts and exports.
export function lookupOutcome(row) {
    const item = row.batchItem;
    if (!item) return 'unchecked';
    if (item.error) return 'failed';
    if (!item.result) return 'pending';
    return item.result.found ? 'found' : 'not-found';
}

export function pickerStatus(row) {
    const outcome = lookupOutcome(row);
    if (outcome !== 'found') return outcome;
    const result = row.batchItem.result;
    return `status:${String(result.status || result.botJobStatus || 'unknown').trim().toLowerCase()}`;
}

export function pickerStatusOptions(rows) {
    return [...new Set(rows.map(pickerStatus))].sort().map(value => ({
        value,
        label: value.startsWith('status:') ? `Status: ${value.slice(7).replace(/_/g, ' ')}`
            : ({'not-found':'Not found', failed:'Lookup failed', pending:'Pending', unchecked:'Unchecked'}[value] || value)
    }));
}

export function filterPickerRows(rows, { query = '', date = '', outcome = '', status = '' } = {}) {
    query = query.trim().toLowerCase().replace(/_/g, ' ');
    date = date.trim().toLowerCase();
    return rows.filter(row => {
        const result = row.batchItem?.result || {};
        const haystack = [row.id, row.raw, result.documentId, result.status,
            result.botJobId, result.botJobType, result.botJobStatus,
            result.rejectionReason, result.botJobStatusReason, row.batchItem?.error]
            .filter(value => value != null).join(' ').toLowerCase().replace(/_/g, ' ');
        return (!query || haystack.includes(query))
            && (!date || String(row.date || '').toLowerCase().includes(date))
            && (!outcome || lookupOutcome(row) === outcome)
            && (!status || pickerStatus(row) === status);
    });
}

export function sortPickerRows(rows, order = 'source') {
    if (order === 'source') return [...rows];
    const key = row => order === 'document'
        ? String(row.batchItem?.result?.documentId || '')
        : lookupOutcome(row) === 'found' ? pickerStatus(row).slice(7) : '';
    return rows.map((row, index) => ({ row, index, value: key(row) }))
        .sort((a, b) => {
            if (!a.value || !b.value) return Number(!a.value) - Number(!b.value) || a.index - b.index;
            return a.value.localeCompare(b.value, 'en', { numeric: true, sensitivity: 'base' }) || a.index - b.index;
        }).map(entry => entry.row);
}
