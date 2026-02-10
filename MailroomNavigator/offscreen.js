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
        console.error(`[Ghost Engine] Timeout for ${message.action}`);
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
            
            const rows = Array.from(iframe.contentDocument.querySelectorAll('table tbody tr'));
            const data = rows.map(row => {
              const link = row.querySelector('a[href*="/admin_panel/practices/"]');
              if (!link) return null;
              return {
                id: link.href.split('/').pop(),
                name: link.textContent.trim().normalize('NFC').replace(/\s+/g, ' '),
                cdb: (row.querySelector('td:nth-child(3)')?.textContent || '').trim(),
                ehrType: (row.querySelector('td:nth-child(4)')?.textContent || '').trim()
              };
            }).filter(p => p !== null);

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