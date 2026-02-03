// email.js
import { showToast, extractNameFromEmail } from './utils.js';

// --- 1. Main Conversion Logic ---
export function convertEmails() {
    const inputEl = document.getElementById("inputEmailFormatter");
    const outputEl = document.getElementById("outputEmailFormatter");
    
    if (!inputEl || !outputEl) return;

    // Split by newlines, commas, or semicolons
    const rawEntries = inputEl.value
        .split(/[\n;,]+/)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);

    const parsedList = rawEntries.map(entry => {
        // Look for email pattern inside brackets or plain
        const match = entry.match(/<?([\w.-]+@[\w.-]+\.\w+)>?/);
        if (match) {
            const email = match[1].trim();
            const name = extractNameFromEmail(email);
            return `${name} <${email}>`;
        }
        // If not an email, return as-is
        return entry;
    });

    outputEl.value = parsedList.join(",\n");
    showToast("Emails converted!");
}

// --- 2. Name Only Conversion Logic ---
export function convertEmailsToNamesOnly() {
    const inputEl = document.getElementById("inputEmailFormatter");
    const outputEl = document.getElementById("outputEmailFormatter");

    if (!inputEl || !outputEl) return;

    const rawEntries = inputEl.value
        .split(/[\n;,]+/)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);

    const nameList = rawEntries.map(entry => {
        const match = entry.match(/<?([\w.-]+@[\w.-]+\.\w+)>?/);
        if (match) {
            const email = match[1].trim();
            return extractNameFromEmail(email); // Only return the name part
        }
        return entry;
    });

    outputEl.value = nameList.join(", ");
    showToast("Names extracted!");
}

// --- 3. Copy to Clipboard ---
export function copyEmails() {
    const outputEl = document.getElementById("outputEmailFormatter");
    if (!outputEl) return;
    
    outputEl.select();
    document.execCommand("copy");
    showToast("Email list copied!");
}