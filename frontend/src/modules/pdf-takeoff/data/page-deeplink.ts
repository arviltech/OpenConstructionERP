// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * URL <-> state rules for the PDF takeoff viewer's current-page deep link.
 *
 * The viewer restores the sheet a user was last on from a `?page=` URL
 * parameter, mirroring the existing `?measurementId=` deep link. These are the
 * pure rules that govern that round trip, factored out of `TakeoffPage` and
 * `TakeoffViewerModule` so each can be unit-tested without mounting the viewer:
 *
 *   - `parsePageParam`     read `?page=` into a 1-based page (or nothing);
 *   - `resolveInitialPage` apply the deep-linked page ONLY to the document it
 *                          names, so a filmstrip switch to another sheet-set
 *                          never carries the page onto it;
 *   - `clampPage`          keep a restored page inside the document's range;
 *   - `pageParamForUrl`    write the page back, dropping it at page 1 for a
 *                          clean URL.
 */

/**
 * Parse a `?page=` URL value into a 1-based page number, or `undefined` when it
 * is absent or not a positive integer. A junk value therefore falls back to
 * page 1 at the call site rather than restoring page 0 or NaN.
 */
export function parsePageParam(raw: string | null | undefined): number | undefined {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The page deep link belongs to ONE document: the one named in the same URL.
 * The viewer is keyed by document id and remounts on a filmstrip switch, while
 * the host page does not, so an unscoped `initialPage` would be re-applied to
 * the next document opened. Return the captured page only while the shown
 * document is the deep-linked one; otherwise `undefined`.
 */
export function resolveInitialPage(
  shownDocumentId: string | null | undefined,
  deepLinkDocumentId: string | null | undefined,
  initialPage: number | undefined,
): number | undefined {
  return shownDocumentId && shownDocumentId === deepLinkDocumentId
    ? initialPage
    : undefined;
}

/** Clamp a restored page into the document's valid 1..numPages range. */
export function clampPage(page: number, numPages: number): number {
  return Math.max(1, Math.min(page, numPages));
}

/**
 * The value to store in the `?page=` URL parameter, or `null` to delete it.
 * Page 1 keeps a clean URL (no param), matching how the viewer treats a fresh
 * document that has no meaningful prior page.
 */
export function pageParamForUrl(page: number): string | null {
  return page > 1 ? String(page) : null;
}
