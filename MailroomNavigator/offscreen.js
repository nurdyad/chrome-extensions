// offscreen.js - Final Robust Silent Engine
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  const handle = async () => {
    if (!message?.data?.url) {
      return { error: 'Scrape failed: Missing URL' };
    }

    const iframe = document.createElement('iframe');
    iframe.src = message.data.url;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        iframe.onload = null;
        iframe.onerror = null;
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        finish({ error: 'Scrape failed: Timeout' });
      }, 30000);

      iframe.onerror = () => {
        finish({ error: 'Scrape failed: Frame load error' });
      };

      iframe.onload = async () => {
        const frameDoc = iframe.contentDocument;
        if (!frameDoc || !frameDoc.body) return;

        const frameUrl = frameDoc.location?.href || '';
        if (frameUrl.startsWith('chrome-error://')) {
          finish({ error: 'Scrape failed: Frame error page' });
          return;
        }

        try {
          if (message.action === 'scrapePracticeList') {
            await new Promise(r => setTimeout(r, 2000));

            const headerCells = Array.from(frameDoc.querySelectorAll('table thead th'));
            const headers = headerCells.map((th, idx) => ({
              idx,
              text: (th.textContent || '').trim().toLowerCase()
            }));

            const findHeaderIndex = (...keywords) => {
              const hit = headers.find(h => keywords.every(k => h.text.includes(k)));
              return hit ? hit.idx : -1;
            };

            const fallbackByPosition = {
              ods: 1,
              ehr: 3,
              quota: 4,
              collected: 5,
              service: 6
            };

            const odsIdx = findHeaderIndex('ods') >= 0 ? findHeaderIndex('ods') : fallbackByPosition.ods;
            const cdbIdx = findHeaderIndex('cdb');
            const ehrIdx = findHeaderIndex('ehr') >= 0 ? findHeaderIndex('ehr') : fallbackByPosition.ehr;
            const quotaIdx = findHeaderIndex('quota') >= 0 ? findHeaderIndex('quota') : fallbackByPosition.quota;
            const collectedIdx = findHeaderIndex('collected') >= 0 ? findHeaderIndex('collected') : fallbackByPosition.collected;
            const serviceIdx = findHeaderIndex('service') >= 0 ? findHeaderIndex('service') : fallbackByPosition.service;

            const rows = Array.from(frameDoc.querySelectorAll('table tbody tr'));
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

            finish(data);
            return;
          }

          finish({ error: `Scrape failed: Unsupported action ${message.action}` });
        } catch (err) {
          finish({ error: `Scrape failed: ${err.message}` });
        }
      };
    });
  };

  handle().then(sendResponse);
  return true;
});
