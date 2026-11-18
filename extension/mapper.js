// Injected on demand (chrome.scripting.executeScript) when the user clicks "Map" in the popup.
// Hover = blue boundary around the element under the cursor. Click = capture selectors for the
// field named in `mapRequest`. Esc = cancel. The click is swallowed so the page does not react.
(async () => {
  if (window.__jlMapping) return;
  window.__jlMapping = true;

  const MAX_LEVELS = 5;
  const STABLE_ATTRS = ['data-automation-id', 'data-testid', 'data-test', 'data-qa', 'data-id',
                        'aria-label', 'name', 'role', 'itemprop'];
  // Generated-looking class names: long digit runs, css-in-js prefixes, very long hashes, state classes.
  const UNSTABLE_CLASS = /\d{3,}|^(css|jsx|sc|ember|svelte)-|^[\w-]{25,}$|^(active|selected|hover|focus|open|show|is-.*|has-.*)$/;

  const { mapRequest } = await chrome.storage.local.get('mapRequest');
  const field = mapRequest && mapRequest.field;
  if (!field) { window.__jlMapping = false; return; }

  // ---------- selector generation (own code, no dependency) ----------

  const stableId = (id) => !!id && !/\d{4,}/.test(id) && !id.includes('"');
  const quote = (v) => '"' + v.replace(/["\\]/g, '\\$&') + '"';

  function isUnique(sel, el) {
    try {
      const found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch { return false; }
  }

  /** One CSS level: #id, or tag + stable attribute / stable classes, plus :nth-of-type when ambiguous. */
  function step(el) {
    if (stableId(el.id)) return '#' + CSS.escape(el.id);
    let s = el.localName;
    const attr = STABLE_ATTRS.find((a) => {
      const v = el.getAttribute(a);
      return v && v.length < 80;
    });
    if (attr) {
      s += `[${attr}=${quote(el.getAttribute(attr))}]`;
    } else {
      s += [...el.classList].filter((c) => !UNSTABLE_CLASS.test(c)).slice(0, 2)
        .map((c) => '.' + CSS.escape(c)).join('');
    }
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((x) => x.matches(s));
      if (same.length > 1) {
        const idx = [...parent.children].filter((x) => x.localName === el.localName).indexOf(el) + 1;
        s += `:nth-of-type(${idx})`;
      }
    }
    return s;
  }

  /** Climb at most MAX_LEVELS, stopping as soon as the selector is unique or an id anchors it. */
  function cssPath(el) {
    const parts = [];
    for (let node = el, i = 0; node && node.nodeType === 1 && node !== document.documentElement && i < MAX_LEVELS; node = node.parentElement, i++) {
      const s = step(node);
      parts.unshift(s);
      const sel = parts.join(' > ');
      if (isUnique(sel, el)) return { selector: sel, unique: true };
      if (s.startsWith('#')) break;
    }
    const sel = parts.join(' > ');
    return { selector: sel, unique: isUnique(sel, el) };
  }

  /** XPath of at most MAX_LEVELS steps, anchored at the nearest stable id if one is reached. */
  function xpathOf(el) {
    const parts = [];
    for (let node = el, i = 0; node && node.nodeType === 1 && i < MAX_LEVELS; node = node.parentElement, i++) {
      if (stableId(node.id)) { parts.unshift(`*[@id=${quote(node.id)}]`); break; }
      const same = node.parentElement
        ? [...node.parentElement.children].filter((x) => x.localName === node.localName) : [node];
      parts.unshift(same.length > 1 ? `${node.localName}[${same.indexOf(node) + 1}]` : node.localName);
    }
    const xp = '//' + parts.join('/');
    let unique = false;
    try {
      const count = document.evaluate(`count(${xp})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue;
      const first = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      unique = count === 1 && first === el;
    } catch { /* leave unique = false */ }
    return { xpath: xp, unique };
  }

  /** Ranked candidates: unique first; attribute/id selectors, then CSS path, then XPath. */
  function buildCandidates(el) {
    const list = [];
    const add = (type, selector, unique) => list.push({ type, selector, unique });
    if (stableId(el.id)) { const s = '#' + CSS.escape(el.id); add('id', s, isUnique(s, el)); }
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) { const s = `${el.localName}[${a}=${quote(v)}]`; add('attr', s, isUnique(s, el)); }
    }
    const css = cssPath(el);
    add('css', css.selector, css.unique);
    const xp = xpathOf(el);
    add('xpath', xp.xpath, xp.unique);

    const seen = new Set();
    return list
      .filter((c) => (seen.has(c.selector) ? false : seen.add(c.selector)))
      .sort((x, y) => Number(y.unique) - Number(x.unique)); // stable sort keeps the ranking above
  }

  // ---------- overlay + events ----------

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' +
    'border:2px solid #1a73e8;background:rgba(26,115,232,.15);display:none;';
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:12px;top:12px;' +
    'padding:6px 10px;border-radius:4px;background:#1a73e8;color:#fff;font:12px system-ui,sans-serif;';
  tip.textContent = `Mapping "${field}": click the element · Esc to cancel`;
  document.documentElement.append(box, tip);

  let hovered = null;
  function drawBox() {
    if (!hovered) return;
    const r = hovered.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
    });
  }

  const onOver = (e) => { hovered = e.target; drawBox(); };
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];

  function teardown(message) {
    window.removeEventListener('mouseover', onOver, true);
    window.removeEventListener('scroll', drawBox, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    BLOCKED.forEach((t) => window.removeEventListener(t, swallow, true));
    box.remove();
    if (message) {
      tip.textContent = message;
      setTimeout(() => tip.remove(), 2000);
    } else {
      tip.remove();
    }
    window.__jlMapping = false;
  }

  async function onClick(e) {
    swallow(e);
    const el = e.target;
    const candidates = buildCandidates(el);
    const text = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const pathPattern = location.pathname.split('/').map((seg) => (/\d/.test(seg) ? '*' : seg)).join('/');

    const { mappings = {} } = await chrome.storage.local.get('mappings');
    const host = location.hostname;
    mappings[host] = mappings[host] || {};
    mappings[host][field] = { pathPattern, candidates, sample: text, savedAt: new Date().toISOString() };
    await chrome.storage.local.set({
      mappings,
      lastCapture: { field, text, host, at: Date.now() },
    });
    await chrome.storage.local.remove('mapRequest');
    teardown(`Mapped "${field}" ✓ Reopen the extension`);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      swallow(e);
      chrome.storage.local.remove('mapRequest');
      teardown();
    }
  }

  window.addEventListener('mouseover', onOver, true);
  window.addEventListener('scroll', drawBox, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  BLOCKED.forEach((t) => window.addEventListener(t, swallow, true));
})();
