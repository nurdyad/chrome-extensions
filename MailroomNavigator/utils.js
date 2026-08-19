// Shared UI/helpers used across panel modules.
let toastHideTimer = null;
let toastFadeTimer = null;

// Delays a function call (prevents rapid firing)
export function debounce(func, timeout = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}

// Safely sets HTML content
export function safeSetInnerHTML(element, content) {
  if (element && element.innerHTML !== undefined) {
    element.innerHTML = content;
  } else {
    console.warn('Attempted to set innerHTML on missing element:', element?.id);
  }
}

// Shows/Hides a loading spinner on inputs
export function toggleLoadingState(element, isLoading) {
  if (!element) return;
  element.classList.toggle('loading-state', isLoading);
}

// Shows a popup message (toast)
export function showToast(message) {
    let toastEl = document.getElementById("toast");
    if (!toastEl && document.body) {
        toastEl = document.createElement("div");
        toastEl.id = "toast";
        toastEl.setAttribute("aria-live", "polite");
        toastEl.setAttribute("aria-atomic", "true");
        toastEl.style.display = "none";
        document.body.appendChild(toastEl);
    }
    if (!toastEl) return;

    if (toastHideTimer) {
        clearTimeout(toastHideTimer);
        toastHideTimer = null;
    }
    if (toastFadeTimer) {
        clearTimeout(toastFadeTimer);
        toastFadeTimer = null;
    }

    toastEl.textContent = message;
    toastEl.classList.add("show"); // Uses the CSS class for animation
    toastEl.style.display = "block"; // Ensure it's visible
    
    // Hide after 2 seconds
    toastHideTimer = setTimeout(() => {
        toastEl.classList.remove("show");
        toastFadeTimer = setTimeout(() => {
            toastEl.style.display = "none";
            toastFadeTimer = null;
        }, 300); // Wait for fade out
        toastHideTimer = null;
    }, 2000);
}

// Shows status messages in the Navigator tab
export function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = type;
    statusEl.style.display = 'block';
  } else {
    console.warn("Status element not found in DOM:", message);
  }
}

export function hideStatus() {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  statusEl.textContent = '';
  statusEl.className = '';
  statusEl.style.display = 'none';
}

function canUseNavigatorClipboardApi() {
    try {
        const protocol = String(globalThis?.location?.protocol || '').toLowerCase();
        if (protocol !== 'chrome-extension:' && protocol !== 'moz-extension:') {
            return false;
        }

        const policy = document?.permissionsPolicy || document?.featurePolicy;
        if (policy && typeof policy.allowsFeature === 'function') {
            return policy.allowsFeature('clipboard-write');
        }

        return true;
    } catch (error) {
        return false;
    }
}

function copyTextViaBackground(value) {
    return new Promise((resolve) => {
        try {
            if (!chrome?.runtime?.sendMessage) {
                resolve(false);
                return;
            }

            chrome.runtime.sendMessage(
                { action: 'copyTextToClipboard', value },
                (response) => {
                    if (chrome.runtime.lastError) {
                        resolve(false);
                        return;
                    }
                    resolve(Boolean(response?.success));
                }
            );
        } catch (error) {
            resolve(false);
        }
    });
}

export async function copyTextToClipboard(text) {
    const value = String(text ?? '');
    if (!value) return false;

    if (await copyTextViaBackground(value)) {
        return true;
    }

    try {
        if (canUseNavigatorClipboardApi() && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch (error) {
        // Fall back to execCommand below.
    }

    try {
        if (!document?.body) return false;
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.top = '-9999px';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const copied = document.execCommand('copy');
        textarea.remove();
        return Boolean(copied);
    } catch (error) {
        return false;
    }
}

// Opens a new browser tab safely
export function openTabWithTimeout(url) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) return;

    const handleError = (err) => {
        const message = String(err?.message || err || '');
        if (message.toLowerCase().includes('extension context invalidated')) {
            console.warn('Extension context invalidated while opening tab.');
            showToast('Extension reloaded. Refresh this page and reopen the panel.');
            return;
        }
        console.error('Failed to open tab:', err);
        showToast('Failed to open page.');
    };

    try {
        if (chrome?.runtime?.sendMessage) {
            chrome.runtime.sendMessage(
                { action: 'openUrlInNewTab', url: targetUrl },
                (response) => {
                    if (chrome.runtime.lastError) {
                        handleError(chrome.runtime.lastError);
                        return;
                    }
                    if (!response?.success) {
                        handleError(new Error(response?.error || 'Failed to open page.'));
                    }
                }
            );
            return;
        }

        if (!chrome?.tabs?.create) {
            throw new Error('chrome.tabs API unavailable.');
        }
        const result = chrome.tabs.create({ url: targetUrl });
        if (result && typeof result.catch === 'function') {
            result.catch(handleError);
        }
    } catch (err) {
        handleError(err);
    }
}

// Extract Name from "Name <email@example.com>"
export function extractNameFromEmail(email) {
    const localPart = email.split("@")[0];
    const cleaned = localPart.replace(/[._]/g, " ");
    return cleaned
      .split(" ")
      .map(w => {
        const word = w.replace(/\d+/g, '');
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ")
      .trim();
}
