'use strict';

// The options page adds JSON backup and restore controls to the shared editor.
const importButton = document.querySelector('#import-button');
const importFile = document.querySelector('#import-file');
const importMode = document.querySelector('#import-mode');
const exportButton = document.querySelector('#export-button');
const importStatus = document.querySelector('#import-status');

/** Show a temporary success or error message below the settings controls. */
function showStatus(message, isError = false) {
  importStatus.textContent = message;
  importStatus.classList.toggle('error', isError);
  importStatus.hidden = false;
  window.setTimeout(() => { importStatus.hidden = true; }, 3200);
}

/** Export a snapshot of all profiles as a downloadable JSON file. */
function exportProfiles() {
  const state = globalThis.CrunchrHeaderUI.exportState();
  if (!state) {
    showStatus('Settings are still loading. Try again in a moment.', true);
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'crunchr-header-profiles.json';
  link.click();
  URL.revokeObjectURL(url);
  showStatus('Profiles exported.');
}

/** Parse and validate an uploaded backup, then merge or replace profiles. */
async function importProfiles(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.profiles)) throw new Error('The file does not contain a profiles array.');
    const total = await globalThis.CrunchrHeaderUI.importState(parsed, importMode.value);
    showStatus(`${total} profiles available. Choose a profile and switch the extension on to apply it.`);
  } catch (error) {
    showStatus(`Import failed: ${error.message}`, true);
  }
}

exportButton.addEventListener('click', exportProfiles);
importButton.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (file) void importProfiles(file);
  event.target.value = '';
});
