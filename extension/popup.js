import {
  loadSettings, saveSettings, getActiveTab, getSelectedText,
  derivePlatform, buildPayload, postToSheet,
} from './lib.js';
import { detectFields } from './adapters.js';

const $ = (id) => document.getElementById(id);

const FORM_FIELDS = ['url', 'date', 'platform', 'jobId', 'company', 'role', 'email', 'notes'];

/** Entry point: load settings, prefill the form, wire up buttons. */
async function init() {
  const settings = await loadSettings();
  renderSettings(settings);
  $('saveSettings').addEventListener('click', onSaveSettings);
  $('save').addEventListener('click', onSave);

  if (!settings.webAppUrl || !settings.secret) {
    document.querySelector('details').open = true;
    showStatus('Add your web app URL and secret in Settings to get started.', 'warn');
  }

  let tab;
  try {
    tab = await getActiveTab();
  } catch (err) {
    showStatus(err.message, 'error');
    return;
  }
  await prefillForm(tab, settings);
  wireSelectionButtons(tab);
}

/** Fill URL, date (today), platform, email/status defaults, plus anything detectFields finds. */
async function prefillForm(tab, settings) {
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  $('url').value = tab.url;
  $('date').value = today;
  $('platform').value = derivePlatform(tab.url);
  $('email').value = settings.defaultEmail;
  $('status-select').value = settings.defaultStatus;

  const detected = await detectFields(tab);
  for (const key of ['company', 'role', 'jobId']) {
    if (detected[key]) $(key).value = detected[key];
  }
}

/** Hook every "Use selection" button: grab highlighted text and put it into its target field. */
function wireSelectionButtons(tab) {
  document.querySelectorAll('[data-fill]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = await getSelectedText(tab.id);
      if (!text) {
        showStatus('Highlight some text on the page first, then click again.', 'warn');
        return;
      }
      $(btn.dataset.fill).value = text;
      showStatus('', '');
    });
  });
}

/** Read all form fields into a plain object. */
function readForm() {
  const values = {};
  for (const id of FORM_FIELDS) values[id] = $(id).value;
  values.status = $('status-select').value;
  return values;
}

/** Validate, build payload, post to sheet, and report the outcome. */
async function onSave() {
  const form = readForm();
  if (!form.url.trim() || !form.company.trim() || !form.role.trim()) {
    showStatus('URL, company and role are required.', 'error');
    return;
  }

  const btn = $('save');
  btn.disabled = true;
  showStatus('Saving…', '');
  try {
    const settings = await loadSettings();
    const result = await postToSheet(buildPayload(form, settings), settings);
    if (!result.ok) {
      showStatus(result.error || 'The sheet rejected the request.', 'error');
    } else if (result.duplicate) {
      showStatus(`Already logged on ${result.existingDate}. Nothing added.`, 'warn');
    } else {
      showStatus('Added to your sheet ✓', 'ok');
    }
  } catch (err) {
    // Form values stay in place so the user can just click Save again.
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/** Show a message under the form. type: "ok" | "warn" | "error" | "" for neutral. */
function showStatus(message, type) {
  const el = $('status');
  el.textContent = message;
  el.className = type || '';
}

/** Populate the settings section from stored settings. */
function renderSettings(settings) {
  $('webAppUrl').value = settings.webAppUrl;
  $('secret').value = settings.secret;
  $('defaultEmail').value = settings.defaultEmail;
  $('defaultStatus').value = settings.defaultStatus;
}

/** Read the settings section and persist it. */
async function onSaveSettings() {
  await saveSettings({
    webAppUrl: $('webAppUrl').value.trim(),
    secret: $('secret').value.trim(),
    defaultEmail: $('defaultEmail').value.trim(),
    defaultStatus: $('defaultStatus').value,
  });
  showStatus('Settings saved.', 'ok');
}

init().catch((err) => showStatus(err.message, 'error'));
