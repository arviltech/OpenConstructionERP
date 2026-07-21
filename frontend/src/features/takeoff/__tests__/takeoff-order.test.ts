// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Persisted measurement order: fractional key generation, the canonical
 * comparator, and the group-move planner (lib/order-key.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyBetween,
  generateNKeysBetween,
  generateJitteredKeyBetween,
  isValidOrderKey,
  validateOrderKey,
  compareMeasurements,
  sortCanonical,
  insertCanonical,
  planGroupMove,
  isGroupOnly,
  type PlannableRow,
  type GroupMovePlan,
} from '../lib/order-key';

/** Deterministic RNG (mulberry32) so jitter-dependent tests are stable. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Fraction part of a key (integer length is encoded by the head char). */
function fractionOf(key: string): string {
  const head = key[0]!;
  const len =
    head >= 'a' && head <= 'z'
      ? head.charCodeAt(0) - 97 + 2
      : 90 - head.charCodeAt(0) + 2;
  return key.slice(len);
}

describe('generateKeyBetween', () => {
  it('produces strictly ordered valid keys for every bound combination', () => {
    const first = generateKeyBetween(null, null);
    expect(first).toBe('a0');
    const after = generateKeyBetween(first, null);
    const before = generateKeyBetween(null, first);
    const between = generateKeyBetween(before, first);
    expect(before < first && first < after).toBe(true);
    expect(before < between && between < first).toBe(true);
    for (const k of [first, after, before, between]) {
      expect(isValidOrderKey(k)).toBe(true);
    }
  });

  it('rejects inverted or equal bounds', () => {
    expect(() => generateKeyBetween('a1', 'a1')).toThrow();
    expect(() => generateKeyBetween('a2', 'a1')).toThrow();
  });

  it('rejects keys with non-base-36 characters (corrupt persisted data)', () => {
    // The sanitizer must reject foreign chars, not just bad heads/lengths:
    // a '!' codepoint-compares fine but breaks the digit arithmetic that
    // midpoint/increment assume.
    // Uppercase is only ever a HEAD char (integer-length code), never a
    // digit — 'a0V' must fail even though 'V' looks plausible.
    for (const bad of ['a!', 'a1!', 'a§', 'a 1', 'aB', 'b1!2', 'a0V']) {
      expect(isValidOrderKey(bad)).toBe(false);
      expect(() => generateKeyBetween(bad, null)).toThrow();
    }
    for (const good of ['a0', 'a1', 'b12', 'Z9', 'a0v']) {
      expect(isValidOrderKey(good)).toBe(true);
    }
  });

  it('never mints a fraction ending in the zero digit (no-trailing-zero invariant)', () => {
    // 50 successive insertions into the same gap: the pathological
    // key-lengthening case. Every minted fraction must stay zero-free at its
    // tail or later midpoints throw.
    let lo = generateKeyBetween(null, null);
    const hi = generateKeyBetween(lo, null);
    const minted: string[] = [];
    for (let i = 0; i < 50; i++) {
      lo = generateKeyBetween(lo, hi);
      minted.push(lo);
    }
    for (const k of minted) {
      expect(isValidOrderKey(k)).toBe(true);
      const f = fractionOf(k);
      if (f.length > 0) expect(f.slice(-1)).not.toBe(DIGITS[0]);
    }
    const sorted = [...minted].sort();
    expect(sorted).toEqual(minted);
    expect(new Set(minted).size).toBe(minted.length);
  });

  it('randomized insertions stay sorted and unique', () => {
    const rng = seededRng(42);
    const keys = [generateKeyBetween(null, null)];
    for (let i = 0; i < 400; i++) {
      const slot = Math.floor(rng() * (keys.length + 1));
      const lo = slot > 0 ? keys[slot - 1]! : null;
      const hi = slot < keys.length ? keys[slot]! : null;
      keys.splice(slot, 0, generateKeyBetween(lo, hi));
    }
    const sorted = [...keys].sort();
    expect(sorted).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(() => validateOrderKey(k)).not.toThrow();
  });
});

describe('generateNKeysBetween', () => {
  it('returns n distinct ascending keys inside the bounds', () => {
    const lo = 'a1';
    const hi = 'a2';
    const keys = generateNKeysBetween(lo, hi, 25);
    expect(keys).toHaveLength(25);
    let prev = lo;
    for (const k of keys) {
      expect(prev < k).toBe(true);
      expect(k < hi).toBe(true);
      expect(isValidOrderKey(k)).toBe(true);
      prev = k;
    }
  });

  it('handles open bounds on either side', () => {
    for (const [lo, hi] of [
      [null, 'a1'],
      ['a1', null],
      [null, null],
    ] as const) {
      const keys = generateNKeysBetween(lo, hi, 10);
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(10);
      if (lo) expect(lo < keys[0]!).toBe(true);
      if (hi) expect(keys[keys.length - 1]! < hi).toBe(true);
    }
  });
});

describe('generateJitteredKeyBetween', () => {
  it('two clients minting into the same gap get distinct keys', () => {
    const a = generateJitteredKeyBetween('a1', 'a2', seededRng(1));
    const b = generateJitteredKeyBetween('a1', 'a2', seededRng(2));
    expect(a).not.toBe(b);
    for (const k of [a, b]) {
      expect('a1' < k && k < 'a2').toBe(true);
      expect(isValidOrderKey(k)).toBe(true);
    }
  });

  it('regenerates when the base key is a prefix of the upper bound', () => {
    // generateKeyBetween(null, 'a11') returns 'a1', a prefix of the bound —
    // appending jitter digits to a prefix could overshoot 'a11'. The jittered
    // variant must detect this and mint inside the gap instead.
    const k = generateJitteredKeyBetween(null, 'a11', seededRng(7));
    expect(k < 'a11').toBe(true);
    expect(isValidOrderKey(k)).toBe(true);
  });

  it('the jitter suffix never reintroduces a trailing zero', () => {
    const rng = seededRng(1234);
    for (let i = 0; i < 200; i++) {
      const k = generateJitteredKeyBetween('a1', 'a2', rng);
      const f = fractionOf(k);
      expect(f.slice(-1)).not.toBe(DIGITS[0]);
    }
  });
});

describe('compareMeasurements', () => {
  it('keyed rows sort by key before every keyless row', () => {
    const rows = [
      { id: 'late', createdAt: '2026-07-01T00:00:00Z' },
      { id: 'keyed-b', orderKey: 'a2', createdAt: '2026-07-05T00:00:00Z' },
      { id: 'early', createdAt: '2026-06-01T00:00:00Z' },
      { id: 'keyed-a', orderKey: 'a1', createdAt: '2026-07-09T00:00:00Z' },
    ];
    expect(sortCanonical(rows).map((r) => r.id)).toEqual([
      'keyed-a',
      'keyed-b',
      'early',
      'late',
    ]);
  });

  it('a fully keyless document sorts exactly as the pre-key hydrate order', () => {
    const rows = [
      { id: 'm3', serverId: 'srv-3', createdAt: '2026-07-01T10:02:00Z' },
      { id: 'm1', serverId: 'srv-1', createdAt: '2026-07-01T10:00:00Z' },
      { id: 'm2', serverId: 'srv-2', createdAt: '2026-07-01T10:01:00Z' },
    ];
    expect(sortCanonical(rows).map((r) => r.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('duplicate keys and missing createdAt degrade to a deterministic tie-break', () => {
    const rows = [
      { id: 'b', orderKey: 'a1' },
      { id: 'a', orderKey: 'a1' },
      { id: 'd' },
      { id: 'c' },
    ];
    // Same key → serverId/id tie-break; keyless with no createdAt → id order.
    expect(sortCanonical(rows).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    // Total: comparator is antisymmetric on the duplicate pair.
    expect(compareMeasurements(rows[0]!, rows[1]!)).toBe(
      -compareMeasurements(rows[1]!, rows[0]!),
    );
  });

  it('keying any prefix of the creation order at current positions preserves the visible order', () => {
    // The phase-1 interruption invariant: persisting the first k
    // materialization writes (keys assigned at OLD positions, in order) must
    // leave the canonical sort identical to the original order for EVERY k.
    const base = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      createdAt: `2026-07-01T10:0${i}:00Z`,
    }));
    const keys = generateNKeysBetween(null, null, base.length);
    for (let k = 0; k <= base.length; k++) {
      const rows = base.map((r, i) =>
        i < k ? { ...r, orderKey: keys[i]! } : { ...r },
      );
      const shuffled = [...rows].reverse();
      expect(sortCanonical(shuffled).map((r) => r.id)).toEqual(
        base.map((r) => r.id),
      );
    }
  });

  it('insertCanonical places a keyed row at its slot and a keyless row by creation order', () => {
    const rows = [
      { id: 'k1', orderKey: 'a1' },
      { id: 'k3', orderKey: 'a3' },
      { id: 'u1', createdAt: '2026-07-01T10:00:00Z' },
      { id: 'u3', createdAt: '2026-07-01T10:02:00Z' },
    ];
    expect(
      insertCanonical(rows, { id: 'k2', orderKey: 'a2' }).map((r) => r.id),
    ).toEqual(['k1', 'k2', 'k3', 'u1', 'u3']);
    expect(
      insertCanonical(rows, {
        id: 'u2',
        createdAt: '2026-07-01T10:01:00Z',
      }).map((r) => r.id),
    ).toEqual(['k1', 'k3', 'u1', 'u2', 'u3']);
  });
});

/* ── Group-move planner ─────────────────────────────────────────────────── */

let stamp = 0;
function row(
  id: string,
  group: string,
  page = 1,
  orderKey?: string,
): PlannableRow {
  stamp += 1;
  return {
    id,
    group,
    page,
    orderKey,
    createdAt: `2026-07-01T10:${String(stamp).padStart(2, '0')}:00Z`,
  };
}

function assertPlanConsistent(plan: GroupMovePlan<PlannableRow>): void {
  // Every assigned key is well-formed and the final array is strictly
  // key-ascending (the array order IS the canonical order).
  for (const a of [...plan.preserve, ...plan.move]) {
    expect(isValidOrderKey(a.orderKey)).toBe(true);
  }
  const keys = plan.rows.map((r) => r.orderKey);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1] !== undefined && keys[i] !== undefined) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  }
  expect(sortCanonical(plan.rows).map((r) => r.id)).toEqual(
    plan.rows.map((r) => r.id),
  );
}

describe('planGroupMove', () => {
  it('returns null for an unknown row or a same-group move', () => {
    const rows = [row('a1', 'A'), row('b1', 'B')];
    expect(planGroupMove(rows, 'nope', 'A', seededRng(1))).toBeNull();
    expect(planGroupMove(rows, 'a1', 'A', seededRng(1))).toBeNull();
  });

  it('is group-only when the target group has no member on the moved row page', () => {
    const rows = [row('x1', 'X', 1), row('a2', 'A', 2)];
    const plan = planGroupMove(rows, 'x1', 'A', seededRng(1));
    expect(plan).not.toBeNull();
    expect(isGroupOnly(plan)).toBe(true);
  });

  it('materializes keys at old positions (phase 1) then places the moved row after the anchor', () => {
    // Keyless doc: a1(A), b1(B), a2(A). Move b1 → A.
    const rows = [row('a1', 'A'), row('b1', 'B'), row('a2', 'A')];
    const plan = planGroupMove(rows, 'b1', 'A', seededRng(3));
    expect(plan && !isGroupOnly(plan)).toBe(true);
    const p = plan as GroupMovePlan<PlannableRow>;

    // Phase 1 keys ALL keyless rows at their OLD positions, in array order.
    expect(p.preserve.map((a) => a.id)).toEqual(['a1', 'b1', 'a2']);
    const [ka1, kb1, ka2] = p.preserve.map((a) => a.orderKey);
    expect(ka1! < kb1! && kb1! < ka2!).toBe(true);

    // The undo key is the moved row's post-phase-1 (old position) key.
    expect(p.movedPreviousKey).toBe(kb1);

    // Final order: b1 lands after the target group's last member.
    expect(p.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'b1']);
    expect(p.rows[2]!.group).toBe('A');

    // Phase 2 is the moved row alone, LAST, with its new key.
    expect(p.move.map((a) => a.id)).toEqual(['b1']);
    expect(p.move[0]!.orderKey).toBe(p.movedNewKey);
    expect(p.movedNewKey > ka2!).toBe(true);
    assertPlanConsistent(p);
  });

  it('steady state (all rows keyed, target contiguous) needs no preserve writes', () => {
    const rows = [
      row('a1', 'A', 1, 'a1'),
      row('a2', 'A', 1, 'a2'),
      row('b1', 'B', 1, 'a3'),
    ];
    const plan = planGroupMove(rows, 'b1', 'A', seededRng(4));
    const p = plan as GroupMovePlan<PlannableRow>;
    expect(isGroupOnly(plan)).toBe(false);
    expect(p.preserve).toEqual([]);
    expect(p.move.map((a) => a.id)).toEqual(['b1']);
    expect(p.movedPreviousKey).toBe('a3');
    expect(p.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'b1']);
    assertPlanConsistent(p);
  });

  it('anchors on the moved row page, leaving other pages untouched', () => {
    // Target group's LAST member document-wide is on page 2; the anchor must
    // be the page-1 member so page 2 is not disturbed.
    const rows = [
      row('a1', 'A', 1),
      row('x1', 'X', 1),
      row('a2', 'A', 2),
    ];
    const plan = planGroupMove(rows, 'x1', 'A', seededRng(5));
    const p = plan as GroupMovePlan<PlannableRow>;
    expect(p.rows.map((r) => r.id)).toEqual(['a1', 'x1', 'a2']);
    // Page 2 row gets a phase-1 (order-preserving) key at most — never an
    // order-changing write.
    expect(p.move.map((a) => a.id)).toEqual(['x1']);
    assertPlanConsistent(p);
  });

  it('coalesces split target-group runs so the group is contiguous after the move', () => {
    // a1(A), x1(X), a2(A) — the A run is split by x1. Moving b1 → A pulls the
    // straggler a1 down to the run, then appends b1: x1, a1, a2, b1.
    const rows = [
      row('a1', 'A'),
      row('x1', 'X'),
      row('a2', 'A'),
      row('b1', 'B'),
    ];
    const plan = planGroupMove(rows, 'b1', 'A', seededRng(6));
    const p = plan as GroupMovePlan<PlannableRow>;
    expect(p.rows.map((r) => r.id)).toEqual(['x1', 'a1', 'a2', 'b1']);
    // Phase 2: straggler first (document order), moved row LAST.
    expect(p.move.map((a) => a.id)).toEqual(['a1', 'b1']);
    assertPlanConsistent(p);
  });

  it('falls back to a full re-key when the keyed skeleton has duplicates', () => {
    // Concurrent-move residue: two rows share a key. Gap-filling would need
    // a key strictly between equal bounds, so the planner re-keys every row
    // in place instead of throwing.
    const rows = [
      row('a1', 'A', 1, 'a1'),
      row('a2', 'A', 1, 'a1'),
      row('b1', 'B', 1, 'a2'),
    ];
    const plan = planGroupMove(rows, 'b1', 'A', seededRng(8));
    const p = plan as GroupMovePlan<PlannableRow>;
    expect(p.preserve.map((a) => a.id)).toEqual(['a1', 'a2', 'b1']);
    const ks = p.preserve.map((a) => a.orderKey);
    expect(ks[0]! < ks[1]! && ks[1]! < ks[2]!).toBe(true);
    expect(p.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'b1']);
    assertPlanConsistent(p);
  });
});
