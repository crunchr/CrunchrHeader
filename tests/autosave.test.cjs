const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = (file) => readFileSync(join(__dirname, '..', file), 'utf8');
const clone = (value) => structuredClone(value);

// Small DOM fixture: run the actual editor's listeners against the actual worker.
class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.hidden = false;
    this.value = '';
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    };
  }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  add(option) { this.append(option); }
  replaceChildren() { this.children = []; }
  focus() {}
  select() {}
  fire(type, value) {
    if (value !== undefined) this.value = value;
    return this.listeners[type]?.({ target: this });
  }
}

function fixture() {
  const data = {};
  let rules = [];
  let messageHandler;
  let storageListener;
  let access = true;
  let failStorage = false;
  let failRules = false;
  let permissionRequests = 0;
  let deferReplies = false;
  const replies = [];
  const chrome = {
    storage: {
      local: {
        async get(key) { return clone({ [key]: data[key] }); },
        async set(values) {
          if (failStorage) throw new Error('Storage unavailable');
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            if (JSON.stringify(data[key]) !== JSON.stringify(value)) {
              changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
            }
            data[key] = clone(value);
          }
          if (Object.keys(changes).length) storageListener?.(changes, 'local');
        },
      },
      onChanged: { addListener: (handler) => { storageListener = handler; } },
    },
    declarativeNetRequest: {
      async getDynamicRules() { return clone(rules); },
      async updateDynamicRules({ addRules }) {
        if (failRules) throw new Error('Chrome rejected rules');
        rules = clone(addRules);
      },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    permissions: {
      async contains() { return access; },
      async request() { permissionRequests++; access = true; return true; },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (handler) => { messageHandler = handler; } },
      sendMessage(message) {
        return new Promise((resolve) => messageHandler(clone(message), {}, (response) => {
          if (deferReplies) replies.push(() => resolve(clone(response)));
          else resolve(clone(response));
        }));
      },
      async openOptionsPage() {},
    },
  };
  const globals = { chrome, crypto: webcrypto, structuredClone, console: { error() {} } };
  let worker;
  function startWorker() {
    worker = vm.createContext({ ...globals, importScripts: (file) => vm.runInContext(source(file), worker) });
    vm.runInContext(source('background.js'), worker);
  }
  startWorker();
  async function settle() {
    await new Promise(setImmediate);
    await vm.runInContext('synchronizationQueue', worker);
    await new Promise(setImmediate);
  }
  async function openEditor() {
    const elements = new Map();
    const document = {
      querySelector: (id) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement: () => new Element(),
    };
    const context = vm.createContext({
      ...globals, document, window: { confirm: () => true },
      Option: class extends Element { constructor(label, value) { super(); this.value = value; } },
    });
    vm.runInContext(source('shared.js'), context);
    vm.runInContext(source('popup.js'), context);
    await settle();
    return {
      context,
      element: (id) => document.querySelector(`#${id}`),
      snapshot: () => context.CrunchrHeaderUI.exportState(),
      controls: () => elements.get('#rule-list').children[0].children[0].children,
      scopes: () => elements.get('#rule-list').children[0].children[1].children[1].children,
    };
  }
  return {
    data, chrome, settle, openEditor, startWorker,
    rules: () => clone(rules),
    setAccess: (value) => { access = value; },
    failStorage: (value) => { failStorage = value; },
    failRules: (value) => { failRules = value; },
    permissionRequests: () => permissionRequests,
    deferReplies: () => { deferReplies = true; },
    replies,
  };
}

test('every rule field and profile name autosave, including rapid typing', async () => {
  const f = fixture();
  const ui = await f.openEditor();
  for (const name of ['D', 'De', 'Development edited']) ui.element('profile-name').fire('input', name);
  const [enabled, direction, operation, header, value] = ui.controls();
  header.fire('input', 'X-User');
  value.fire('input', 'alice');
  direction.fire('change', 'response');
  operation.fire('change', 'append');
  enabled.checked = true;
  enabled.fire('change');
  const [include, excluded] = ui.scopes();
  include.children[0].fire('input', '||example.com/');
  excluded.children[0].fire('input', 'accounts.example.com');
  await f.settle();
  const saved = f.data.headerProfilesEditorState.profiles[0];
  assert.equal(saved.name, 'Development edited');
  assert.equal(saved.rules[0].header, 'X-User');
  assert.equal(saved.rules[0].value, 'alice');
  assert.equal(saved.rules[0].direction, 'response');
  assert.equal(saved.rules[0].operation, 'append');
  assert.equal(saved.rules[0].enabled, true);
  assert.deepEqual(saved.rules[0].includePatterns, ['||example.com/']);
  assert.deepEqual(saved.rules[0].excludedDomains, ['accounts.example.com']);
  assert.equal(ui.element('save-status').textContent, 'All changes saved');
  // Repeated saves must preserve the object captured by these input listeners.
  value.fire('input', 'bob');
  await f.settle();
  assert.equal(f.data.headerProfilesState.profiles[0].rules[0].value, 'bob');
  assert.equal(f.permissionRequests(), 0);
});

async function activeEditor(f) {
  const ui = await f.openEditor();
  const [enabled, , , header, value] = ui.controls();
  header.fire('input', 'X-User');
  value.fire('input', 'alice');
  enabled.checked = true;
  enabled.fire('change');
  await f.settle();
  await ui.element('profiles').children[0].children[1].fire('change');
  ui.element('extension-enabled').checked = true;
  ui.element('extension-enabled').fire('change');
  await f.settle();
  assert.equal(f.rules()[0].action.requestHeaders[0].value, 'alice');
  return ui;
}

test('valid active edits apply immediately; incomplete edits survive reopening and worker restart', async () => {
  const f = fixture();
  const ui = await activeEditor(f);
  ui.controls()[4].fire('input', 'bob');
  await f.settle();
  assert.equal(f.rules()[0].action.requestHeaders[0].value, 'bob');
  ui.controls()[3].fire('input', '');
  await f.settle();
  assert.equal(f.rules()[0].action.requestHeaders[0].header, 'X-User');
  assert.equal(f.data.headerProfilesEditorState.profiles[0].rules[0].header, '');
  assert.match(ui.element('save-status').textContent, /saved — not applied/);
  f.startWorker();
  await f.settle();
  assert.equal(f.rules()[0].action.requestHeaders[0].value, 'bob');
  const reopened = await f.openEditor();
  assert.equal(reopened.controls()[3].value, '');
  reopened.controls()[3].fire('input', 'X-Account');
  await f.settle();
  assert.equal(f.rules()[0].action.requestHeaders[0].header, 'X-Account');
});

test('edits requiring site access save without prompting, then apply after access is granted', async () => {
  const f = fixture();
  const ui = await activeEditor(f);
  const requests = f.permissionRequests();
  f.setAccess(false);
  ui.controls()[4].fire('input', 'pending-access');
  await f.settle();
  assert.equal(f.permissionRequests(), requests);
  assert.equal(f.data.headerProfilesEditorState.profiles[0].rules[0].value, 'pending-access');
  assert.equal(f.rules()[0].action.requestHeaders[0].value, 'alice');
  assert.equal(ui.element('grant-access').hidden, false);
  await ui.element('grant-access').fire('click');
  assert.equal(f.rules()[0].action.requestHeaders[0].value, 'pending-access');
  assert.equal(ui.element('grant-access').hidden, true);
});

test('older replies never replace newer edits or report a premature save', async () => {
  const f = fixture();
  const ui = await f.openEditor();
  f.deferReplies();
  ui.element('profile-name').fire('input', 'First');
  ui.element('profile-name').fire('input', 'Latest');
  await f.settle();
  f.replies[0]();
  await new Promise(setImmediate);
  assert.equal(ui.element('save-status').textContent, 'Saving…');
  assert.equal(ui.snapshot().profiles[0].name, 'Latest');
  f.replies[1]();
  await new Promise(setImmediate);
  assert.equal(ui.element('save-status').textContent, 'All changes saved');
  assert.equal(f.data.headerProfilesEditorState.profiles[0].name, 'Latest');
});

test('add, remove, duplicate, reorder, delete and import persist automatically', async () => {
  const f = fixture();
  const ui = await f.openEditor();
  ui.element('add-response-rule').fire('click');
  await f.settle();
  assert.equal(f.data.headerProfilesEditorState.profiles[0].rules.length, 2);
  ui.controls()[5].fire('click');
  await f.settle();
  assert.equal(f.data.headerProfilesEditorState.profiles[0].rules.length, 1);
  ui.element('duplicate-profile').fire('click');
  await f.settle();
  assert.equal(f.data.headerProfilesEditorState.profiles.length, 2);
  ui.element('move-up').fire('click');
  await f.settle();
  assert.match(f.data.headerProfilesEditorState.profiles[0].name, /copy$/);
  ui.element('delete-profile').fire('click');
  await f.settle();
  assert.equal(f.data.headerProfilesEditorState.profiles.length, 1);
  ui.element('new-profile').fire('click');
  await f.settle();
  assert.equal(f.data.headerProfilesEditorState.profiles.length, 2);
  // Empty names are drafts too, and must not block changing profiles.
  ui.element('profile-name').fire('input', '');
  await ui.element('profiles').children[0].children[0].fire('click');
  await f.settle();
  assert.equal(ui.element('profile-name').value, 'Development');
  assert.equal(f.data.headerProfilesEditorState.profiles[1].name, '');
  const exported = ui.snapshot();
  exported.profiles = [exported.profiles[0]];
  await ui.context.CrunchrHeaderUI.importState(exported, 'replace');
  assert.equal(f.data.headerProfilesEditorState.profiles.length, 1);
  const reopened = await f.openEditor();
  assert.equal(reopened.snapshot().profiles.length, 1);
});

test('storage failures are visible; Chrome rule failures retain the saved draft', async () => {
  const f = fixture();
  const ui = await activeEditor(f);
  f.failStorage(true);
  ui.controls()[4].fire('input', 'storage-error');
  await f.settle();
  assert.equal(ui.element('save-status').textContent, 'Couldn’t save changes');
  assert.match(ui.element('validation-errors').textContent, /Storage unavailable/);
  f.failStorage(false);
  f.failRules(true);
  ui.controls()[4].fire('input', 'chrome-error');
  await f.settle();
  assert.equal(f.data.headerProfilesEditorState.profiles[0].rules[0].value, 'chrome-error');
  assert.equal(f.rules()[0].action.requestHeaders[0].value, 'alice');
  assert.match(ui.element('validation-errors').textContent, /Chrome rejected rules/);
});

test('turning off clears live rules even with an incomplete draft and reports Chrome failures', async () => {
  const f = fixture();
  const ui = await activeEditor(f);
  ui.controls()[3].fire('input', '');
  await f.settle();
  f.failRules(true);
  ui.element('extension-enabled').checked = false;
  ui.element('extension-enabled').fire('change');
  await f.settle();
  assert.equal(ui.element('extension-enabled').checked, true);
  assert.equal(f.rules().length, 1);
  f.failRules(false);
  ui.element('extension-enabled').checked = false;
  ui.element('extension-enabled').fire('change');
  await f.settle();
  assert.equal(f.rules().length, 0);
  assert.equal(f.data.headerProfilesState.enabled, false);
  assert.equal(f.data.headerProfilesEditorState.profiles[0].rules[0].header, '');
});

test('an edit sent immediately before closing is saved without any editor timer', async () => {
  const f = fixture();
  const ui = await f.openEditor();
  f.deferReplies();
  ui.element('profile-name').fire('input', 'Closed immediately');
  // Let only the worker finish; the editor never receives its response.
  await f.settle();
  assert.equal(f.data.headerProfilesEditorState.profiles[0].name, 'Closed immediately');
  assert.equal(ui.snapshot().profiles[0].name, 'Closed immediately');
});

test('both editor pages remove Save and expose automatic saving status', () => {
  for (const page of ['popup.html', 'options.html']) {
    assert.doesNotMatch(source(page), /id="save-profile"/);
    assert.match(source(page), /Changes save automatically/);
    assert.match(source(page), /id="grant-access"[^>]*hidden/);
  }
});
