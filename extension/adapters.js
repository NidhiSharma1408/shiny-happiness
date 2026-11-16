// v1.5: per-site field detection (LinkedIn, Naukri, Workday, generic JSON-LD).
// For v1 this is a deliberate no-op so popup.js can already call it.

/**
 * Try to auto-detect { role, company, jobId } from the page.
 * v1: returns {} so the user fills fields via "Use selection".
 */
export async function detectFields(tab) {
	return {};
}
