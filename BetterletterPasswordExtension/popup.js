
chrome.action.setBadgeText({ text: "Passwd" });

document.getElementById("show-passwords").addEventListener("click", async () => {
  try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.url.includes("app.betterletter.ai/admin_panel/practices/")) {
          showError("Please open a BetterLetter Mailroom page first.");
          return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action: "getPasswords" });

      const list = document.getElementById("password-list");
      list.innerHTML = ""; // Clear previous list

      if (!response || !Array.isArray(response.passwords) || response.passwords.length === 0) {
          showError("No password fields found on this page.");
          return;
      }

      response.passwords.forEach((pwData, i) => {
          const li = document.createElement("li");
          li.innerHTML = `
              <span class="pw-label">${pwData.id || `Field ${i+1}`}:</span>
              <code class="pw-value">${pwData.value || "<em>(empty)</em>"}</code>
          `;
          list.appendChild(li);
      });

  } catch (error) {
      console.error("Popup error:", error);
      showError("Could not connect to content script. Ensure you are on a BetterLetter page and refresh if necessary.");
  }
});

document.getElementById("generate-passwords").addEventListener("click", async () => {
  try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.url.includes("app.betterletter.ai/admin_panel/practices/")) {
          showError("Please open a BetterLetter Mailroom page first.");
          return;
      }

      await chrome.tabs.sendMessage(tab.id, { action: "generatePasswords" });

      showStatus("✓ Passwords generated!", "success");
      // Optionally, refresh the displayed list after generation
      document.getElementById("show-passwords").click();

  } catch (error) {
      console.error("Error generating passwords:", error);
      showStatus("⚠️ Failed to generate passwords.", "error");
  }
});

// Helper functions for UI
function showError(message) {
  const list = document.getElementById("password-list");
  list.innerHTML = `
      <li class="error-message">${message}</li>
  `;
}

function showStatus(message, type) {
  const status = document.getElementById("status-message");
  status.textContent = message;
  status.style.color = type === "success" ? "#28a745" : "#dc3545";

  setTimeout(() => {
      status.textContent = "";
  }, 2000);
}
