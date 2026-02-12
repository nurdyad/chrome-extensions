(function () {
  function uuidPickerTool() {
    const existingPanel = document.getElementById('uuid-picker-v6');
    if (existingPanel) existingPanel.remove();

    const regex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const foundUuids = [...new Set((document.body.innerHTML.match(regex) || []).map(item => item.toLowerCase()))];
    if (foundUuids.length === 0) {
      alert('No UUIDs found');
      return;
    }

    const getRowData = (uuid) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      const normalizedUuid = String(uuid || '').toLowerCase();
      let node;
      while ((node = walker.nextNode())) {
        const textContent = String(node.textContent || '');
        if (textContent.toLowerCase().includes(normalizedUuid)) {
          const parentRow = node.parentElement?.closest('tr');
          let dateStr = 'N/A';
          if (parentRow) {
            const cells = parentRow.querySelectorAll('td');
            if (cells.length >= 8) dateStr = cells[7].textContent.trim();
          }
          return { raw: textContent.trim(), date: dateStr };
        }
      }
      return { raw: uuid, date: 'N/A' };
    };

    const dataMap = foundUuids.map(id => {
      const rowData = getRowData(id);
      return { id, sql: `'${id}'`, raw: rowData.raw, date: rowData.date, copied: false };
    });

    let currentMode = 'SQL';
    const div = document.createElement('div');
    div.id = 'uuid-picker-v6';
    div.style = 'position:fixed; top:20px; right:20px; width:380px; max-height:85vh; overflow:hidden; background:white; border:1px solid #ccc; border-radius:12px; display:flex; flex-direction:column; z-index:999999; box-shadow:0 10px 40px rgba(0,0,0,0.25); font-family: sans-serif;';

    div.innerHTML = `
      <div style="padding:15px; border-bottom:1px solid #eee; background:#fff; position:relative;">
        <div id="close-x" style="position:absolute; top:10px; right:15px; cursor:pointer; font-size:22px; color:#aaa; line-height:1;">&times;</div>
        <h3 style="margin:0 0 12px 0; font-size:18px; color:#333;">UUID Picker</h3>
        <div style="display:flex; gap:5px; margin-bottom:12px;">
          <button class="mode-btn" data-mode="SQL" style="flex:1; padding:8px; cursor:pointer; border-radius:6px; border:1px solid #007bff; background:#007bff; color:white; font-size:11px; font-weight:bold;">SQL</button>
          <button class="mode-btn" data-mode="RAW" style="flex:1; padding:8px; cursor:pointer; border-radius:6px; border:1px solid #ccc; background:#f8f9fa; color:#333; font-size:11px; font-weight:bold;">RAW</button>
          <button class="mode-btn" data-mode="UUID" style="flex:1; padding:8px; cursor:pointer; border-radius:6px; border:1px solid #ccc; background:#f8f9fa; color:#333; font-size:11px; font-weight:bold;">UUID</button>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:12px;">
          <button id="copy-all-btn" style="flex:3; padding:10px; cursor:pointer; background:#28a745; color:white; border:none; border-radius:6px; font-weight:600; font-size:13px;">Copy All Visible</button>
          <button id="export-btn" title="Export to Text" style="flex:1; padding:10px; cursor:pointer; background:#6c757d; color:white; border:none; border-radius:6px; font-size:12px;">Export 💾</button>
        </div>
        <div style="display:flex; gap:5px;">
          <input type="text" id="uuid-search" placeholder="Search ID..." style="flex:2; padding:8px; border:1px solid #ddd; border-radius:6px; box-sizing:border-box; outline:none; font-size:12px;">
          <input type="text" id="date-filter" placeholder="Filter Date..." style="flex:1; padding:8px; border:1px solid #ddd; border-radius:6px; box-sizing:border-box; outline:none; font-size:12px;">
        </div>
      </div>
      <div id="uuid-list-container" style="overflow-y:auto; padding:10px; background:#fafafa; flex-grow:1;"></div>
      <div id="footer-count" style="padding:10px; font-size:11px; color:#888; text-align:center; border-top:1px solid #eee; background:#fff;">Found ${foundUuids.length} IDs</div>
    `;

    document.body.appendChild(div);
    const listContainer = document.getElementById('uuid-list-container');
    const searchInput = document.getElementById('uuid-search');
    const dateInput = document.getElementById('date-filter');

    const getDisplayValue = (item) => (currentMode === 'SQL' ? item.sql : (currentMode === 'RAW' ? item.raw : item.id));

    const renderList = () => {
      const filter = searchInput.value.toLowerCase();
      const dateFilter = dateInput.value.toLowerCase();
      let visibleCount = 0;
      listContainer.innerHTML = '';

      dataMap.forEach(item => {
        const displayValue = getDisplayValue(item);
        const matchesSearch = item.id.toLowerCase().includes(filter) || item.raw.toLowerCase().includes(filter);
        const matchesDate = item.date.toLowerCase().includes(dateFilter);
        if (!(matchesSearch && matchesDate)) return;

        visibleCount += 1;
        const itemDiv = document.createElement('div');
        itemDiv.style = `padding:10px; border-bottom:1px solid #eee; cursor:pointer; border-radius:4px; margin-bottom:4px; transition: background 0.2s, opacity 0.2s; background: ${item.copied ? '#f0f0f0' : 'white'}; opacity: ${item.copied ? '0.6' : '1'};`;
        itemDiv.innerHTML = `
          <div class="main-text" style="font-family:monospace; font-size:12px; color: ${item.copied ? '#888' : '#0056b3'}; word-break:break-all;">${displayValue}</div>
          <div style="font-size:10px; color:#aaa; margin-top:4px;">Date: ${item.date} ${item.copied ? '(Already Copied)' : ''}</div>
        `;

        itemDiv.onclick = async () => {
          await navigator.clipboard.writeText(displayValue);
          item.copied = true;
          itemDiv.style.transition = 'none';
          itemDiv.style.background = '#c3e6cb';
          const textNode = itemDiv.querySelector('.main-text');
          textNode.style.color = '#155724';
          setTimeout(() => {
            itemDiv.style.transition = 'background 0.5s, opacity 0.5s';
            itemDiv.style.background = '#f0f0f0';
            itemDiv.style.opacity = '0.6';
            textNode.style.color = '#888';
            renderList();
          }, 400);
        };
        listContainer.appendChild(itemDiv);
      });

      document.getElementById('footer-count').innerText = `Showing ${visibleCount} of ${foundUuids.length} IDs`;
    };

    renderList();
    searchInput.oninput = renderList;
    dateInput.oninput = renderList;

    div.querySelectorAll('.mode-btn').forEach(btn => {
      btn.onclick = () => {
        currentMode = btn.getAttribute('data-mode');
        div.querySelectorAll('.mode-btn').forEach(b => {
          b.style.background = '#f8f9fa';
          b.style.color = '#333';
          b.style.border = '1px solid #ccc';
        });
        btn.style.background = '#007bff';
        btn.style.color = 'white';
        btn.style.border = '1px solid #007bff';
        renderList();
      };
    });

    document.getElementById('copy-all-btn').onclick = async () => {
      const filter = searchInput.value.toLowerCase();
      const dFilter = dateInput.value.toLowerCase();
      const visibleItems = dataMap.filter(i => (i.id.toLowerCase().includes(filter) || i.raw.toLowerCase().includes(filter)) && i.date.toLowerCase().includes(dFilter));
      await navigator.clipboard.writeText(visibleItems.map(getDisplayValue).join(', '));
      visibleItems.forEach(i => { i.copied = true; });
      const btn = document.getElementById('copy-all-btn');
      btn.innerText = `✓ Copied ${visibleItems.length}!`;
      btn.style.background = '#1e7e34';
      setTimeout(() => {
        btn.innerText = 'Copy All Visible';
        btn.style.background = '#28a745';
        renderList();
      }, 1500);
    };

    document.getElementById('export-btn').onclick = () => {
      const filter = searchInput.value.toLowerCase();
      const dFilter = dateInput.value.toLowerCase();
      const exportData = dataMap
        .filter(i => (i.id.toLowerCase().includes(filter) || i.raw.toLowerCase().includes(filter)) && i.date.toLowerCase().includes(dFilter))
        .map(item => `${item.id}\t${item.raw}\t${item.date}`)
        .join('\n');
      const blob = new Blob([`UUID\tFILENAME\tDATE\n${exportData}`], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `export_${Date.now()}.txt`;
      a.click();
    };

    document.getElementById('close-x').onclick = () => div.remove();
    searchInput.focus();
  }

  async function addCustomWorkflowGroupsTool() {
    const input = prompt('Paste workflow group names (one per line).\nEach line = one Custom Workflow Group.');
    if (!input) return;

    const names = input.split('\n').map(name => name.trim()).filter(Boolean);
    if (!names.length) {
      alert('No workflow group names provided.');
      return;
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (const name of names) {
      const addBtn = document.querySelector('[phx-click="add_workflow_group"]');
      if (!addBtn) return alert('❌ Add Custom Workflow Group button not found');

      addBtn.click();
      await sleep(700);

      const docmanInputs = document.querySelectorAll('input[name="form-[docman_group]"]');
      const labelInputs = document.querySelectorAll('input[name="form-[label_for_ui]"]');
      const docmanInput = docmanInputs[docmanInputs.length - 1];
      const labelInput = labelInputs[labelInputs.length - 1];
      if (!docmanInput || !labelInput) return alert('❌ Workflow inputs not found');

      docmanInput.focus();
      docmanInput.value = name;
      docmanInput.dispatchEvent(new Event('input', { bubbles: true }));

      labelInput.focus();
      labelInput.value = name;
      labelInput.dispatchEvent(new Event('input', { bubbles: true }));

      await sleep(300);
      const row = labelInput.closest('div');
      const saveIcon = row?.querySelector('svg polyline')?.closest('span,button,div');
      if (!saveIcon) return alert(`❌ Save button not found for: ${name}`);

      saveIcon.click();
      await sleep(900);
    }

    alert(`✅ Successfully created ${names.length} workflow groups`);
  }

  function listDocmanGroupNamesTool() {
    const all = [...document.querySelectorAll('input')].filter(input => input.offsetParent !== null && input.value.trim().length > 0);
    const groups = [];
    for (let i = 0; i < all.length; i += 2) groups.push(all[i].value.trim());

    const uniqueGroups = [...new Set(groups)];
    if (!uniqueGroups.length) return alert('No Docman Groups found.');

    const existingPanel = document.getElementById('docman-groups-panel-v1');
    if (existingPanel) existingPanel.remove();

    const panel = document.createElement('div');
    panel.id = 'docman-groups-panel-v1';
    panel.style.position = 'fixed';
    panel.style.top = '80px';
    panel.style.right = '20px';
    panel.style.width = '350px';
    panel.style.height = '70vh';
    panel.style.background = 'white';
    panel.style.zIndex = '999999';
    panel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
    panel.style.borderRadius = '8px';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.innerHTML = `<div style="padding:12px;font-weight:600;border-bottom:1px solid #eee;display:flex;justify-content:space-between;">Docman Groups <span id="closeDG" style="cursor:pointer;font-size:18px;">×</span></div><textarea style="flex:1;border:none;padding:12px;font-family:monospace;font-size:13px;resize:none;">${uniqueGroups.join('\n')}</textarea>`;
    document.body.appendChild(panel);

    document.getElementById('closeDG').onclick = () => panel.remove();
  }

  window.mailroomBookmarkletTools = {
    run(toolName) {
      if (toolName === 'uuidPicker') return uuidPickerTool();
      if (toolName === 'addWorkflowGroups') return addCustomWorkflowGroupsTool();
      if (toolName === 'listDocmanGroups') return listDocmanGroupNamesTool();
      alert(`Unknown tool: ${toolName}`);
    }
  };
})();
