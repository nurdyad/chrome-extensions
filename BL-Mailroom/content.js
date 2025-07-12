// --- Global State Management ---
console.log('BetterLetter Password Tools: content.js injected and running!'); // NEW: Diagnostic log at the very top
let floatingPanel = null;
let currentInput = null;
let inputOriginalValues = new WeakMap();
let positionAnimationFrameId = null;

// --- Utility Functions ---

function simulateTyping(input, text) {
  input.focus();
  input.value = "";

  for (let i = 0; i < text.length; i++) {
    input.value += text[i];
    triggerInputEvents(input);
  }

  triggerInputEvents(input);
}

function findNearbyLabelText(input) {
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label.textContent.trim();
  }

  let parent = input.parentElement;
  while (parent && parent !== document.body) {
    const labelLike = parent.querySelector("label, span, h2, h3, legend");
    if (labelLike && labelLike.textContent.length > 0) {
      return labelLike.textContent.trim();
    }
    parent = parent.parentElement;
  }

  return "";
}

function generatePassword(input = null) {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const specials = '!@#$%^&*()';
    
    const findNearbyLabelText = (inputEl) => {
      if (!inputEl) return '';
      let el = inputEl;
      let tries = 0;
      while (el && tries < 5) {
        const text = el.closest('section, div, form')?.innerText || '';
        if (/docman/i.test(text)) return 'docman';
        if (/web/i.test(text)) return 'web';
        el = el.parentElement;
        tries++;
      }
      return '';
    };
  
    const context = findNearbyLabelText(input);
    const includeSpecials = /docman/i.test(context);
  
    const all = includeSpecials ? upper + lower + digits + specials : upper + lower + digits;
  
    const getRandom = str => str[Math.floor(Math.random() * str.length)];
  
    const guaranteed = [
      getRandom(upper),
      getRandom(lower),
      getRandom(digits),
    ];
  
    if (includeSpecials) guaranteed.push(getRandom(specials));
  
    const remainingLength = includeSpecials ? 6 : 7;
    const remaining = Array.from({ length: remainingLength }, () => getRandom(all));
  
    const passwordArray = guaranteed.concat(remaining);
  
    for (let i = passwordArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [passwordArray[i], passwordArray[j]] = [passwordArray[j], passwordArray[i]];
    }
  
    return passwordArray.join('');
  }
  

function copyToClipboard(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch (err) {
    console.error('Failed to copy:', err);
  } finally {
    document.body.removeChild(textarea);
  }
}

function triggerInputEvents(input) {
  const events = ["input", "change", "keyup"];
  events.forEach(event => {
    input.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "60px",
    right: "20px",
    background: "#333",
    color: "#fff",
    padding: "8px 14px",
    borderRadius: "6px",
    zIndex: 999999,
    fontSize: "13px",
    fontWeight: "bold",
    boxShadow: "0 4px 8px rgba(0,0,0,0.2)",
    opacity: 0,
    transition: "opacity 0.2s ease-in-out",
  });

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = 1;
  });

  setTimeout(() => {
    toast.style.opacity = 0;
    setTimeout(() => toast.remove(), 200);
  }, 2000);
}

// --- Floating Panel Creation (for on-page buttons) ---
// This floating panel will still appear directly on the web page, 
// as its logic is self-contained in content.js

function createFloatingPanel() {
  if (floatingPanel) return;

  floatingPanel = document.createElement("div");
  floatingPanel.id = "bl-password-controls-panel";
  Object.assign(floatingPanel.style, {
    position: "absolute",
    // Set z-index to a very high value to ensure it's on top
    zIndex: "2147483647", // Maximum 32-bit signed integer value
    display: "none",
    gap: "6px",
    background: "#fff",
    padding: "4px 6px",
    border: "1px solid #ccc",
    borderRadius: "6px",
    boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
    whiteSpace: "nowrap",
    pointerEvents: "auto",
    isolation: "isolate",
  });

  const createBtn = (label, handler) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    Object.assign(btn.style, {
      background: "#f0f0f0",
      border: "1px solid #ddd",
      borderRadius: "3px",
      padding: "4px 8px",
      cursor: "pointer",
      fontSize: "14px",
      lineHeight: "1",
      color: "#333",
    });
    btn.onmouseover = () => btn.style.background = "#e0e0e0";
    btn.onmouseout = () => btn.style.background = "#f0f0f0";
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentInput) handler(currentInput);
    };
    return btn;
  };

  floatingPanel.append(
    createBtn("👁 Reveal", (input) => {
      const isRevealed = input.type === "text";
      input.type = isRevealed ? "password" : "text";
      input.dataset.blPasswordRevealed = !isRevealed ? "true" : "false";
      const revealBtn = floatingPanel.querySelector('button:first-child');
      if (revealBtn) revealBtn.textContent = isRevealed ? "👁 Reveal" : "🔒 Hide";
    }),
    createBtn("🔄 Generate", (input) => {
      const newPw = generatePassword(input);
      inputOriginalValues.set(input, input.value);
      simulateTyping(input, newPw);
      input.type = "text";
      input.dataset.blPasswordRevealed = "true";
      const revealBtn = floatingPanel.querySelector('button:first-child');
      if (revealBtn) revealBtn.textContent = "🔒 Hide";
      setTimeout(() => showFloatingControls(input), 50);
      showToast("✅ Password generated");
    }),
    createBtn("↩️ Undo", (input) => {
      if (inputOriginalValues.has(input)) {
        input.value = inputOriginalValues.get(input);
        inputOriginalValues.delete(input);
        triggerInputEvents(input);
        showToast("↩️ Undo complete");
      }
    }),
    createBtn("📋 Copy", (input) => {
      copyToClipboard(input.value);
      showToast("📋 Copied!");
    })
  );

  document.body.appendChild(floatingPanel);
}

// --- Panel Positioning ---

function updatePanelPosition(input) {
  if (!floatingPanel || !input || !document.body.contains(input)) return;

  const wasHidden = floatingPanel.style.display === "none";
  if (wasHidden) {
    floatingPanel.style.visibility = "hidden";
    document.body.appendChild(floatingPanel);
    floatingPanel.style.display = "flex";
    updatePanelPosition(currentInput);
  }

  const rect = input.getBoundingClientRect();
  const panelRect = floatingPanel.getBoundingClientRect();
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  const viewportWidth = window.innerWidth;

  let left = rect.left + scrollX;
  let top = rect.bottom + 4 + scrollY;

  if (left + panelRect.width > viewportWidth - 10) {
    left = viewportWidth - panelRect.width - 10;
  }

  floatingPanel.style.left = `${left}px`;
  floatingPanel.style.top = `${top}px`;

  if (wasHidden) {
    floatingPanel.style.display = "none";
    floatingPanel.style.visibility = "visible";
  }
}

function showFloatingControls(input) {
  if (currentInput === input && floatingPanel.style.display !== 'none') return;

  currentInput = input;
  createFloatingPanel();

  const revealBtn = floatingPanel.querySelector('button:first-child');
  if (revealBtn) {
    revealBtn.textContent = currentInput.type === "text" ? "🔒 Hide" : "👁 Reveal";
  }

  floatingPanel.style.display = "flex";
  updatePanelPosition(currentInput);

  if (!positionAnimationFrameId) {
    const animatePosition = () => {
      if (currentInput && floatingPanel.style.display !== 'none' && document.body.contains(currentInput)) {
        updatePanelPosition(currentInput);
        positionAnimationFrameId = requestAnimationFrame(animatePosition);
      } else {
        positionAnimationFrameId = null;
      }
    };
    positionAnimationFrameId = requestAnimationFrame(animatePosition);
  }
}

function hideFloatingControls() {
  if (floatingPanel && floatingPanel.style.display !== 'none') {
    floatingPanel.style.display = "none";
    if (positionAnimationFrameId) {
      cancelAnimationFrame(positionAnimationFrameId);
      positionAnimationFrameId = null;
    }
  }
  currentInput = null;
}

// --- Event Listeners ---

document.addEventListener("focusin", (e) => {
  const target = e.target;
  if (target.tagName === "INPUT" && (target.type === "password" || target.dataset.blPasswordRevealed === "true")) {
    showFloatingControls(target);
  } else {
    setTimeout(() => {
      if (floatingPanel && !floatingPanel.contains(document.activeElement)) {
        hideFloatingControls();
      }
    }, 100);
  }
});

document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (currentInput && document.activeElement !== currentInput &&
        floatingPanel && !floatingPanel.contains(document.activeElement)) {
      hideFloatingControls();
    }
  }, 50);
});

let resizeScrollTimeout;
const debouncedUpdatePosition = () => {
  clearTimeout(resizeScrollTimeout);
  resizeScrollTimeout = setTimeout(() => {
    if (currentInput && floatingPanel.style.display !== 'none') {
      updatePanelPosition(currentInput);
    }
  }, 50);
};
window.addEventListener('scroll', debouncedUpdatePosition, true);
window.addEventListener('resize', debouncedUpdatePosition);

// --- Popup Communication (for messages from the extension popup) ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getPasswords") {
    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"], input[data-bl-password-revealed="true"]'));
    const passwords = passwordInputs.map(input => ({
      value: input.value,
      id: input.id || input.name || `(Field ${Array.from(document.querySelectorAll('input')).indexOf(input) + 1})`
    }));
    sendResponse({ passwords });
    return true; // Indicate that sendResponse will be called asynchronously
  }

  if (request.action === "generatePasswords") {
    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"], input[data-bl-password-revealed="true"]'));
    passwordInputs.forEach((input, index) => {
      const newPw = generatePassword(input);
      inputOriginalValues.set(input, input.value);
      input.value = newPw;
      input.type = "text";
      input.dataset.blPasswordRevealed = "true";
      triggerInputEvents(input);
    });
    sendResponse({ status: "done" });
    return true; // Indicate that sendResponse will be called asynchronously
  }
});

// --- Startup ---
document.addEventListener('DOMContentLoaded', createFloatingPanel);