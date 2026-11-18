// Auto-detect job fields on the current page:
//   1. selectors saved by mapper.js for this host (ranked candidates, next one tried on failure)
//   2. the page's schema.org JobPosting JSON-LD, for any field still empty

const FIELDS = ['jobId', 'company', 'role'];

/** Must match how mapper.js builds pathPattern: any segment containing a digit becomes "*". */
function pathPatternOf(url) {
  try {
    return new URL(url).pathname.split('/').map((seg) => (/\d/.test(seg) ? '*' : seg)).join('/');
  } catch {
    return null;
  }
}

/** A mapping made on /jobs/view/* should not fire on /jobs/search, so compare patterns. */
function samePath(pattern, url) {
  const current = pathPatternOf(url);
  if (pattern == null || current == null) return false;
  return pattern.replace(/\/+$/, '') === current.replace(/\/+$/, '');
}

/**
 * Runs INSIDE the page via chrome.scripting.executeScript, so it must be self-contained:
 * no imports and no references to anything outside this function.
 *
 * candidatesByField: { field: [{ type: 'id'|'attr'|'css'|'xpath', selector }] } in ranked order.
 * A candidate only counts if it matches exactly one element and that element has text; otherwise
 * the next candidate is tried. Returns { field: text } for the fields it could read.
 */
export function readFieldsInPage(candidatesByField, fields) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

  function findOne(c) {
    try {
      if (c.type === 'xpath') {
        const count = document.evaluate(`count(${c.selector})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue;
        if (count !== 1) return null;
        return document.evaluate(c.selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      }
      const found = document.querySelectorAll(c.selector);
      return found.length === 1 ? found[0] : null;
    } catch {
      return null; // invalid / stale selector
    }
  }

  const out = {};
  for (const f of fields) {
    for (const c of candidatesByField[f] || []) {
      const el = findOne(c);
      const text = el ? clean(el.innerText || el.textContent || el.value) : '';
      if (text) { out[f] = text; break; }
    }
  }

  // JSON-LD fallback: only fills fields the mappings did not.
  const missing = fields.filter((f) => !out[f]);
  if (missing.length) {
    const jobs = [];
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      if ([].concat(node['@type'] || []).includes('JobPosting')) jobs.push(node);
      walk(node['@graph']);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { walk(JSON.parse(s.textContent)); } catch { /* ignore malformed JSON-LD */ }
    });

    const job = jobs[0];
    if (job) {
      const org = job.hiringOrganization;
      const id = job.identifier;
      const ld = {
        role: str(job.title),
        company: typeof org === 'string' ? org : str(org && org.name),
        jobId: typeof id === 'object' && id ? str(id.value) : str(id),
      };
      for (const f of missing) if (clean(ld[f])) out[f] = clean(ld[f]);
    }
  }
  return out;
}

/**
 * Detect { company, role, jobId } for this tab.
 * Resolves to { values, failed }: `failed` lists fields that have a saved mapping for this page
 * but still came back empty (the selector went stale), so the popup can suggest re-mapping.
 */
export async function detectFields(tab) {
  const nothing = { values: {}, failed: [] };

  let host;
  try { host = new URL(tab.url).hostname; } catch { return nothing; }

  const { mappings = {} } = await chrome.storage.local.get('mappings');
  const hostMap = mappings[host] || {};

  const candidatesByField = {};
  const mapped = [];
  for (const f of FIELDS) {
    const m = hostMap[f];
    if (m && samePath(m.pathPattern, tab.url)) {
      candidatesByField[f] = m.candidates;
      mapped.push(f);
    }
  }

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readFieldsInPage,
      args: [candidatesByField, FIELDS],
    });
    const values = (res && res.result) || {};
    return { values, failed: mapped.filter((f) => !values[f]) };
  } catch {
    return nothing; // restricted page (chrome://, store, PDF viewer): the user falls back to manual
  }
}
