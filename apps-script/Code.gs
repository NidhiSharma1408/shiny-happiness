/**
 * Job Logger backend.
 *
 * Setup:
 *  1. Open your Google Sheet -> Extensions -> Apps Script, paste this file.
 *  2. Project Settings -> Script Properties -> add SECRET = <any long random string>.
 *  3. Deploy -> New deployment -> Web app -> Execute as: Me, Who has access: Anyone.
 *  4. Put the /exec URL and the same secret into the extension's Settings.
 */

var SHEET_NAME = "Applications";
var HEADERS = [
	"Date",
	"Platform",
	"Job ID",
	"Company",
	"Role",
	"URL",
	"Email used",
	"Status",
	"Last email",
	"Notes",
];
var JOB_ID_COLUMN = 3; // 1-based, matches HEADERS

/** Web app entry point. Parses JSON body, checks secret, dedupes, appends, responds. */
function doPost(e) {
	try {
		var payload = JSON.parse(e.postData.contents);

		if (!isAuthorized_(payload)) {
			return jsonResponse_({ ok: false, error: "Unauthorized" });
		}
		if (!payload.jobId || !payload.url) {
			return jsonResponse_({
				ok: false,
				error: "jobId and url are required",
			});
		}

		var sheet = getSheet_();
		var dup = findDuplicate_(sheet, payload.platform, payload.jobId);
		if (dup) {
			return jsonResponse_({
				ok: true,
				duplicate: true,
				existingDate: dup.date,
				row: dup.row,
			});
		}

		appendJob_(sheet, payload);
		return jsonResponse_({ ok: true, duplicate: false });
	} catch (err) {
		return jsonResponse_({ ok: false, error: String(err) });
	}
}

/** True if payload.secret matches the SECRET script property. */
function isAuthorized_(payload) {
	var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
	return !!secret && payload && payload.secret === secret;
}

/** Get the Applications sheet (create it if missing) and make sure row 1 holds HEADERS. */
function getSheet_() {
	var ss = SpreadsheetApp.getActiveSpreadsheet();
	var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

	if (sheet.getLastRow() === 0) {
		sheet
			.getRange(1, 1, 1, HEADERS.length)
			.setValues([HEADERS])
			.setFontWeight("bold");
		sheet.setFrozenRows(1);
		// Keep Job IDs as text so values like "000123" or "12e4" are never reinterpreted.
		sheet
			.getRange(1, JOB_ID_COLUMN, sheet.getMaxRows(), 1)
			.setNumberFormat("@");
	}
	return sheet;
}

/** Return { row, date } of an existing row with the same Platform + Job ID, or null. */
function findDuplicate_(sheet, platform, jobId) {
	var last = sheet.getLastRow();
	if (last < 2) return null;

	var tz = sheet.getParent().getSpreadsheetTimeZone();
	var rows = sheet.getRange(2, 1, last - 1, JOB_ID_COLUMN).getValues();
	for (var i = 0; i < rows.length; i++) {
		var rowPlatform = String(rows[i][1]);
		var rowJobId = String(rows[i][2]);
		if (rowPlatform === String(platform) && rowJobId === String(jobId)) {
			var d = rows[i][0];
			var date =
				d instanceof Date
					? Utilities.formatDate(d, tz, "yyyy-MM-dd")
					: String(d);
			return { row: i + 2, date: date };
		}
	}
	return null;
}

/** Append one row in HEADERS order. */
function appendJob_(sheet, payload) {
	sheet.appendRow([
		safe_(payload.date),
		safe_(payload.platform),
		safe_(payload.jobId),
		safe_(payload.company),
		safe_(payload.role),
		safe_(payload.url),
		safe_(payload.email),
		safe_(payload.status),
		"", // Last email: filled later by the Gmail sync
		safe_(payload.notes),
	]);
}

/** Wrap an object as a JSON ContentService response. */
function jsonResponse_(obj) {
	return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
		ContentService.MimeType.JSON
	);
}

/** Stringify a value and neutralize leading =,+,-,@ so page text can't become a formula. */
function safe_(value) {
	var s = value == null ? "" : String(value);
	return /^[=+\-@]/.test(s) ? "'" + s : s;
}
