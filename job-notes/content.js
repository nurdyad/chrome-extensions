const NOTE_ICON_CLASS = 'job-note-icon';
const TOOLTIP_CLASS = 'job-note-tooltip';

// Observe page changes
const observer = new MutationObserver(() => {
  addNoteIconsToRows();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

function addNoteIconsToRows() {
  const rows = document.querySelectorAll('tr');

  rows.forEach((row) => {
    if (row.querySelector(`.${NOTE_ICON_CLASS}`)) return;

    const jobIDCell = [...row.querySelectorAll('td a')].find(a =>
      /^\d+$/.test(a.textContent.trim())
    );

    if (!jobIDCell) return;

    const jobId = jobIDCell.textContent.trim();

    // Create note icon
    const noteIcon = document.createElement('span');
    noteIcon.className = NOTE_ICON_CLASS;
    noteIcon.textContent = '📝';
    noteIcon.title = 'Click to add/edit note';
    noteIcon.style.cursor = 'pointer';
    noteIcon.style.marginLeft = '8px';

    // Tooltip
    const tooltip = document.createElement('div');
    tooltip.className = TOOLTIP_CLASS;
    tooltip.style.display = 'none';
    row.appendChild(tooltip);

    noteIcon.addEventListener('mouseenter', async () => {
      const note = await getNote(jobId);
      tooltip.textContent = note || 'No note added yet';
      tooltip.style.display = 'block';
    });

    noteIcon.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    noteIcon.addEventListener('click', async () => {
      const existingNote = await getNote(jobId);
      const userNote = prompt('Enter note for Job ID ' + jobId + ':', existingNote || '');
      if (userNote !== null) {
        await saveNote(jobId, userNote);
        tooltip.textContent = userNote;
      }
    });

    // Append icon next to the Job ID cell
    jobIDCell.parentElement.appendChild(noteIcon);
  });
}

function getNote(jobId) {
  return new Promise((resolve) => {
    chrome.storage.local.get([jobId], (result) => {
      resolve(result[jobId]);
    });
  });
}

function saveNote(jobId, note) {
  return new Promise((resolve) => {
    const toSave = {};
    toSave[jobId] = note;
    chrome.storage.local.set(toSave, resolve);
  });
}
