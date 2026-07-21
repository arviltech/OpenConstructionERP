// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/** Unit tests for the persisted GROUP order layer: revisioned entries,
 *  band-major presentation projection, and the row/group reorder planners. */

import { describe, expect, it } from 'vitest';

import {
  bandOrder,
  compareGroupOrderEntries,
  maxGroupOrderRev,
  parseGroupOrderTriple,
  planGroupReorder,
  planRowReorder,
  presentationOrder,
  shouldAdoptGroupOrder,
  type GroupOrderEntry,
  type GroupOrderMap,
} from '../lib/group-order';
import { isValidOrderKey, materializeKeys } from '../lib/order-key';

/** Deterministic rng (mulberry32) so jittered keys are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  id: string;
  group: string;
  page: number;
  orderKey?: string;
  createdAt?: string;
  serverId?: string;
}

const row = (
  id: string,
  group: string,
  orderKey?: string,
  page = 1,
): Row => ({ id, group, page, orderKey });

const entry = (key: string, rev: number, actor = 'tab-a'): GroupOrderEntry => ({
  key,
  rev,
  actor,
});

/* ── Revisioned entries ───────────────────────────────────────────────── */

describe('group order entries', () => {
  it('orders by rev, then actor — total even at equal rev', () => {
    expect(compareGroupOrderEntries(entry('a0', 1), entry('a1', 2))).toBeLessThan(0);
    expect(compareGroupOrderEntries(entry('a9', 3), entry('a0', 2))).toBeGreaterThan(0);
    const a = entry('a0', 5, 'tab-a');
    const b = entry('a1', 5, 'tab-b');
    expect(compareGroupOrderEntries(a, b)).toBeLessThan(0);
    expect(compareGroupOrderEntries(b, a)).toBeGreaterThan(0);
    expect(compareGroupOrderEntries(a, { ...a })).toBe(0);
  });

  it('fold-back adopts on absence and on strictly newer — never on stale', () => {
    // Absence is ignorance: a restored row must re-teach the map.
    expect(shouldAdoptGroupOrder(undefined, entry('a0', 1))).toBe(true);
    // Newer rev wins; stale rev never replaces (the round-1 killer scenario:
    // an interrupted stamp leaves old-rev rows behind — they must lose).
    expect(shouldAdoptGroupOrder(entry('a0', 2), entry('a9', 1))).toBe(false);
    expect(shouldAdoptGroupOrder(entry('a0', 1), entry('a9', 2))).toBe(true);
    // Equal (rev, actor) — no adoption (idempotent re-observation).
    expect(shouldAdoptGroupOrder(entry('a0', 2, 'x'), entry('a0', 2, 'x'))).toBe(false);
    // Equal rev, different actor: actor codepoint decides, deterministically.
    expect(shouldAdoptGroupOrder(entry('a0', 2, 'a'), entry('a1', 2, 'b'))).toBe(true);
    expect(shouldAdoptGroupOrder(entry('a1', 2, 'b'), entry('a0', 2, 'a'))).toBe(false);
  });

  it('fold-back is order-independent over any row subset', () => {
    // Rows carrying triples from three generations, folded in every order,
    // always converge to the newest.
    const observed = [entry('a0', 1), entry('a5', 3), entry('a2', 2)];
    const fold = (seq: GroupOrderEntry[]): GroupOrderEntry => {
      let cur: GroupOrderEntry | undefined;
      for (const o of seq) {
        if (shouldAdoptGroupOrder(cur, o)) cur = o;
      }
      return cur!;
    };
    const perms = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    for (const p of perms) {
      expect(fold(p.map((i) => observed[i]!))).toEqual(entry('a5', 3));
    }
  });

  it('parses only sound triples', () => {
    expect(parseGroupOrderTriple('a0', 1, 'tab')).toEqual(entry('a0', 1, 'tab'));
    expect(parseGroupOrderTriple('a0!', 1, 'tab')).toBeNull(); // bad key charset
    expect(parseGroupOrderTriple('a0', -1, 'tab')).toBeNull();
    expect(parseGroupOrderTriple('a0', Number.NaN, 'tab')).toBeNull();
    expect(parseGroupOrderTriple('a0', 1, '')).toBeNull();
    expect(parseGroupOrderTriple(undefined, 1, 'tab')).toBeNull();
  });

  it('maxGroupOrderRev seeds from the whole map', () => {
    expect(maxGroupOrderRev({})).toBe(0);
    expect(
      maxGroupOrderRev({ A: entry('a0', 4), B: entry('a1', 9), C: entry('a2', 2) }),
    ).toBe(9);
  });
});

/* ── Band order + presentation projection ─────────────────────────────── */

describe('bandOrder / presentationOrder', () => {
  it('keyless bands keep emergent first-appearance order (today’s behavior)', () => {
    const rows = [
      row('1', 'General'),
      row('2', 'Structural'),
      row('3', 'General'),
    ];
    expect(bandOrder(rows, {})).toEqual(['General', 'Structural']);
    expect(presentationOrder(rows, {}).map((r) => r.id)).toEqual(['1', '3', '2']);
  });

  it('keyed bands sort by key ahead of keyless bands', () => {
    const rows = [
      row('1', 'General'),
      row('2', 'Structural'),
      row('3', 'Electrical'),
    ];
    const entries: GroupOrderMap = {
      Structural: entry('a0', 1),
      General: entry('a1', 1),
    };
    expect(bandOrder(rows, entries)).toEqual(['Structural', 'General', 'Electrical']);
  });

  it('duplicate band keys fall back to name order, deterministically', () => {
    const rows = [row('1', 'B'), row('2', 'A')];
    const entries: GroupOrderMap = { A: entry('a0', 1), B: entry('a0', 2) };
    expect(bandOrder(rows, entries)).toEqual(['A', 'B']);
  });

  it('projects band-contiguous order when flat order interleaves groups', () => {
    // The round-1 critical scenario: flat canonical order interleaves the
    // groups, so the projection must regroup WITHOUT touching row keys.
    const rows = [
      row('g1', 'General', 'a0'),
      row('s1', 'Structural', 'a1'),
      row('g2', 'General', 'a2'),
      row('s2', 'Structural', 'a3'),
    ];
    const entries: GroupOrderMap = {
      Structural: entry('b0', 1),
      General: entry('b1', 1),
    };
    const projected = presentationOrder(rows, entries);
    expect(projected.map((r) => r.id)).toEqual(['s1', 's2', 'g1', 'g2']);
    // Within-band relative (canonical) order preserved; storage untouched.
    expect(rows.map((r) => r.id)).toEqual(['g1', 's1', 'g2', 's2']);
  });

  it('no band keys → projection equals today’s sidebar grouping', () => {
    const rows = [
      row('g1', 'General', 'a0'),
      row('s1', 'Structural', 'a1'),
      row('g2', 'General', 'a2'),
    ];
    expect(presentationOrder(rows, {}).map((r) => r.id)).toEqual(['g1', 'g2', 's1']);
  });
});

/* ── materializeKeys (extracted core) ─────────────────────────────────── */

describe('materializeKeys (document-wide phase-1 core)', () => {
  it('keyless document → ascending keys at current positions', () => {
    const rows = [row('1', 'G'), row('2', 'G'), row('3', 'S')];
    const { keyOf, preserve } = materializeKeys(rows);
    expect(preserve.map((a) => a.id)).toEqual(['1', '2', '3']);
    const keys = rows.map((r) => keyOf.get(r.id)!);
    expect([...keys].sort()).toEqual(keys);
    for (const k of keys) expect(isValidOrderKey(k)).toBe(true);
  });

  it('fully keyed ascending document → no writes', () => {
    const rows = [row('1', 'G', 'a0'), row('2', 'G', 'a1')];
    const { preserve } = materializeKeys(rows);
    expect(preserve).toEqual([]);
  });

  it('broken skeleton (duplicate keys) → full re-key preserving positions', () => {
    const rows = [row('1', 'G', 'a1'), row('2', 'G', 'a1'), row('3', 'S')];
    const { keyOf, preserve } = materializeKeys(rows);
    expect(preserve).toHaveLength(3);
    const keys = rows.map((r) => keyOf.get(r.id)!);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(3);
  });
});

/* ── planRowReorder ───────────────────────────────────────────────────── */

describe('planRowReorder', () => {
  const rng = mulberry32(42);

  it('nulls on missing row, missing/self anchor', () => {
    const rows = [row('1', 'G', 'a0'), row('2', 'G', 'a1')];
    expect(planRowReorder(rows, 'nope', { afterId: '1' }, rng)).toBeNull();
    expect(planRowReorder(rows, '1', { afterId: 'nope' }, rng)).toBeNull();
    expect(planRowReorder(rows, '1', { afterId: '1' }, rng)).toBeNull();
    expect(planRowReorder(rows, '1', {}, rng)).toBeNull();
  });

  it('same-group slot drop in a fully KEYLESS group materializes first', () => {
    // The round-1 claude-F2 named case: between(undefined, undefined) must
    // not key only the moved row (which would front-sort it) — the document
    // materializes at current positions first, then the slot key is real.
    const rows = [row('1', 'G'), row('2', 'G'), row('3', 'G')];
    const plan = planRowReorder(rows, '3', { afterId: '1' }, rng)!;
    expect(plan).not.toBeNull();
    expect(plan.preserve.map((a) => a.id)).toEqual(['1', '2', '3']);
    expect(plan.rows.map((r) => r.id)).toEqual(['1', '3', '2']);
    // The slot key really lands between its neighbors.
    const k1 = plan.rows[0]!.orderKey!;
    const k3 = plan.rows[1]!.orderKey!;
    const k2 = plan.rows[2]!.orderKey!;
    expect(k1 < k3 && k3 < k2).toBe(true);
    expect(plan.newGroup).toBe('G');
    expect(plan.previousGroup).toBe('G');
  });

  it('steady-state keyed slot drop writes exactly one key', () => {
    const rows = [row('1', 'G', 'a0'), row('2', 'G', 'a1'), row('3', 'G', 'a2')];
    const plan = planRowReorder(rows, '3', { beforeId: '2' }, rng)!;
    expect(plan.preserve).toEqual([]);
    expect(plan.rows.map((r) => r.id)).toEqual(['1', '3', '2']);
    expect(plan.movedPreviousKey).toBe('a2');
    expect(plan.movedNewKey > 'a0' && plan.movedNewKey < 'a1').toBe(true);
  });

  it('cross-group slot drop changes group and lands at the slot', () => {
    const rows = [
      row('g1', 'General', 'a0'),
      row('s1', 'Structural', 'a1'),
      row('s2', 'Structural', 'a2'),
    ];
    const plan = planRowReorder(rows, 'g1', { afterId: 's1' }, rng)!;
    expect(plan.rows.map((r) => r.id)).toEqual(['s1', 'g1', 's2']);
    expect(plan.newGroup).toBe('Structural');
    expect(plan.previousGroup).toBe('General');
    const moved = plan.rows[1]!;
    expect(moved.group).toBe('Structural');
    expect(moved.orderKey! > 'a1' && moved.orderKey! < 'a2').toBe(true);
  });

  it('an explicit target.group overrides the anchor group', () => {
    const rows = [row('g1', 'General', 'a0'), row('g2', 'General', 'a1')];
    const plan = planRowReorder(rows, 'g2', { afterId: 'g1', group: 'HVAC' }, rng)!;
    expect(plan.newGroup).toBe('HVAC');
    expect(plan.rows[1]!.group).toBe('HVAC');
  });
});

/* ── planGroupReorder ─────────────────────────────────────────────────── */

describe('planGroupReorder', () => {
  const rng = mulberry32(7);
  const revs = { phase1: 1, phase2: 2 };

  it('nulls on an unknown band', () => {
    expect(planGroupReorder(['A', 'B'], {}, 'C', 0, revs, 'tab', rng)).toBeNull();
  });

  it('first drag materializes ALL bands at current positions, moved last', () => {
    const bands = ['General', 'Structural', 'Electrical'];
    const plan = planGroupReorder(bands, {}, 'Electrical', 0, revs, 'tab', rng)!;
    // Phase 1 covers every band, in current order, at the shared rev.
    expect(plan.phase1.map((p) => p.group)).toEqual(bands);
    for (const p of plan.phase1) expect(p.entry.rev).toBe(1);
    const p1keys = plan.phase1.map((p) => p.entry.key);
    expect([...p1keys].sort()).toEqual(p1keys); // current positions preserved
    // movedPreviousEntry is the POST-phase-1 entry (undo restores a real key).
    expect(plan.movedPreviousEntry).toEqual(plan.phase1[2]!.entry);
    // Phase 2: moved band lands first, fresh rev, applied last.
    expect(plan.phase2.group).toBe('Electrical');
    expect(plan.phase2.entry.rev).toBe(2);
    expect(plan.phase2.entry.key < plan.entries['General']!.key).toBe(true);
    // Final map yields the requested band order.
    const finalOrder = ['Electrical', 'General', 'Structural'];
    const sorted = Object.entries(plan.entries)
      .sort((a, b) => (a[1].key < b[1].key ? -1 : 1))
      .map(([g]) => g);
    expect(sorted).toEqual(finalOrder);
  });

  it('steady state (valid skeleton) writes only the moved band', () => {
    const entries: GroupOrderMap = {
      A: entry('a0', 1),
      B: entry('a1', 1),
      C: entry('a2', 1),
    };
    const plan = planGroupReorder(['A', 'B', 'C'], entries, 'A', 2, revs, 'tab', rng)!;
    expect(plan.phase1).toEqual([]);
    expect(plan.movedPreviousEntry).toEqual(entry('a0', 1));
    expect(plan.phase2.entry.key > 'a2').toBe(true);
    const sorted = Object.entries(plan.entries)
      .sort((a, b) => (a[1].key < b[1].key ? -1 : 1))
      .map(([g]) => g);
    expect(sorted).toEqual(['B', 'C', 'A']);
  });

  it('a broken skeleton (duplicate band keys) re-keys all bands', () => {
    const entries: GroupOrderMap = { A: entry('a0', 1), B: entry('a0', 1) };
    const plan = planGroupReorder(['A', 'B'], entries, 'B', 0, revs, 'tab', rng)!;
    expect(plan.phase1.map((p) => p.group)).toEqual(['A', 'B']);
    const sorted = Object.entries(plan.entries)
      .sort((a, b) => (a[1].key < b[1].key ? -1 : 1))
      .map(([g]) => g);
    expect(sorted).toEqual(['B', 'A']);
  });

  it('phase-1 interruption at any prefix preserves the pre-move band order', () => {
    // Stamp only a PREFIX of phase-1 entries onto an empty map: band order
    // (keyed-then-keyless with emergent fallback) must equal the original.
    const bands = ['General', 'Structural', 'Electrical', 'HVAC'];
    const rows = bands.map((g, i) => row(String(i), g));
    const plan = planGroupReorder(bands, {}, 'HVAC', 0, revs, 'tab', rng)!;
    for (let cut = 0; cut <= plan.phase1.length; cut++) {
      const partial: GroupOrderMap = {};
      for (const { group, entry: e } of plan.phase1.slice(0, cut)) {
        partial[group] = e;
      }
      expect(bandOrder(rows, partial)).toEqual(bands);
    }
  });
});
