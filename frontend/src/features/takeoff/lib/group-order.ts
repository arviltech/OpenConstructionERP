// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Persisted GROUP order: revisioned band keys + the band-major presentation
 * projection + the row/group reorder planners.
 *
 * Groups have no server entity, so a group's order is a
 * {@link GroupOrderEntry} — a fractional `key` (same alphabet/comparator as
 * row order keys) plus a `(rev, actor)` Lamport pair — mirrored onto each
 * member measurement's metadata (`group_order_key/_rev/_actor`), the same
 * shape group colours use. The pair gives fold-back RECENCY semantics: any
 * single stamped row is sufficient evidence of the newest move, so an
 * interrupted stamp can never resurrect an older order (canonical position
 * alone encodes no recency). `rev` is a document-wide counter; `actor` is a
 * per-tab unique id so the order stays total even for two tabs of one
 * browser.
 *
 * Band order never rewrites row keys: the flat canonical array remains the
 * storage/sync order, and {@link presentationOrder} is the ONE band-major
 * projection every visual consumer reads (sidebar, canvas paint reversed,
 * hit-testing forward, exports, legend, BOQ ordinals).
 */

import {
  generateJitteredKeyBetween,
  generateNKeysBetween,
  isValidOrderKey,
  materializeKeys,
  type OrderAssignment,
  type PlannableRow,
  type Rng,
} from './order-key';

/* ── Revisioned group order entries ───────────────────────────────────── */

export interface GroupOrderEntry {
  /** Fractional band key (same alphabet as row order keys). */
  key: string;
  /** Document-wide Lamport counter; each user move writes max-seen + 1. */
  rev: number;
  /** Per-tab unique writer id — tiebreak so the (rev, actor) order is total. */
  actor: string;
}

/** Total recency order on entries: by rev, then actor (codepoint). */
export function compareGroupOrderEntries(
  a: GroupOrderEntry,
  b: GroupOrderEntry,
): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.actor < b.actor) return -1;
  if (a.actor > b.actor) return 1;
  return 0;
}

/**
 * The fold-back adoption rule: adopt `observed` when the map has no entry
 * for the group (absence is ignorance, not authority — restored rows must
 * re-teach the map) or when `observed` is strictly newer. Monotone: a stale
 * triple can never replace a newer one, on any row subset, in any order.
 */
export function shouldAdoptGroupOrder(
  current: GroupOrderEntry | undefined,
  observed: GroupOrderEntry,
): boolean {
  return current === undefined || compareGroupOrderEntries(observed, current) > 0;
}

/** Parse a row's mirrored triple; null unless all three parts are sound. */
export function parseGroupOrderTriple(
  key: unknown,
  rev: unknown,
  actor: unknown,
): GroupOrderEntry | null {
  if (!isValidOrderKey(key)) return null;
  if (typeof rev !== 'number' || !Number.isFinite(rev) || rev < 0) return null;
  if (typeof actor !== 'string' || actor.length === 0) return null;
  return { key, rev, actor };
}

export type GroupOrderMap = Record<string, GroupOrderEntry>;

/** Highest rev present anywhere in a map (counter seeding input). */
export function maxGroupOrderRev(map: GroupOrderMap): number {
  let max = 0;
  for (const entry of Object.values(map)) {
    if (entry.rev > max) max = entry.rev;
  }
  return max;
}

/* ── Band order + presentation projection ─────────────────────────────── */

interface GroupedRow {
  group: string;
}

/**
 * Band order over the groups present in `rows` (rows in canonical flat
 * order): keyed bands first, by band-key codepoint order (name tiebreak so
 * duplicate keys stay deterministic), then keyless bands in emergent
 * first-appearance order — the same two-band pattern as row keys, so a
 * document with no band keys shows exactly the order it shows today.
 */
export function bandOrder(
  rows: readonly GroupedRow[],
  entries: GroupOrderMap,
): string[] {
  const emergent: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!seen.has(r.group)) {
      seen.add(r.group);
      emergent.push(r.group);
    }
  }
  const keyed = emergent.filter((g) => entries[g] !== undefined);
  const keyless = emergent.filter((g) => entries[g] === undefined);
  keyed.sort((a, b) => {
    const ka = entries[a]!.key;
    const kb = entries[b]!.key;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return [...keyed, ...keyless];
}

/**
 * The band-major projection: rows regrouped so each band is contiguous, bands
 * in {@link bandOrder}, rows within a band in their input (canonical)
 * relative order. Storage order is never written back from this.
 */
export function presentationOrder<T extends GroupedRow>(
  rows: readonly T[],
  entries: GroupOrderMap,
): T[] {
  const order = bandOrder(rows, entries);
  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    let bucket = byGroup.get(r.group);
    if (!bucket) {
      bucket = [];
      byGroup.set(r.group, bucket);
    }
    bucket.push(r);
  }
  const out: T[] = [];
  for (const g of order) {
    const bucket = byGroup.get(g);
    if (bucket) out.push(...bucket);
  }
  return out;
}

/* ── Row slot-reorder planner ─────────────────────────────────────────── */

export interface RowReorderTarget {
  /** Place the moved row immediately AFTER this row… */
  afterId?: string;
  /** …or immediately BEFORE this row (exactly one of the two). */
  beforeId?: string;
  /** Group after the drop; defaults to the anchor row's group. */
  group?: string;
}

export interface RowReorderPlan<T extends PlannableRow> {
  /** The flat array in its new canonical order with group/keys applied. */
  rows: T[];
  /** Phase-1 order-preserving materialization writes (may be empty). */
  preserve: OrderAssignment[];
  /** The moved row's post-phase-1 key (undo restores this). */
  movedPreviousKey: string;
  movedNewKey: string;
  /** Group after the drop (=== the moved row's group when unchanged). */
  newGroup: string;
  previousGroup: string;
}

/**
 * Plan a drop of one row into an explicit slot (between two rows, same or
 * different group). Distinct from {@link planGroupMove}: that plans the
 * append-to-band gesture and nulls on same-group; this one expresses slots.
 * Phase 1 reuses the DOCUMENT-WIDE materialization core — a no-op on a fully
 * keyed document — then the moved row takes a single between-key at the slot,
 * so steady-state cost is one write.
 */
export function planRowReorder<T extends PlannableRow>(
  rows: T[],
  movedId: string,
  target: RowReorderTarget,
  rng: Rng = Math.random,
): RowReorderPlan<T> | null {
  const moved = rows.find((r) => r.id === movedId);
  if (!moved) return null;
  const anchorId = target.afterId ?? target.beforeId;
  if (!anchorId || anchorId === movedId) return null;
  const anchor = rows.find((r) => r.id === anchorId);
  if (!anchor) return null;

  const { keyOf, preserve } = materializeKeys(rows);
  const movedPreviousKey = keyOf.get(movedId)!;
  const newGroup = target.group ?? anchor.group;

  const without = rows.filter((r) => r.id !== movedId);
  const anchorIdx = without.findIndex((r) => r.id === anchorId);
  const insertAt = target.afterId !== undefined ? anchorIdx + 1 : anchorIdx;

  const lo = insertAt > 0 ? keyOf.get(without[insertAt - 1]!.id)! : null;
  const hi = insertAt < without.length ? keyOf.get(without[insertAt]!.id)! : null;
  const movedNewKey = generateJitteredKeyBetween(lo, hi, rng);
  keyOf.set(movedId, movedNewKey);

  const movedFinal = { ...moved, group: newGroup };
  const reordered = [
    ...without.slice(0, insertAt),
    movedFinal,
    ...without.slice(insertAt),
  ];
  const finalRows = reordered.map((r) => {
    const k = keyOf.get(r.id);
    return k !== undefined && k !== r.orderKey ? { ...r, orderKey: k } : r;
  });

  return {
    rows: finalRows,
    preserve,
    movedPreviousKey,
    movedNewKey,
    newGroup,
    previousGroup: moved.group,
  };
}

/* ── Group band-reorder planner ───────────────────────────────────────── */

export interface GroupReorderPlan {
  /** The final map with phase-1 + phase-2 entries applied. */
  entries: GroupOrderMap;
  /**
   * Phase 1 — order-preserving: a fresh entry for EVERY band at its current
   * position (shared rev), in band order. Empty when all bands already carry
   * a valid ascending skeleton. Stamping any prefix leaves band order
   * unchanged.
   */
  phase1: Array<{ group: string; entry: GroupOrderEntry }>;
  /** Phase 2 — the moved band's new key at a fresh rev, applied LAST. */
  phase2: { group: string; entry: GroupOrderEntry };
  /** The moved band's post-phase-1 entry (undo restores its KEY, at a fresh
   *  rev minted at undo time — never a keyless state). */
  movedPreviousEntry: GroupOrderEntry;
}

/**
 * Plan moving `movedGroup` to `targetIndex` in the band list. `bands` is the
 * CURRENT band order (from {@link bandOrder}); `targetIndex` is the desired
 * index in the final list (after the moved band is removed). `revs.phase1`
 * / `revs.phase2` are two fresh ascending revision numbers minted by the
 * caller (`phase1 < phase2`).
 */
export function planGroupReorder(
  bands: readonly string[],
  entries: GroupOrderMap,
  movedGroup: string,
  targetIndex: number,
  revs: { phase1: number; phase2: number },
  actor: string,
  rng: Rng = Math.random,
): GroupReorderPlan | null {
  if (!bands.includes(movedGroup)) return null;
  const clamped = Math.max(0, Math.min(targetIndex, bands.length - 1));

  // ── Phase 1: materialize band keys at current positions ──
  // Bands are few, so a broken/partial skeleton re-keys ALL bands rather
  // than gap-filling (simpler, and the shared rev makes a half-stamped
  // materialization converge forward instead of flip-flopping).
  const working: GroupOrderMap = { ...entries };
  let skeletonOk = true;
  let prev: string | null = null;
  for (const g of bands) {
    const e = working[g];
    if (e === undefined || !isValidOrderKey(e.key)) {
      skeletonOk = false;
      break;
    }
    if (prev !== null && e.key <= prev) {
      skeletonOk = false;
      break;
    }
    prev = e.key;
  }

  const phase1: Array<{ group: string; entry: GroupOrderEntry }> = [];
  if (!skeletonOk) {
    const fresh = generateNKeysBetween(null, null, bands.length);
    bands.forEach((g, i) => {
      const entry: GroupOrderEntry = {
        key: fresh[i]!,
        rev: revs.phase1,
        actor,
      };
      working[g] = entry;
      phase1.push({ group: g, entry });
    });
  }

  const movedPreviousEntry = working[movedGroup]!;

  // ── Phase 2: the moved band's key between its new neighbors ──
  const withoutMoved = bands.filter((g) => g !== movedGroup);
  const at = Math.min(clamped, withoutMoved.length);
  const lo = at > 0 ? working[withoutMoved[at - 1]!]!.key : null;
  const hi = at < withoutMoved.length ? working[withoutMoved[at]!]!.key : null;
  const entry: GroupOrderEntry = {
    key: generateJitteredKeyBetween(lo, hi, rng),
    rev: revs.phase2,
    actor,
  };
  const final: GroupOrderMap = { ...working, [movedGroup]: entry };

  return {
    entries: final,
    phase1,
    phase2: { group: movedGroup, entry },
    movedPreviousEntry,
  };
}
