chrome.action.setBadgeText({ text: "Oban" });

document.getElementById("open-oban-link").addEventListener("click", () => {
    const input = document.getElementById("doc-id-input").value.trim();
    const toast = document.getElementById("toast");
  
    if (!/^\d{6}$/.test(input)) {
      toast.textContent = "Please enter a valid 6-digit Document ID.";
      toast.className = "show";
      setTimeout(() => toast.className = "hidden", 3000);
      return;
    }
  
    const url = `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${input}&state=available`;
    chrome.tabs.create({ url });
  });
  