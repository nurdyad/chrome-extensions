document.addEventListener("DOMContentLoaded", () => {

  const container = document.getElementById("tabs-container");
  const params = new URLSearchParams(window.location.search);
  const sourceWindowId = parseInt(params.get("sourceWindowId"), 10);

  if (!sourceWindowId || isNaN(sourceWindowId)) {
    container.innerHTML = "<p style='color:red;'>Unable to identify the source window.</p>";
    return;

  }

  chrome.tabs.query({ windowId: sourceWindowId }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      container.innerHTML = "<p>No tabs found in this window.</p>";
      return;
    }

    const groupedTabs = new Map();
    let hasGroups = false;

    tabs.forEach((tab) => {
      if (tab.groupId !== -1) {
        hasGroups = true;
        if (!groupedTabs.has(tab.groupId)) groupedTabs.set(tab.groupId, []);
        groupedTabs.get(tab.groupId).push(tab);
      } else {
        renderTabCheckbox(tab, container);
      }
    });

    if (!hasGroups) {
      const note = document.createElement("p");
      note.style.fontStyle = "italic";
      note.style.color = "gray";
      note.textContent = "None of your tabs are grouped.";
      container.appendChild(note);
    }

    for (const [groupId, tabsInGroup] of groupedTabs.entries()) {
      const groupContainer = document.createElement("div");
      groupContainer.style.marginBottom = "10px";
      const groupCheckbox = document.createElement("input");
      groupCheckbox.type = "checkbox";
      groupCheckbox.id = `group-${groupId}`;
      const groupLabel = document.createElement("label");
      groupLabel.htmlFor = `group-${groupId}`;
      groupLabel.style.fontWeight = "bold";
      groupLabel.style.cursor = "pointer";
      groupLabel.style.marginLeft = "5px";
      groupLabel.textContent = `Group ${groupId} ▼`;
      const tabList = document.createElement("div");
      tabList.style.marginLeft = "20px";
      tabList.style.display = "none";

      groupLabel.addEventListener("click", () => {
        const visible = tabList.style.display === "block";
        tabList.style.display = visible ? "none" : "block";
        groupLabel.textContent = `Group ${groupId} ${visible ? "▼" : "▲"}`;
      });

      groupCheckbox.addEventListener("change", () => {
        const checkboxes = tabList.querySelectorAll("input[type=checkbox]");
        checkboxes.forEach(cb => cb.checked = groupCheckbox.checked);
      });

      tabsInGroup.forEach(tab => renderTabCheckbox(tab, tabList));
      const groupHeader = document.createElement("div");
      groupHeader.appendChild(groupCheckbox);
      groupHeader.appendChild(groupLabel);
      groupContainer.appendChild(groupHeader);
      groupContainer.appendChild(tabList);
      container.appendChild(groupContainer);
    }
  });

  document.getElementById("close-tabs").addEventListener("click", () => {
    const selectedIds = Array.from(
      document.querySelectorAll("#tabs-container input:checked")
    ).map(el => parseInt(el.value));

    chrome.tabs.query({ windowId: sourceWindowId }, (tabs) => {
      if (!tabs) return;
      tabs.forEach((tab) => {
        if (!selectedIds.includes(tab.id)) {
          chrome.tabs.remove(tab.id);
        }
      });
    });
  });
});

function renderTabCheckbox(tab, parentEl) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = tab.id;
  checkbox.id = `tab-${tab.id}`;

  const label = document.createElement("label");
  label.htmlFor = `tab-${tab.id}`;
  label.textContent = tab.title || tab.url;

  parentEl.appendChild(checkbox);
  parentEl.appendChild(label);
  parentEl.appendChild(document.createElement("br"));
}