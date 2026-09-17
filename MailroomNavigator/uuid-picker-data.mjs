// Pure result queries shared by the picker controls, counts and exports.
export function lookupOutcome(row) {
    const item = row.batchItem;
    if (!item) return 'unchecked';
    if (item.error) return 'failed';
    if (!item.result) return 'pending';
    return item.result.found ? 'found' : 'not-found';
}

export function filterPickerRows(rows, { query = '', date = '', outcome = '' } = {}) {
    query = query.trim().toLowerCase();
    date = date.trim().toLowerCase();
    return rows.filter(row => {
        const haystack = `${row.id || ''} ${row.raw || ''}`.toLowerCase();
        return (!query || haystack.includes(query))
            && (!date || String(row.date || '').toLowerCase().includes(date))
            && (!outcome || lookupOutcome(row) === outcome);
    });
}
