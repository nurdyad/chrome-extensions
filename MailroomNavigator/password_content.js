// Wrap the entire script in an IIFE to create a private scope
(() => {
    console.log('BetterLetter Password Tools: Script injected and running!'); // Diagnostic log at the very top
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

      triggerInputEvents(input); // Trigger one final time after all characters are in
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
      // Simulate common input events that frameworks might listen for
      const events = ["input", "change", "keyup", "blur"]; // Added blur to ensure final value is registered
      events.forEach(event => {
        input.dispatchEvent(new Event(event, { bubbles: true }));
      });
    }

    function showToast(message) {
      // Remove any existing toasts to prevent stacking
      const existingToast = document.getElementById("bl-password-toast");
      if (existingToast) {
        existingToast.remove();
      }

      const toast = document.createElement("div");
      toast.id = "bl-password-toast"; // Add an ID for easy removal
      toast.textContent = message;
      Object.assign(toast.style, {
        position: "fixed",
        bottom: "60px",
        right: "20px",
        background: "#333",
        color: "#fff",
        padding: "8px 14px",
        borderRadius: "6px",
        zIndex: 9999999, // Ensure it's above the panel
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

    // --- Floating Panel Creation ---

    function createFloatingPanel() {
      const existingPanel = document.getElementById('bl-password-controls-panel');
      if (existingPanel) {
        // If panel already exists, remove it to ensure a clean re-creation, important for dynamic pages
        existingPanel.remove();
      }

      floatingPanel = document.createElement("div");
      floatingPanel.id = "bl-password-controls-panel";
      Object.assign(floatingPanel.style, {
        position: "absolute",
        // Set z-index to a very high value to ensure it's on top of almost everything
        zIndex: "2147483647", // Maximum 32-bit signed integer value
        display: "none", // Start hidden
        flexDirection: "row", // Ensure buttons are in a row
        alignItems: "center",
        gap: "6px",
        background: "#fff",
        padding: "4px 6px",
        border: "1px solid #ccc",
        borderRadius: "6px",
        boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
        whiteSpace: "nowrap",
        pointerEvents: "auto", // Allow mouse events on the panel
        isolation: "isolate", // Creates a new stacking context
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
          minWidth: "auto", // Ensure buttons can shrink/grow
          flexShrink: 0, // Prevent buttons from shrinking too much
        });
        btn.onmouseover = () => btn.style.background = "#e0e0e0";
        btn.onmouseout = () => btn.style.background = "#f0f0f0";
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation(); // Stop propagation to prevent interfering with page logic
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
          input.focus(); // Keep focus on the input after revealing/hiding
        }),
        createBtn("🔄 Generate", (input) => {
          const newPw = generatePassword(input);
          // Store original value before generating a new one
          if (!inputOriginalValues.has(input)) {
            inputOriginalValues.set(input, input.value);
          }
          simulateTyping(input, newPw);
          input.type = "text"; // Automatically reveal generated password
          input.dataset.blPasswordRevealed = "true";
          const revealBtn = floatingPanel.querySelector('button:first-child');
          if (revealBtn) revealBtn.textContent = "🔒 Hide";
          input.focus(); // Keep focus on the input
          showToast("✅ Password generated");
        }),
        createBtn("↩️ Undo", (input) => {
          if (inputOriginalValues.has(input)) {
            input.value = inputOriginalValues.get(input);
            inputOriginalValues.delete(input); // Clear history after undo
            triggerInputEvents(input);
            input.focus(); // Keep focus on the input
            showToast("↩️ Undo complete");
          } else {
            showToast("No value to undo.");
          }
        }),
        createBtn("📋 Copy", (input) => {
          copyToClipboard(input.value);
          input.focus(); // Keep focus on the input
          showToast("📋 Copied!");
        })
      );

      document.body.appendChild(floatingPanel);
      return floatingPanel;
    }

    // --- Panel Positioning ---

    function updatePanelPosition(input) {
      if (!floatingPanel || !input || !document.body.contains(input)) {
        hideFloatingControls(); // Hide if input is no longer in DOM
        return;
      }

      const rect = input.getBoundingClientRect();
      const panelRect = floatingPanel.getBoundingClientRect(); // Get current panel dimensions
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let left = rect.left + scrollX;
      let top = rect.bottom + 4 + scrollY; // Position below the input

      // Adjust if panel goes off right edge
      if (left + panelRect.width > viewportWidth + scrollX - 10) {
        left = viewportWidth + scrollX - panelRect.width - 10;
      }
      // Adjust if panel goes off left edge
      if (left < scrollX + 10) {
        left = scrollX + 10;
      }

      // If panel goes off bottom edge, try to position above the input
      if (top + panelRect.height > viewportHeight + scrollY - 10) {
        top = rect.top - panelRect.height - 4 + scrollY;
        if (top < scrollY + 10) { // If it still goes off top, just put it below at max allowed height
          top = rect.bottom + 4 + scrollY;
        }
      }

      floatingPanel.style.left = `${left}px`;
      floatingPanel.style.top = `${top}px`;
    }

    function showFloatingControls(input) {
      // Ensure the panel is created first if it doesn't exist
      createFloatingPanel(); 

      // If the same input is already active and panel is visible, do nothing
      if (currentInput === input && floatingPanel.style.display === 'flex') {
          return;
      }

      currentInput = input;
      
      const revealBtn = floatingPanel.querySelector('button:first-child');
      if (revealBtn) {
        // Update the button text based on the current input type
        revealBtn.textContent = currentInput.type === "text" || currentInput.dataset.blPasswordRevealed === "true" ? "🔒 Hide" : "👁 Reveal";
      }

      floatingPanel.style.display = "flex";
      floatingPanel.style.visibility = "visible"; // Ensure visibility is not hidden by previous state

      updatePanelPosition(currentInput);

      // Start animation frame only if not already running
      if (!positionAnimationFrameId) {
        const animatePosition = () => {
          if (currentInput && floatingPanel.style.display === 'flex' && document.body.contains(currentInput)) {
            updatePanelPosition(currentInput);
            positionAnimationFrameId = requestAnimationFrame(animatePosition);
          } else {
            // Stop animation if input is gone or panel is hidden
            cancelAnimationFrame(positionAnimationFrameId);
            positionAnimationFrameId = null;
          }
        };
        positionAnimationFrameId = requestAnimationFrame(animatePosition);
      }
    }

    function hideFloatingControls() {
      if (floatingPanel) {
        floatingPanel.style.display = "none";
        floatingPanel.style.visibility = "hidden"; // Also hide visibility
      }
      if (positionAnimationFrameId) {
        cancelAnimationFrame(positionAnimationFrameId);
        positionAnimationFrameId = null;
      }
      currentInput = null; // Clear current input when hiding
    }

    // --- Event Listeners ---

    document.addEventListener("focusin", (e) => {
      const target = e.target;
      // Check if target is an input and relevant for password tools
      if (target.tagName === "INPUT" && (target.type === "password" || target.dataset.blPasswordRevealed === "true")) {
        showFloatingControls(target);
      } else if (floatingPanel && floatingPanel.contains(target)) {
        // If focus is within the panel, do nothing (don't hide)
        return;
      } else {
        // If focus moves to something else, hide the panel after a short delay
        setTimeout(() => {
          if (floatingPanel && !floatingPanel.contains(document.activeElement)) {
            hideFloatingControls();
          }
        }, 150); // Increased delay for more robustness
      }
    });

    document.addEventListener("focusout", (e) => {
      // Use a longer timeout to allow focus to shift between input and panel buttons
      setTimeout(() => {
        // Only hide if the current active element is NOT the current input
        // AND NOT inside the floating panel itself.
        if (currentInput && document.activeElement !== currentInput &&
            floatingPanel && !floatingPanel.contains(document.activeElement)) {
          hideFloatingControls();
        }
      }, 150); // Increased delay
    });


    let resizeScrollTimeout;
    const debouncedUpdatePosition = () => {
      clearTimeout(resizeScrollTimeout);
      resizeScrollTimeout = setTimeout(() => {
        if (currentInput && floatingPanel && floatingPanel.style.display === 'flex') {
          updatePanelPosition(currentInput);
        }
      }, 50);
    };
    window.addEventListener('scroll', debouncedUpdatePosition, true);
    window.addEventListener('resize', debouncedUpdatePosition);

    // --- MutationObserver ---
    const observer = new MutationObserver((mutationsList) => {
      if (currentInput && !document.body.contains(currentInput)) {
        // If the currently monitored input is removed from DOM, hide controls
        hideFloatingControls();
      }
      mutationsList.forEach(mutation => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            // If an input is added, or an input changes type
            if (node.nodeType === 1 && node.matches('input[type="password"]')) {
              showFloatingControls(node);
            }
          });
        } else if (mutation.type === 'attributes' && mutation.attributeName === 'type') {
          const target = mutation.target;
          if (target.matches('input') && target.type === 'password') {
            showFloatingControls(target);
          }
        }
      });
    });
    // Observe changes to the body and its subtree for added nodes and attribute changes on inputs
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });


    // --- Popup Communication (kept as is, no changes needed for this problem) ---

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "getPasswords") {
        const passwordInputs = Array.from(document.querySelectorAll('input[type="password"], input[data-bl-password-revealed="true"]'));
        const passwords = passwordInputs.map(input => ({
          value: input.value,
          id: input.id || input.name || `(Field ${Array.from(document.querySelectorAll('input')).indexOf(input) + 1})`
        }));
        sendResponse({ passwords });
        return true;
      }

      if (request.action === "generatePasswords") {
        const passwordInputs = Array.from(document.querySelectorAll('input[type="password"], input[data-bl-password-revealed="true"]'));
        passwordInputs.forEach((input, index) => {
          const newPw = generatePassword(input);
          if (!inputOriginalValues.has(input)) {
            inputOriginalValues.set(input, input.value);
          }
          simulateTyping(input, newPw); // Use simulateTyping for consistent event triggering
          input.type = "text";
          input.dataset.blPasswordRevealed = "true";
          // No need to call showToast here, as it's a bulk operation from popup
        });
        sendResponse({ status: "done" });
        return true;
      }
    });

    // --- Startup ---
    // Ensure createFloatingPanel is called once the DOM is ready.
    // This handles cases where the script loads before or after DOMContentLoaded.
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      createFloatingPanel();
      // Immediately check for existing password inputs on load
      document.querySelectorAll('input[type="password"]').forEach(input => {
        if (document.activeElement === input) { // Only show if it's the currently focused one
            showFloatingControls(input);
        }
      });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        createFloatingPanel();
        // After DOM is loaded, check for any pre-existing password inputs
        document.querySelectorAll('input[type="password"]').forEach(input => {
            if (document.activeElement === input) {
                showFloatingControls(input);
            }
        });
      });
    }
})(); // End of IIFE