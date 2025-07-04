// Set initial badge text and color

chrome.action.setBadgeText({ text: "Tools" });

chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" }); // Green badge



document.addEventListener("DOMContentLoaded", () => {

const modeSelector = document.getElementById("mode-selector");

const sectionContainer = document.getElementById("section-container");



// Helper: Show the appropriate section

function showSection(sectionId) {

document.querySelectorAll("#section-container > div").forEach((el) => {

el.style.display = "none";

});

const section = document.getElementById(sectionId);

if (section) section.style.display = "block";

}



// Handle switching between modes

modeSelector.addEventListener("change", (e) => {

const selected = e.target.value;



if (selected === "open-links") {

showSection("open-links-section");

} else if (selected === "close-tabs") {

showSection("close-tabs-section");

loadTabs(); // Only load when needed

}

});



// Default section

showSection("open-links-section");



// -------------------------------

// Open Links Logic

// -------------------------------

document.getElementById("open-mode").addEventListener("change", (event) => {

const mode = event.target.value;

const amountInput = document.getElementById("amount-input");

amountInput.style.display = (mode === "amount") ? "inline" : "none";

});



document.getElementById("open-links").addEventListener("click", () => {

const mode = document.getElementById("open-mode").value;

const amount = parseInt(document.getElementById("amount-input").value) || 0;



chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {

chrome.scripting.executeScript({

target: { tabId: tabs[0].id },

func: openDocumentLinks,

args: [mode, amount]

});

});

});



function openDocumentLinks(mode, amount) {

const baseUrl = "https://app.betterletter.ai/mailroom/id-resolution/";

const rows = document.querySelectorAll("tr[data-test-id]");

let count = 0;



rows.forEach((row) => {

if (mode === "amount" && count >= amount) return;

const dataTestId = row.getAttribute("data-test-id");

const documentId = dataTestId?.replace("document-row-", "");

if (documentId) {

window.open(`${baseUrl}${documentId}`, "_blank");

count++;

}

});



if (mode === "amount" && count < amount) {

console.warn("Requested amount exceeds available links.");

}

}



// -------------------------------

// Close Tabs Logic

// -------------------------------

function loadTabs() {

const container = document.getElementById("tabs-container");

container.innerHTML = "Loading...";


chrome.runtime.sendMessage({ action: "getMainWindowTabs" }, (response) => {

if (chrome.runtime.lastError) {

container.innerHTML = `<p style="color:red;">Error: ${chrome.runtime.lastError.message}</p>`;

return;

}


container.innerHTML = "";

const tabs = response.tabs || [];

const groupedTabs = new Map();


tabs.forEach((tab) => {

if (tab.groupId !== -1) {

if (!groupedTabs.has(tab.groupId)) {

groupedTabs.set(tab.groupId, []);

}

groupedTabs.get(tab.groupId).push(tab);

} else {

// Un-grouped tab

const checkbox = document.createElement("input");

checkbox.type = "checkbox";

checkbox.value = tab.id;

checkbox.id = `tab-${tab.id}`;


const label = document.createElement("label");

label.htmlFor = `tab-${tab.id}`;

label.textContent = tab.title || tab.url;


container.appendChild(checkbox);

container.appendChild(label);

container.appendChild(document.createElement("br"));

}

});


for (const [groupId, groupTabs] of groupedTabs.entries()) {

const groupContainer = document.createElement("div");

groupContainer.style.marginBottom = "10px";


// Group checkbox

const groupCheckbox = document.createElement("input");

groupCheckbox.type = "checkbox";

groupCheckbox.id = `group-${groupId}`;


// Group label that acts like a toggle

const groupLabel = document.createElement("label");

groupLabel.htmlFor = `group-${groupId}`;

groupLabel.style.fontWeight = "bold";

groupLabel.style.cursor = "pointer";

groupLabel.style.marginLeft = "5px";

groupLabel.textContent = `Group ${groupId} ▼`;


// Container for child tabs

const tabList = document.createElement("div");

tabList.style.marginLeft = "20px";

tabList.style.display = "none";


groupTabs.forEach((tab) => {

const tabCheckbox = document.createElement("input");

tabCheckbox.type = "checkbox";

tabCheckbox.value = tab.id;

tabCheckbox.className = `group-tab-${groupId}`;

tabCheckbox.id = `tab-${tab.id}`;


const tabLabel = document.createElement("label");

tabLabel.textContent = tab.title || tab.url;

tabLabel.htmlFor = `tab-${tab.id}`;


tabList.appendChild(tabCheckbox);

tabList.appendChild(tabLabel);

tabList.appendChild(document.createElement("br"));

});


// Group toggle logic

groupLabel.addEventListener("click", () => {

const isVisible = tabList.style.display === "block";

tabList.style.display = isVisible ? "none" : "block";

groupLabel.textContent = `Group ${groupId} ${isVisible ? "▼" : "▲"}`;

});


// Group checkbox logic

groupCheckbox.addEventListener("change", (e) => {

const checkboxes = tabList.querySelectorAll("input[type=checkbox]");

checkboxes.forEach(cb => cb.checked = groupCheckbox.checked);

});


const groupHeader = document.createElement("div");

groupHeader.appendChild(groupCheckbox);

groupHeader.appendChild(groupLabel);


groupContainer.appendChild(groupHeader);

groupContainer.appendChild(tabList);

container.appendChild(groupContainer);

}

});

}



document.getElementById("close-tabs").addEventListener("click", () => {

const selectedTabIds = Array.from(

document.querySelectorAll("#tabs-container input:checked")

).map((el) => parseInt(el.value));



chrome.runtime.sendMessage({ action: "getMainWindowTabs" }, (response) => {

if (!response || !response.tabs) return;



response.tabs.forEach((tab) => {

if (!selectedTabIds.includes(tab.id)) {

chrome.tabs.remove(tab.id);

}

});

});

});

});

