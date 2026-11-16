# Job Logger

Click the extension on a job page, confirm or highlight-fill the fields, and a row is appended to your Google Sheet.

## 1. Backend (Google Apps Script)
1. Open your Google Sheet, then **Extensions → Apps Script**.
2. Paste `apps-script/Code.gs` over the default file and save.
3. **Project Settings → Script Properties → Add**: `SECRET` = any long random string.
4. **Deploy → New deployment → Web app**. Execute as **Me**, access **Anyone**. Authorize when asked.
5. Copy the `/exec` URL.

The script creates an `Applications` tab with headers on the first save.

## 2. Extension
1. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the `extension/` folder.
2. Click the icon, open **Settings**, paste the `/exec` URL and the same secret, set your default email, **Save settings**.

## Using it
- URL, date and platform fill automatically. Job ID is optional: leave it blank and a hash of the cleaned URL is used.
- Highlight text on the page, then click **Use selection** next to Job ID / Company / Role.
- Duplicates (same platform + Job ID) are reported and not added.

## After editing Code.gs
Deploy → Manage deployments → edit → **New version**, otherwise the live URL keeps running the old code.

## Layout
- `extension/lib.js` helpers (settings, selection, URL/ID logic, POST)
- `extension/popup.js` + `popup.html` the UI
- `extension/adapters.js` per-site auto-detection (v1.5, currently a no-op)
- `apps-script/Code.gs` the endpoint
