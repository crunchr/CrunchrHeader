importScripts('shared.js');

'use strict';

// Serialize updates so overlapping storage changes cannot race while Chrome's
// dynamic rules are being replaced.
let synchronizationQueue = Promise.resolve();

/** Atomically replace Chrome's live rules and return the previous set. */
async function installRules(state) {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const rules = HeaderProfiles.compileRules(state);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: currentRules.map((rule) => rule.id),
    addRules: rules,
  });

  return { currentRules, rules };
}

async function updateToolbar(state) {
  const activeProfile = HeaderProfiles.getActiveProfile(state);
  await chrome.action.setBadgeText({ text: activeProfile ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setTitle({
    title: activeProfile ? `CrunchrHeader — ${activeProfile.name}` : 'CrunchrHeader — off',
  });
}

/** Rebuild Chrome's dynamic rules from the last saved state. */
async function synchronizeRules() {
  const state = await HeaderProfiles.loadState();
  const { rules } = await installRules(state);
  await updateToolbar(state);
  return { ruleCount: rules.length };
}

/** Apply a proposed state only after Chrome accepts its dynamic rules. */
async function applyState(candidate) {
  const proposed = HeaderProfiles.normalizeState(candidate);
  const activeProfile = HeaderProfiles.getActiveProfile(proposed);
  const errors = activeProfile ? HeaderProfiles.validateProfile(activeProfile) : [];
  if (errors.length > 0) throw new Error(errors.join(' '));

  const { currentRules, rules } = await installRules(proposed);
  let savedState;
  try {
    savedState = await HeaderProfiles.saveState(proposed);
  } catch (error) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: rules.map((rule) => rule.id),
        addRules: currentRules,
      });
    } catch (rollbackError) {
      throw new Error(`Settings could not be saved, and the previous rules could not be restored: ${rollbackError.message}`);
    }
    throw error;
  }
  // A toolbar failure must not report a failed save after both state and rules
  // were successfully applied.
  try {
    await updateToolbar(savedState);
  } catch (error) {
    console.error('Unable to update the toolbar.', error);
  }
  return { state: savedState, ruleCount: rules.length };
}

/** Serialize updates so a storage event cannot race an in-flight save. */
function queueTask(task) {
  const synchronization = synchronizationQueue.catch(() => undefined).then(task);
  synchronizationQueue = synchronization.catch((error) => {
    console.error('Unable to update header rules.', error);
  });
  return synchronization;
}

function queueRuleSynchronization() {
  return queueTask(synchronizeRules);
}

// Reapply persisted settings after installation, browser startup, or a change
// to the saved profile state. The final call also covers service-worker startup.
chrome.runtime.onInstalled.addListener(() => { void queueRuleSynchronization(); });
chrome.runtime.onStartup.addListener(() => { void queueRuleSynchronization(); });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[HeaderProfiles.STORAGE_KEY]) void queueRuleSynchronization();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'applyState') return false;
  queueTask(() => applyState(message.state))
    .then(({ state, ruleCount }) => sendResponse({ ok: true, state, ruleCount }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

void queueRuleSynchronization();
