// jobs.js - First clean feature
export function setupJobSelection() {
    const openBtn = document.getElementById('openJobStatusBtn');
    const input = document.getElementById('jobStatusInput');

    openBtn?.addEventListener('click', () => {
        const jobId = input.value.trim();
        if (jobId) {
            const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_id=${jobId}`;
            chrome.tabs.create({ url });
        }
    });

    document.getElementById('clearJobStatusInputBtn')?.addEventListener('click', () => {
        if (input) input.value = '';
    });
}