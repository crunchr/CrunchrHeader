importScripts('shared.js');

'use strict';

// Serialize updates so overlapping storage changes cannot race while Chrome's
// dynamic rules are being replaced.
let synchronizationQueue = Promise.resolve();

/** Rebuild Chrome's dynamic rules and refresh the toolbar badge and title. */
async function synchronizeRules() {
  const state = await HeaderProfiles.loadState();
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const rules = HeaderProfiles.compileRules(state);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: currentRules.map((rule) => rule.id),
    addRules: rules,
  });

  const activeProfile = HeaderProfiles.getActiveProfile(state);
  await chrome.action.setBadgeText({ text: activeProfile ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setTitle({
    title: activeProfile ? `CrunchrHeader — ${activeProfile.name}` : 'CrunchrHeader — off',
  });
  return { activeProfile, ruleCount: rules.length };
}

/** Queue a synchronization behind any in-flight update and log failures. */
function queueRuleSynchronization() {
  const synchronization = synchronizationQueue.catch(() => undefined).then(synchronizeRules);
  synchronizationQueue = synchronization.catch((error) => {
    console.error('Unable to synchronize header rules.', error);
  });
  return synchronization;
}

// Reapply persisted settings after installation, browser startup, or a change
// to the saved profile state. The final call also covers service-worker startup.
chrome.runtime.onInstalled.addListener(() => { void queueRuleSynchronization(); });
chrome.runtime.onStartup.addListener(() => { void queueRuleSynchronization(); });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[HeaderProfiles.STORAGE_KEY]) void queueRuleSynchronization();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'synchronizeRules') return false;
  queueRuleSynchronization()
    .then(({ ruleCount }) => sendResponse({ ok: true, ruleCount }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

void queueRuleSynchronization();
