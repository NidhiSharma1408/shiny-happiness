// Helpers used by popup.js. Only the chrome.* wrappers touch browser APIs;
// everything else is pure so it can be tested in Node.

const DEFAULT_SETTINGS = {
  webAppUrl: '',
  secret: '',
  defaultEmail: '',
  defaultStatus: 'Applied',
};

// Query params that are pure tracking noise. Anything else is kept because some sites
// (e.g. LinkedIn's currentJobId) carry the job identity in the query string.
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|refid|trackingid|trk.*|lipi|midtoken|midsig|ebp|originalsubdomain|src|source)$/i;

const PLATFORMS = [
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)naukri\.com$/, 'Naukri'],
  [/(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/, 'Workday'],
  [/(^|\.)indeed\.[a-z.]+$/, 'Indeed'],
  [/(^|\.)wellfound\.com$/, 'Wellfound'],
  [/(^|\.)instahyre\.com$/, 'Instahyre'],
  [/(^|\.)foundit\.in$/, 'Foundit'],
  [/(^|\.)internshala\.com$/, 'Internshala'],
  [/(^|\.)glassdoor\.[a-z.]+$/, 'Glassdoor'],
  [/(^|\.)greenhouse\.io$/, 'Greenhouse'],
  [/(^|\.)lever\.co$/, 'Lever'],
  [/(^|\.)ashbyhq\.com$/, 'Ashby'],
];

/** Load settings from chrome.storage.local, merged over defaults. */
export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/** Persist settings to chrome.storage.local. */
export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
}

/** Return the currently active tab as { id, url, title }. */
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return { id: tab.id, url: tab.url || '', title: tab.title || '' };
}

/**
 * Read the user's highlighted text on the page (first non-empty across frames).
 * Returns '' if nothing is selected or the page can't be scripted (chrome://, PDF viewer, store pages).
 */
export async function getSelectedText(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => window.getSelection().toString(),
    });
    const hit = results.map((r) => r.result || '').find((t) => t.trim());
    return hit ? hit.replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  }
}

/**
 * Start click-to-map for `field` (jobId | company | role | applyButton): the page gets a hover
 * boundary, the next click is captured by mapper.js and saved to chrome.storage.local.
 */
export async function startMapping(tabId, field) {
  await chrome.storage.local.set({ mapRequest: { field } });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['mapper.js'] });
}

/** Return (and clear) the latest mapping capture for this page's host if it is under 10 min old. */
export async function takeLastCapture(url) {
  const { lastCapture } = await chrome.storage.local.get('lastCapture');
  if (!lastCapture) return null;
  await chrome.storage.local.remove('lastCapture');
  let host = '';
  try { host = new URL(url).hostname; } catch { /* keep '' */ }
  const fresh = Date.now() - lastCapture.at < 10 * 60 * 1000;
  return fresh && lastCapture.host === host ? lastCapture : null;
}

/** Which fields (role, company, jobId, applyButton) already have a saved mapping for this URL's host. */
export async function getMappedFields(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return []; }
  const { mappings = {} } = await chrome.storage.local.get('mappings');
  return Object.keys(mappings[host] || {});
}

/** Map a URL's hostname to a platform label, else the bare hostname. */
export function derivePlatform(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  for (const [pattern, label] of PLATFORMS) {
    if (pattern.test(host)) return label;
  }
  return host.replace(/^www\./, '');
}

/** Drop the fragment and tracking params, sort the rest, so one job always yields one URL. */
export function normalizeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return (url || '').trim();
  }
  u.hash = '';
  const kept = [...u.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/** FNV-1a 32-bit hash as "h-xxxxxxxx". The prefix stops Sheets reading it as a number (e.g. "12e4"). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'h-' + (h >>> 0).toString(16).padStart(8, '0');
}

/** Use the Job ID the user provided; only if blank, fall back to a hash of the normalized URL. */
export function resolveJobId(userJobId, url) {
  const id = (userJobId || '').trim();
  return id || hashString(normalizeUrl(url));
}

/** Turn raw form values + settings into the JSON payload the Apps Script endpoint expects. */
export function buildPayload(formValues, settings) {
  const v = formValues;
  const url = normalizeUrl(v.url);
  return {
    secret: settings.secret,
    date: (v.date || '').trim(),
    platform: (v.platform || '').trim(),
    jobId: resolveJobId(v.jobId, url),
    company: (v.company || '').trim(),
    role: (v.role || '').trim(),
    url,
    email: (v.email || '').trim(),
    status: (v.status || '').trim(),
    notes: (v.notes || '').trim(),
  };
}

/**
 * POST the payload to the Apps Script web app. text/plain avoids a CORS preflight.
 * Resolves to { ok, duplicate?, existingDate?, error? }.
 */
export async function postToSheet(payload, settings) {
  if (!settings.webAppUrl) throw new Error('Set the web app URL in Settings first');
  if (!settings.secret) throw new Error('Set the shared secret in Settings first');

  const res = await fetch(settings.webAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Web app returned HTTP ${res.status}`);

  try {
    return await res.json();
  } catch {
    throw new Error('Unexpected response. Check the deployment is set to "Anyone" and the URL ends in /exec');
  }
}
