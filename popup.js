"use strict";

// The popup is the profile editor: edits update this in-memory state first,
// then Save asks the worker to apply rules before persisting the state.
const elements = {
  addRequestRule: document.querySelector("#add-request-rule"),
  addResponseRule: document.querySelector("#add-response-rule"),
  deleteProfile: document.querySelector("#delete-profile"),
  duplicateProfile: document.querySelector("#duplicate-profile"),
  editor: document.querySelector("#editor"),
  emptyAddProfile: document.querySelector("#empty-add-profile"),
  emptyState: document.querySelector("#empty-state"),
  moveDown: document.querySelector("#move-down"),
  moveUp: document.querySelector("#move-up"),
  newProfile: document.querySelector("#new-profile"),
  openOptions: document.querySelector("#open-options"),
  profileName: document.querySelector("#profile-name"),
  profiles: document.querySelector("#profiles"),
  ruleCount: document.querySelector("#rule-count"),
  ruleList: document.querySelector("#rule-list"),
  saveProfile: document.querySelector("#save-profile"),
  saveStatus: document.querySelector("#save-status"),
  extensionEnabled: document.querySelector("#extension-enabled"),
  extensionStatus: document.querySelector("#extension-status"),
  validationErrors: document.querySelector("#validation-errors"),
};

let state;
let selectedProfileId = null;
let dirty = false;

/** Return the profile currently shown in the editor, if it still exists. */
function getSelectedProfile() {
  return (
    state.profiles.find((profile) => profile.id === selectedProfileId) ?? null
  );
}

/** Whether edits to the selected profile will affect currently applied rules. */
function isSelectedProfileActive() {
  return state.activeProfileId === selectedProfileId;
}

/** Record an unsaved edit and show that state in the editor footer. */
function markDirty() {
  dirty = true;
  elements.saveStatus.textContent = "Unsaved changes";
  elements.saveStatus.classList.add("dirty");
}

/** Clear the unsaved indicator and display a save/apply result message. */
function markSaved(message = "All changes saved") {
  dirty = false;
  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.remove("dirty");
}

/** Parse comma- or newline-separated scope text into trimmed nonempty values. */
function splitLines(value) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Build the short enabled-rule count shown next to a profile's name. */
function profileSummary(profile) {
  const activeRules = profile.rules.filter((rule) => rule.enabled).length;
  return `${activeRules} ${activeRules === 1 ? "rule" : "rules"}`;
}

/** Rebuild the profile list and reflect selection plus the globally active profile. */
function renderProfiles() {
  elements.profiles.replaceChildren();
  elements.extensionEnabled.checked = state.enabled;
  elements.extensionEnabled.setAttribute(
    "aria-label",
    state.enabled ? "Turn extension off" : "Turn extension on",
  );
  elements.extensionStatus.textContent = state.enabled ? "On" : "Off";
  state.profiles.forEach((profile) => {
    const row = document.createElement("div");
    row.className = "profile-row";
    row.classList.toggle("selected", profile.id === selectedProfileId);

    const select = document.createElement("button");
    select.type = "button";
    select.className = "profile-select";
    select.addEventListener("click", () => {
      void selectProfile(profile.id);
    });
    const name = document.createElement("strong");
    name.textContent = profile.name || "Untitled profile";
    const summary = document.createElement("span");
    summary.textContent = profileSummary(profile);
    select.append(name, summary);

    const active = document.createElement("input");
    active.type = "radio";
    active.name = "active-profile";
    active.checked = profile.id === state.activeProfileId;
    active.title = `Apply ${profile.name || "this profile"}`;
    active.setAttribute(
      "aria-label",
      `Apply ${profile.name || "this profile"}`,
    );
    active.addEventListener("change", () => {
      void activateProfile(profile.id);
    });
    row.append(select, active);
    elements.profiles.append(row);
  });
}

/** Keep the scope disclosure summary in sync with a rule's URL filters. */
function updateRuleScopeSummary(summary, rule) {
  const pattern =
    rule.includePatterns.length === 1
      ? rule.includePatterns[0]
      : `${rule.includePatterns.length} URL filters`;
  summary.textContent = `Scope: ${pattern || "missing filter"}`;
}

/** Build one editable rule card and bind its controls to the profile data. */
function createRuleElement(profile, rule) {
  const card = document.createElement("article");
  card.className = "rule";
  card.classList.toggle("disabled", !rule.enabled);

  const main = document.createElement("div");
  main.className = "rule-main";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = rule.enabled;
  enabled.setAttribute("aria-label", `Enable ${rule.header || "header"} rule`);
  enabled.addEventListener("change", () => {
    rule.enabled = enabled.checked;
    card.classList.toggle("disabled", !rule.enabled);
    markDirty();
  });

  const direction = document.createElement("select");
  direction.setAttribute("aria-label", "Header direction");
  [
    ["request", "Request"],
    ["response", "Response"],
  ].forEach(([value, label]) => {
    const option = new Option(label, value);
    direction.add(option);
  });
  direction.value = rule.direction;
  direction.addEventListener("change", () => {
    rule.direction = direction.value;
    markDirty();
  });

  const operation = document.createElement("select");
  operation.setAttribute("aria-label", "Header operation");
  ["set", "append", "remove"].forEach((value) =>
    operation.add(new Option(value[0].toUpperCase() + value.slice(1), value)),
  );
  operation.value = rule.operation;

  const header = document.createElement("input");
  header.type = "text";
  header.value = rule.header;
  header.placeholder = "Header name";
  header.spellcheck = false;
  header.setAttribute("aria-label", "Header name");
  header.addEventListener("input", () => {
    rule.header = header.value;
    markDirty();
  });

  const value = document.createElement("input");
  value.type = "text";
  value.value = rule.value;
  value.placeholder = "Value";
  value.spellcheck = false;
  value.disabled = rule.operation === "remove";
  value.setAttribute("aria-label", "Header value");
  value.addEventListener("input", () => {
    rule.value = value.value;
    markDirty();
  });
  operation.addEventListener("change", () => {
    rule.operation = operation.value;
    value.disabled = rule.operation === "remove";
    markDirty();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-rule";
  remove.textContent = "×";
  remove.title = "Remove rule";
  remove.setAttribute("aria-label", "Remove rule");
  remove.addEventListener("click", () => {
    profile.rules = profile.rules.filter(
      (candidate) => candidate.id !== rule.id,
    );
    if (profile.rules.length === 0)
      profile.rules.push(HeaderProfiles.createRule());
    renderRules(profile);
    markDirty();
  });
  main.append(enabled, direction, operation, header, value, remove);

  const details = document.createElement("details");
  details.className = "scope";
  const summary = document.createElement("summary");
  updateRuleScopeSummary(summary, rule);
  const scopeContent = document.createElement("div");
  scopeContent.className = "scope-content";

  const includeLabel = document.createElement("label");
  includeLabel.textContent = "URL filters";
  const include = document.createElement("textarea");
  include.className = "scope-textarea";
  include.rows = 2;
  include.value = rule.includePatterns.join("\n");
  include.placeholder = "* or ||api.example.com/";
  include.spellcheck = false;
  include.addEventListener("input", () => {
    rule.includePatterns = splitLines(include.value);
    updateRuleScopeSummary(summary, rule);
    markDirty();
  });
  const includeHelp = document.createElement("small");
  includeHelp.textContent =
    "One Chrome URL filter per line. * matches all URLs.";
  includeLabel.append(include, includeHelp);

  const excludedLabel = document.createElement("label");
  excludedLabel.textContent = "Excluded domains";
  const excluded = document.createElement("textarea");
  excluded.className = "scope-textarea";
  excluded.rows = 2;
  excluded.value = rule.excludedDomains.join("\n");
  excluded.placeholder = "accounts.example.com";
  excluded.spellcheck = false;
  excluded.addEventListener("input", () => {
    rule.excludedDomains = splitLines(excluded.value);
    markDirty();
  });
  const excludedHelp = document.createElement("small");
  excludedHelp.textContent =
    "One hostname per line; subdomains are also excluded.";
  excludedLabel.append(excluded, excludedHelp);

  scopeContent.append(includeLabel, excludedLabel);
  details.append(summary, scopeContent);
  card.append(main, details);
  return card;
}

/** Rebuild all rule cards and show the number of Chrome rules they will compile to. */
function renderRules(profile) {
  elements.ruleList.replaceChildren();
  profile.rules.forEach((rule) =>
    elements.ruleList.append(createRuleElement(profile, rule)),
  );
  const compiled = HeaderProfiles.compiledRuleCount(profile);
  elements.ruleCount.textContent = `${compiled} Chrome ${compiled === 1 ? "rule" : "rules"}`;
}

/** Render the selected profile editor, or show the empty state if none is selected. */
function renderEditor() {
  const profile = getSelectedProfile();
  elements.editor.hidden = profile === null;
  elements.emptyState.hidden = profile !== null;
  if (!profile) return;
  elements.profileName.value = profile.name;
  const profileIndex = state.profiles.indexOf(profile);
  elements.moveUp.disabled = profileIndex === 0;
  elements.moveDown.disabled = profileIndex === state.profiles.length - 1;
  elements.validationErrors.hidden = true;
  renderRules(profile);
  markSaved();
}

/** Save pending edits if needed, then change and persist the selected profile. */
async function selectProfile(profileId) {
  if (
    dirty &&
    profileId !== selectedProfileId &&
    !(await saveSelectedProfile())
  )
    return;
  selectedProfileId = profileId;
  await chrome.storage.local.set({
    [HeaderProfiles.SELECTED_PROFILE_KEY]: selectedProfileId,
  });
  renderProfiles();
  renderEditor();
}

/** Copy the current form values into the selected profile and update its timestamp. */
function applyEditorValues(profile) {
  profile.name = elements.profileName.value.trim();
  profile.updatedAt = new Date().toISOString();
}

/** Ask the worker to apply rules and save their matching profile state. */
async function persistState() {
  const response = await chrome.runtime.sendMessage({ type: "applyState", state });
  if (!response?.ok)
    throw new Error(response?.error || "Chrome could not apply these rules.");
  state = response.state;
  return response.ruleCount;
}

/** Display validation or Chrome errors in the editor's alert area. */
function showErrors(errors) {
  elements.validationErrors.textContent = errors.join(" ");
  elements.validationErrors.hidden = false;
}

/** Request optional host access for the active rule scopes, if any. */
async function ensureProfileAccess(profile) {
  const origins = HeaderProfiles.getProfileOrigins(profile);
  if (origins.length === 0) return true;
  // Request directly from the click path. Chrome requires this API to retain a
  // user gesture; it resolves without prompting when access is already granted.
  return chrome.permissions.request({ origins });
}

/** Validate and save the selected profile, requesting access if it is active. */
async function saveSelectedProfile() {
  const profile = getSelectedProfile();
  if (!profile) return false;
  applyEditorValues(profile);
  const errors = HeaderProfiles.validateProfile(profile);
  if (errors.length > 0) {
    showErrors(errors);
    return false;
  }
  if (state.enabled && isSelectedProfileActive() && !(await ensureProfileAccess(profile))) {
    showErrors([
      "Chrome needs site access before this active profile can be applied.",
    ]);
    return false;
  }
  elements.validationErrors.hidden = true;
  try {
    const ruleCount = await persistState();
    renderProfiles();
    markSaved(
      ruleCount > 0 ? `Applied ${ruleCount} Chrome rules` : "Profile saved",
    );
    return true;
  } catch (error) {
    showErrors([error.message]);
    return false;
  }
}

/** Validate, request site access, and make a profile the single active profile. */
async function activateProfile(profileId) {
  const profile = state.profiles.find(
    (candidate) => candidate.id === profileId,
  );
  const errors = HeaderProfiles.validateProfile(profile);
  if (errors.length > 0) {
    selectedProfileId = profileId;
    renderProfiles();
    renderEditor();
    showErrors(errors);
    return;
  }
  // Start permission negotiation before any awaited save so Chrome still sees
  // the profile radio change as the initiating user gesture.
  const accessRequest = state.enabled ? ensureProfileAccess(profile) : null;
  if (dirty && !(await saveSelectedProfile())) {
    renderProfiles();
    return;
  }
  // Selecting a profile while switched off only remembers the choice. Site
  // access is requested when the user turns the extension on.
  if (!state.enabled) {
    const previousActiveProfileId = state.activeProfileId;
    state.activeProfileId = profileId;
    try {
      await persistState();
      selectedProfileId = profileId;
      renderProfiles();
      renderEditor();
      markSaved("Profile selected — extension is off");
    } catch (error) {
      state.activeProfileId = previousActiveProfileId;
      showErrors([error.message]);
      renderProfiles();
    }
    return;
  }
  // Request permissions directly from the radio change gesture.
  if (!(await accessRequest)) {
    showErrors(["Site access was not granted, so this profile remains off."]);
    renderProfiles();
    return;
  }
  const previousActiveProfileId = state.activeProfileId;
  state.activeProfileId = profileId;
  try {
    const ruleCount = await persistState();
    selectedProfileId = profileId;
    renderProfiles();
    renderEditor();
    markSaved(
      ruleCount > 0
        ? `Active — ${ruleCount} Chrome rules`
        : "Active — no enabled rules",
    );
  } catch (error) {
    state.activeProfileId = previousActiveProfileId;
    showErrors([error.message]);
    renderProfiles();
  }
}

/** Toggle rule application without changing the selected profile. */
async function setExtensionEnabled(enabled) {
  const profile = getSelectedProfile();
  if (profile && dirty) applyEditorValues(profile);
  if (enabled && state.activeProfileId) {
    const activeProfile = state.profiles.find(
      (candidate) => candidate.id === state.activeProfileId,
    );
    const accessRequest = ensureProfileAccess(activeProfile);
    if (!(await accessRequest)) {
      elements.extensionEnabled.checked = false;
      showErrors(["Chrome needs site access before this profile can be applied."]);
      return;
    }
  }
  const previousEnabled = state.enabled;
  state.enabled = enabled;
  try {
    await persistState();
    renderProfiles();
    renderEditor();
    markSaved(enabled ? "Extension is on" : "Extension is off");
  } catch (error) {
    state.enabled = previousEnabled;
    renderProfiles();
    showErrors([error.message]);
  }
}

/** Add a new profile, save prior edits, and open the new profile for editing. */
async function createProfile() {
  if (dirty && !(await saveSelectedProfile())) return;
  const profile = HeaderProfiles.createProfile(
    `Profile ${state.profiles.length + 1}`,
  );
  state.profiles.push(profile);
  await persistState();
  await selectProfile(profile.id);
  elements.profileName.focus();
  elements.profileName.select();
}

/** Duplicate the selected profile and give the copy and its rules fresh IDs. */
async function duplicateProfile() {
  const profile = getSelectedProfile();
  if (!profile || (dirty && !(await saveSelectedProfile()))) return;
  const duplicate = structuredClone(profile);
  duplicate.id = crypto.randomUUID();
  duplicate.name = `${profile.name || "Untitled profile"} copy`;
  duplicate.rules.forEach((rule) => {
    rule.id = crypto.randomUUID();
  });
  duplicate.createdAt = new Date().toISOString();
  duplicate.updatedAt = duplicate.createdAt;
  state.profiles.splice(state.profiles.indexOf(profile) + 1, 0, duplicate);
  await persistState();
  await selectProfile(duplicate.id);
}

/** Reorder the selected profile by one position and persist the new order. */
async function moveProfile(offset) {
  if (dirty && !(await saveSelectedProfile())) return;
  const profile = getSelectedProfile();
  const currentIndex = state.profiles.indexOf(profile);
  const nextIndex = currentIndex + offset;
  if (!profile || nextIndex < 0 || nextIndex >= state.profiles.length) return;
  state.profiles.splice(currentIndex, 1);
  state.profiles.splice(nextIndex, 0, profile);
  await persistState();
  renderProfiles();
  renderEditor();
}

/** Delete the selected profile, clearing activation if it was active. */
async function deleteProfile() {
  const profile = getSelectedProfile();
  if (
    !profile ||
    !window.confirm(`Delete “${profile.name || "Untitled profile"}”?`)
  )
    return;
  const previousState = structuredClone(state);
  const previousSelectedProfileId = selectedProfileId;
  state.profiles = state.profiles.filter(
    (candidate) => candidate.id !== profile.id,
  );
  if (state.activeProfileId === profile.id) state.activeProfileId = null;
  selectedProfileId = state.profiles[0]?.id ?? null;
  try {
    await persistState();
  } catch (error) {
    state = previousState;
    selectedProfileId = previousSelectedProfileId;
    renderProfiles();
    renderEditor();
    showErrors([error.message]);
    return;
  }
  await chrome.storage.local.set({
    [HeaderProfiles.SELECTED_PROFILE_KEY]: selectedProfileId,
  });
  renderProfiles();
  renderEditor();
}

elements.profileName.addEventListener("input", markDirty);
elements.saveProfile.addEventListener("click", () => {
  void saveSelectedProfile();
});
elements.extensionEnabled.addEventListener("change", () => {
  void setExtensionEnabled(elements.extensionEnabled.checked);
});
elements.newProfile.addEventListener("click", () => {
  void createProfile();
});
elements.emptyAddProfile.addEventListener("click", () => {
  void createProfile();
});
elements.duplicateProfile.addEventListener("click", () => {
  void duplicateProfile();
});
elements.deleteProfile.addEventListener("click", () => {
  void deleteProfile();
});
elements.moveUp.addEventListener("click", () => {
  void moveProfile(-1);
});
elements.moveDown.addEventListener("click", () => {
  void moveProfile(1);
});
elements.addRequestRule.addEventListener("click", () => {
  const profile = getSelectedProfile();
  profile.rules.push(HeaderProfiles.createRule("request"));
  renderRules(profile);
  markDirty();
});
elements.addResponseRule.addEventListener("click", () => {
  const profile = getSelectedProfile();
  profile.rules.push(HeaderProfiles.createRule("response"));
  renderRules(profile);
  markDirty();
});
elements.openOptions.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

// Restore both the saved profiles and the last profile the user was editing.
Promise.all([
  HeaderProfiles.loadState(),
  chrome.storage.local.get(HeaderProfiles.SELECTED_PROFILE_KEY),
]).then(([loadedState, selection]) => {
  state = loadedState;
  selectedProfileId = state.profiles.some(
    (profile) => profile.id === selection[HeaderProfiles.SELECTED_PROFILE_KEY],
  )
    ? selection[HeaderProfiles.SELECTED_PROFILE_KEY]
    : (state.activeProfileId ?? state.profiles[0]?.id ?? null);
  renderProfiles();
  renderEditor();
});

globalThis.CrunchrHeaderUI = {
  /** Return an independent snapshot for JSON export. */
  exportState: () => structuredClone(state),
  /** Validate and merge or replace profiles from an imported JSON state. */
  importState: async (importedState, mode) => {
    const imported = HeaderProfiles.normalizeState(importedState);
    const invalidProfile = imported.profiles.find(
      (profile) => HeaderProfiles.validateProfile(profile).length > 0,
    );
    if (invalidProfile)
      throw new Error(
        `Profile “${invalidProfile.name || "Untitled profile"}” is invalid.`,
      );
    if (mode === "merge" && dirty && !(await saveSelectedProfile())) {
      throw new Error("Save or correct the unsaved profile before importing.");
    }
    const previousState = structuredClone(state);
    const previousSelectedProfileId = selectedProfileId;
    if (mode === "merge") {
      const copies = structuredClone(imported.profiles);
      copies.forEach((profile) => {
        profile.id = crypto.randomUUID();
        profile.rules.forEach((rule) => {
          rule.id = crypto.randomUUID();
        });
      });
      state.profiles.push(...copies);
    } else {
      state = imported;
      state.activeProfileId = null;
    }
    selectedProfileId = state.profiles[0]?.id ?? null;
    try {
      await persistState();
    } catch (error) {
      state = previousState;
      selectedProfileId = previousSelectedProfileId;
      throw error;
    }
    await chrome.storage.local.set({
      [HeaderProfiles.SELECTED_PROFILE_KEY]: selectedProfileId,
    });
    renderProfiles();
    renderEditor();
    return state.profiles.length;
  },
};
