/**
 * Shared data and rule-building logic used by the popup and service worker.
 * This file also owns storage normalization so older saved profiles and JSON
 * imports are upgraded into the current schema before they are used.
 */
(function initializeHeaderProfiles(globalScope) {
  'use strict';

  const STORAGE_KEY = 'headerProfilesState';
  const SELECTED_PROFILE_KEY = 'selectedProfileId';
  const SCHEMA_VERSION = 3;
  const MAX_DYNAMIC_HEADER_RULES = 5000;
  const APPENDABLE_REQUEST_HEADERS = new Set([
    'accept', 'accept-encoding', 'accept-language', 'access-control-request-headers',
    'cache-control', 'connection', 'content-language', 'cookie', 'forwarded', 'if-match',
    'if-none-match', 'keep-alive', 'range', 'te', 'trailer', 'transfer-encoding',
    'upgrade', 'user-agent', 'via', 'want-digest', 'x-forwarded-for',
  ]);
  const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

  function createId() {
    return crypto.randomUUID();
  }

  /** Create a disabled, ready-to-edit header rule with a broad default scope. */
  function createRule(direction = 'request') {
    return {
      id: createId(),
      enabled: false,
      direction,
      operation: 'set',
      header: '',
      value: '',
      includePatterns: ['*'],
      excludedDomains: [],
    };
  }

  /** Create a profile containing one blank rule and matching creation/update timestamps. */
  function createProfile(name = 'New profile') {
    const timestamp = new Date().toISOString();
    return { id: createId(), name, rules: [createRule()], createdAt: timestamp, updatedAt: timestamp };
  }

  /** Return the initial state: one inactive Development profile. */
  function createDefaultState() {
    return { schemaVersion: SCHEMA_VERSION, activeProfileId: null, profiles: [createProfile('Development')] };
  }

  /** Trim and deduplicate URL filters, falling back when the input is not a list. */
  function normalizePatterns(patterns, fallback = ['*']) {
    if (!Array.isArray(patterns)) return fallback;
    const normalized = patterns
      .filter((pattern) => typeof pattern === 'string')
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    return [...new Set(normalized)];
  }

  /** Trim, lowercase, and deduplicate hostnames used to exclude requests. */
  function normalizeDomains(domains) {
    return [...new Set((Array.isArray(domains) ? domains : [])
      .filter((domain) => typeof domain === 'string')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean))];
  }

  /** Convert a stored or imported rule to the current shape and safe defaults. */
  function normalizeRule(rule) {
    const validDirections = new Set(['request', 'response']);
    const validOperations = new Set(['set', 'append', 'remove']);
    return {
      id: typeof rule?.id === 'string' ? rule.id : createId(),
      enabled: rule?.enabled === true,
      direction: validDirections.has(rule?.direction) ? rule.direction : 'request',
      operation: validOperations.has(rule?.operation) ? rule.operation : 'set',
      header: typeof rule?.header === 'string' ? rule.header : (typeof rule?.name === 'string' ? rule.name : ''),
      value: typeof rule?.value === 'string' ? rule.value : '',
      includePatterns: normalizePatterns(rule?.includePatterns),
      excludedDomains: normalizeDomains(rule?.excludedDomains),
    };
  }

  /** Convert the old profile-with-headers format into the current per-rule format. */
  function migrateLegacyProfile(profile, index) {
    const legacyHeaders = Array.isArray(profile?.headers) ? profile.headers : [];
    const rules = legacyHeaders.map((header) => normalizeRule({
      ...header,
      enabled: header?.enabled !== false,
      direction: 'request',
      header: header?.name,
      includePatterns: [typeof profile?.urlFilter === 'string' ? profile.urlFilter : '*'],
      excludedDomains: profile?.excludedDomains,
    }));
    const timestamp = new Date().toISOString();
    return {
      id: typeof profile?.id === 'string' ? profile.id : createId(),
      name: typeof profile?.name === 'string' ? profile.name : `Profile ${index + 1}`,
      rules: rules.length > 0 ? rules : [createRule()],
      createdAt: typeof profile?.createdAt === 'string' ? profile.createdAt : timestamp,
      updatedAt: typeof profile?.updatedAt === 'string' ? profile.updatedAt : timestamp,
      legacyEnabled: profile?.enabled === true,
    };
  }

  /** Normalize a current profile or route an older profile through migration. */
  function normalizeProfile(profile, index) {
    if (Array.isArray(profile?.rules)) {
      const rules = profile.rules.map(normalizeRule);
      const timestamp = new Date().toISOString();
      return {
        id: typeof profile?.id === 'string' ? profile.id : createId(),
        name: typeof profile?.name === 'string' ? profile.name : `Profile ${index + 1}`,
        rules: rules.length > 0 ? rules : [createRule()],
        createdAt: typeof profile?.createdAt === 'string' ? profile.createdAt : timestamp,
        updatedAt: typeof profile?.updatedAt === 'string' ? profile.updatedAt : timestamp,
      };
    }
    return migrateLegacyProfile(profile, index);
  }

  /** Normalize the whole state and preserve legacy activation when possible. */
  function normalizeState(state) {
    if (!state || !Array.isArray(state.profiles)) return createDefaultState();
    const profiles = state.profiles.map(normalizeProfile);
    let activeProfileId = typeof state.activeProfileId === 'string' ? state.activeProfileId : null;
    if (!activeProfileId && state.enabled !== false) {
      activeProfileId = profiles.find((profile) => profile.legacyEnabled)?.id ?? null;
    }
    if (!profiles.some((profile) => profile.id === activeProfileId)) activeProfileId = null;
    return {
      schemaVersion: SCHEMA_VERSION,
      activeProfileId,
      profiles: profiles.map(({ legacyEnabled, ...profile }) => profile),
    };
  }

  /** Load saved settings, migrating and persisting them when the schema changed. */
  async function loadState() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const state = normalizeState(result[STORAGE_KEY]);
    if (!result[STORAGE_KEY] || result[STORAGE_KEY]?.schemaVersion !== SCHEMA_VERSION) await saveState(state);
    return state;
  }

  /** Normalize settings before saving so storage always contains the current schema. */
  async function saveState(state) {
    const normalizedState = normalizeState(state);
    await chrome.storage.local.set({ [STORAGE_KEY]: normalizedState });
    return normalizedState;
  }

  /** Look up the active profile, returning null for the global Off state. */
  function getActiveProfile(state) {
    return state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
  }

  /** Check Chrome's basic URL-filter constraints and return an error message if invalid. */
  function validateUrlFilter(pattern) {
    if (!pattern) return 'A URL filter is required. Use * to match every request.';
    if (/[^\x00-\x7F]/.test(pattern) || /[\r\n]/.test(pattern)) {
      return `“${pattern}” must contain only ASCII characters and no line breaks.`;
    }
    if (pattern.startsWith('||*')) return 'A URL filter cannot start with ||*. Use * to match every request.';
    return null;
  }

  /** Validate an enabled rule's header, operation, URL scope, and excluded domains. */
  function validateRule(rule) {
    if (!rule.enabled) return [];
    const errors = [];
    const header = rule.header.trim();
    if (!header) errors.push('Header name is required.');
    else if (!HEADER_NAME_PATTERN.test(header)) errors.push(`“${rule.header}” is not a valid header name.`);
    if (rule.operation !== 'remove' && /[\r\n]/.test(rule.value)) {
      errors.push(`“${header || 'Header value'}” contains an invalid line break.`);
    }
    if (rule.direction === 'request' && rule.operation === 'append' && !APPENDABLE_REQUEST_HEADERS.has(header.toLowerCase())) {
      errors.push(`Chrome does not allow appending to request header “${header}”. Use Set instead.`);
    }
    if (rule.includePatterns.length === 0) errors.push('At least one URL filter is required.');
    rule.includePatterns.forEach((pattern) => {
      const error = validateUrlFilter(pattern);
      if (error) errors.push(error);
    });
    rule.excludedDomains.forEach((domain) => {
      if (!DOMAIN_PATTERN.test(domain) || domain.includes('..')) errors.push(`“${domain}” is not a valid excluded domain.`);
    });
    return errors;
  }

  /** Count how many Chrome declarative rules enabled source rules will generate. */
  function compiledRuleCount(profile) {
    return profile.rules.filter((rule) => rule.enabled)
      .reduce((count, rule) => count + rule.includePatterns.length, 0);
  }

  /** Validate a profile and ensure its rule count stays within Chrome's limit. */
  function validateProfile(profile) {
    const errors = [];
    if (!profile.name.trim()) errors.push('Profile name is required.');
    profile.rules.forEach((rule, index) => {
      validateRule(rule).forEach((error) => errors.push(`Rule ${index + 1}: ${error}`));
    });
    if (compiledRuleCount(profile) > MAX_DYNAMIC_HEADER_RULES) {
      errors.push(`This profile generates more than ${MAX_DYNAMIC_HEADER_RULES} Chrome rules.`);
    }
    return [...new Set(errors)];
  }

  /**
   * Compile the active profile into Chrome dynamic rules. Each URL filter gets
   * its own rule; earlier rules receive higher priority when scopes overlap.
   * Invalid profiles and the Off state produce no rules.
   */
  function compileRules(state) {
    const activeProfile = getActiveProfile(state);
    if (!activeProfile || validateProfile(activeProfile).length > 0) return [];
    let ruleId = 1;
    const totalSourceRules = activeProfile.rules.length;
    return activeProfile.rules.flatMap((rule, sourceIndex) => {
      if (!rule.enabled) return [];
      return rule.includePatterns.map((urlFilter) => {
        const condition = { urlFilter };
        if (rule.excludedDomains.length > 0) condition.excludedRequestDomains = rule.excludedDomains;
        const operation = { header: rule.header.trim(), operation: rule.operation };
        if (rule.operation !== 'remove') operation.value = rule.value;
        const action = { type: 'modifyHeaders' };
        action[rule.direction === 'request' ? 'requestHeaders' : 'responseHeaders'] = [operation];
        return { id: ruleId++, priority: totalSourceRules - sourceIndex, action, condition };
      });
    });
  }

  /**
   * Derive optional host permissions from enabled rule scopes. Broad or
   * ambiguous filters require access to all HTTP and HTTPS origins.
   */
  function getProfileOrigins(profile) {
    const allOrigins = ['http://*/*', 'https://*/*'];
    const origins = new Set();
    for (const rule of profile.rules.filter((candidate) => candidate.enabled)) {
      for (const rawPattern of rule.includePatterns) {
        const pattern = rawPattern.trim();
        if (pattern === '*') return allOrigins;
        const domainMatch = pattern.match(/^\|\|([^/^*]+)(?:[\/^]|$)/);
        const urlMatch = pattern.match(/^\|?(https?):\/\/([^/:^*]+)(?:[/:^]|$)/);
        const simpleDomainMatch = pattern.match(/^([a-z0-9.-]+)$/i);
        if (domainMatch) {
          origins.add(`http://*.${domainMatch[1]}/*`);
          origins.add(`https://*.${domainMatch[1]}/*`);
        } else if (urlMatch) {
          origins.add(`${urlMatch[1]}://${urlMatch[2]}/*`);
        } else if (simpleDomainMatch) {
          origins.add(`http://*.${simpleDomainMatch[1]}/*`);
          origins.add(`https://*.${simpleDomainMatch[1]}/*`);
        } else if (pattern.includes('*')) {
          return allOrigins;
        } else {
          return allOrigins;
        }
      }
    }
    return origins.size > 0 ? [...origins] : [];
  }

  globalScope.HeaderProfiles = {
    APPENDABLE_REQUEST_HEADERS,
    MAX_DYNAMIC_HEADER_RULES,
    SCHEMA_VERSION,
    SELECTED_PROFILE_KEY,
    STORAGE_KEY,
    compileRules,
    compiledRuleCount,
    createProfile,
    createRule,
    getActiveProfile,
    getProfileOrigins,
    loadState,
    normalizeState,
    saveState,
    validateProfile,
    validateRule,
  };
})(globalThis);
