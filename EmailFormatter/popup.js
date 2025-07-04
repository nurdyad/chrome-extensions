chrome.action.setBadgeText({ text: "Email" });

function extractNameFromEmail(email) {
    const localPart = email.split("@")[0];
    const cleaned = localPart.replace(/[._]/g, " ");
    
    return cleaned
      .split(" ")
      .map(w => {
        // Remove numbers (only if not part of a larger word)
        const word = w.replace(/\d+/g, '');
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ")
      .trim();
  }  
  
  document.getElementById("convert").addEventListener("click", () => {
    const input = document.getElementById("input").value;
  
    const rawEntries = input
      .split(/[\n;,]+/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
  
    const parsedList = rawEntries.map(entry => {
      // Try to match email address
      const match = entry.match(/<?([\w.-]+@[\w.-]+\.\w+)>?/);
      if (match) {
        const email = match[1].trim();
        const name = extractNameFromEmail(email);
        return `${name} <${email}>`;
      } else {
        return entry; // fallback
      }
    });
  
    document.getElementById("output").value = parsedList.join(",\n");
  });
  
  document.getElementById("copy").addEventListener("click", () => {
    const output = document.getElementById("output");
    output.select();
    document.execCommand("copy");
  });
  