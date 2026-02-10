// offscreen.js - Final Robust Silent Engine
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  const handle = async () => {
    console.log(`[Ghost Engine] Received task: ${message.action}`);
    const iframe = document.createElement('iframe');
    iframe.src = message.data.url;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
        console.warn(`[Ghost Engine] Timeout for ${message.action}`);
        resolve({ error: "Scrape failed: Timeout" });
      }, 30000);

      iframe.onload = async () => {
        // Double-check contentDocument to avoid the null error seen in your logs
        if (!iframe.contentDocument || !iframe.contentDocument.body) {
           return; // Keep waiting for the next load event if Phoenix isn't ready
        }

        clearTimeout(timeout);

        try {
          if (message.action === 'scrapePracticeList') {
            // Give LiveView 2 seconds to render the table rows
            await new Promise(r => setTimeout(r, 2000));
            
            const headerCells = Array.from(iframe.contentDocument.querySelectorAll('table thead th'));
            const headers = headerCells.map((th, idx) => ({
              idx,
              text: (th.textContent || '').trim().toLowerCase()
            }));

            const findHeaderIndex = (...keywords) => {
              const hit = headers.find(h => keywords.every(k => h.text.includes(k)));
              return hit ? hit.idx : -1;
            };

            const odsIdx = findHeaderIndex('ods');
            const cdbIdx = findHeaderIndex('cdb');
            const ehrIdx = findHeaderIndex('ehr');
            const quotaIdx = findHeaderIndex('quota');
            const collectedIdx = findHeaderIndex('collected');
            const serviceIdx = findHeaderIndex('service');

            const rows = Array.from(iframe.contentDocument.querySelectorAll('table tbody tr'));
            const data = rows.map(row => {
              const cells = Array.from(row.querySelectorAll('td'));
              const link = row.querySelector('a[href*="/admin_panel/practices/"]');
              if (!link) return null;

              const normalize = (value) => (value || '').trim().replace(/\s+/g, ' ');
              const fromIdx = (idx) => (idx >= 0 ? normalize(cells[idx]?.textContent || '') : '');

              const hrefId = (link.getAttribute('href') || '').split('/').pop() || '';
              const extractedOds = fromIdx(odsIdx).match(/[A-Z]\d{5}/)?.[0] || '';
              const id = hrefId || extractedOds;

              return {
                id,
                ods: id,
                name: normalize(link.textContent).normalize('NFC'),
                cdb: fromIdx(cdbIdx),
                ehrType: fromIdx(ehrIdx),
                collectionQuota: fromIdx(quotaIdx),
                collectedToday: fromIdx(collectedIdx),
                serviceLevel: fromIdx(serviceIdx)
              };
            }).filter(p => p && p.id);

            document.body.removeChild(iframe);
            resolve(data);
          } 
          // Add logic for scrapeCDB here if needed in the future
        } catch (err) {
          console.error(`[Ghost Engine] Internal Error: ${err.message}`);
          if (document.body.contains(iframe)) document.body.removeChild(iframe);
          resolve({ error: `Scrape failed: ${err.message}` });
        }
      };
    });
  };

  handle().then(sendResponse);
  return true;
});
