// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
import { describe, it, expect } from 'vitest';
import {
  sortByPaintOrder,
  orderKeyForEdge,
  orderKeyBetween,
  orderKeyForDrop,
  groupBands,
  groupOf,
  reorderGroups,
  freezeGroupBands,
  hydrateGroupBands,
  stampGroupBands,
  groupBandCommit,
  isRenormalisedDrop,
} from '../lib/takeoff-order';
import type { RenormalisedDrop } from '../lib/takeoff-order';

/** Minimal orderable rows for the projection tests. */
const row = (id: string, order?: number) => ({ id, order });

describe('sortByPaintOrder (issue #379)', () => {
  it('returns rows with no explicit order in their original array order', () => {
    const rows = [row('a'), row('b'), row('c')];
    expect(sortByPaintOrder(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by explicit order ascending (higher paints later / on top)', () => {
    const rows = [row('a', 3), row('b', 1), row('c', 2)];
    expect(sortByPaintOrder(rows).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('mixes explicit keys with the array-index fallback deterministically', () => {
    // 'x' brought to front (order huge) tops the un-ordered rows; 'y' sent to
    // back (negative) drops below them; the rest keep array order.
    const rows = [row('p'), row('x', 99), row('q'), row('y', -1)];
    expect(sortByPaintOrder(rows).map((r) => r.id)).toEqual(['y', 'p', 'q', 'x']);
  });

  it('does not mutate the input array', () => {
    const rows = [row('a', 2), row('b', 1)];
    const snapshot = rows.map((r) => r.id);
    sortByPaintOrder(rows);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });
});

describe('orderKeyForEdge (issue #379)', () => {
  it('front returns a key strictly above every effective order', () => {
    const rows = [row('a'), row('b'), row('c')]; // effective 0,1,2
    const key = orderKeyForEdge(rows, 'front')!;
    // Placing the moved row at this key sorts it last (on top).
    const moved = sortByPaintOrder([...rows, row('z', key)]);
    expect(moved[moved.length - 1]!.id).toBe('z');
  });

  it('back returns a key strictly below every effective order', () => {
    const rows = [row('a', 5), row('b', 6)];
    const key = orderKeyForEdge(rows, 'back')!;
    const moved = sortByPaintOrder([row('z', key), ...rows]);
    expect(moved[0]!.id).toBe('z');
  });

  it('returns null for an empty subset', () => {
    expect(orderKeyForEdge([], 'front')).toBeNull();
    expect(orderKeyForEdge([], 'back')).toBeNull();
  });

  it('front stays above a previously front-most row (repeated bring-to-front)', () => {
    let rows = [row('a'), row('b')];
    const kA = orderKeyForEdge(rows, 'front')!;
    rows = [row('a', kA), row('b')];
    const kB = orderKeyForEdge(rows, 'front')!;
    expect(kB).toBeGreaterThan(kA);
  });
});

describe('orderKeyBetween (issue #379 drag reorder)', () => {
  it('takes the midpoint of two real bounds', () => {
    expect(orderKeyBetween(2, 4)).toBe(3);
    expect(orderKeyBetween(0, 1)).toBe(0.5);
  });

  it('steps one unit past an open edge', () => {
    expect(orderKeyBetween(null, 3)).toBe(2); // dropped at the very front
    expect(orderKeyBetween(3, null)).toBe(4); // dropped at the very back
  });

  it('returns 0 for an empty stack', () => {
    expect(orderKeyBetween(null, null)).toBe(0);
  });
});

describe('orderKeyForDrop (issue #379 drag reorder)', () => {
  it('drops a row before the target, landing it directly beneath in paint order', () => {
    // effective keys: a=0, b=1, c=2, d=3. Drag d before b.
    const rows = [row('a'), row('b'), row('c'), row('d')];
    const key = orderKeyForDrop(rows, 'd', 'b', 'before');
    expect(key).not.toBeNull();
    // These fixtures have room between every pair of keys, so the drop is always
    // a plain key and never the whole-group renumbering.
    const sorted = sortByPaintOrder(
      rows.map((r) => (r.id === 'd' ? { ...r, order: key as number } : r)),
    ).map((r) => r.id);
    expect(sorted).toEqual(['a', 'd', 'b', 'c']);
  });

  it('drops a row after the target', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')];
    const key = orderKeyForDrop(rows, 'a', 'c', 'after');
    const sorted = sortByPaintOrder(
      rows.map((r) => (r.id === 'a' ? { ...r, order: key as number } : r)),
    ).map((r) => r.id);
    expect(sorted).toEqual(['b', 'c', 'a', 'd']);
  });

  it('excludes the dragged row when picking neighbours (drop to the very front)', () => {
    const rows = [row('a'), row('b'), row('c')];
    const key = orderKeyForDrop(rows, 'a', 'c', 'after');
    const sorted = sortByPaintOrder(
      rows.map((r) => (r.id === 'a' ? { ...r, order: key as number } : r)),
    ).map((r) => r.id);
    expect(sorted).toEqual(['b', 'c', 'a']);
  });

  it('returns null for a missing target or a self-drop', () => {
    const rows = [row('a'), row('b')];
    expect(orderKeyForDrop(rows, 'a', 'a', 'before')).toBeNull();
    expect(orderKeyForDrop(rows, 'a', 'zzz', 'before')).toBeNull();
  });

  /**
   * "After row N" and "before row N+1" name the same gap in the list, so the
   * two gestures a user can aim at that gap must produce the same key. This is
   * what makes issue #392's midpoint split safe: once the drop handler picks
   * 'before' or 'after' from which half of the row the pointer is in, the seam
   * between two adjacent rows is approached from both sides, and a user who
   * aims just below one row must not get a different result from one who aims
   * just above the next.
   */
  it('addresses the same gap whether reached as after-N or before-N+1', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')];
    expect(orderKeyForDrop(rows, 'a', 'b', 'after')).toBe(
      orderKeyForDrop(rows, 'a', 'c', 'before'),
    );
    expect(orderKeyForDrop(rows, 'd', 'b', 'after')).toBe(
      orderKeyForDrop(rows, 'd', 'c', 'before'),
    );
  });

  /**
   * The slot after the LAST row is the one issue #392 reports as unreachable:
   * every drop is computed as insert-before, so no pointer position produces
   * it. The helper can already express it - this pins that the 'after' branch
   * on the last row is what the drop handler has to call to reach it.
   */
  it('reaches the slot after the last row', () => {
    const rows = [row('a'), row('b'), row('c')];
    const key = orderKeyForDrop(rows, 'a', 'c', 'after');
    const sorted = sortByPaintOrder(
      rows.map((r) => (r.id === 'a' ? { ...r, order: key as number } : r)),
    ).map((r) => r.id);
    expect(sorted).toEqual(['b', 'c', 'a']);
  });
});

/* ── Group bands (issues #394 / #400) ─────────────────────────────── */

/** Orderable row carrying a group, for the banding tests. */
const grouped = (id: string, group: string, order?: number) => ({ id, group, order });

describe('groupOf (issue #394)', () => {
  it('normalises a missing or empty group to General', () => {
    // Every surface that groups measurements has to agree on what a group is.
    // A raw `m.group === other.group` comparison files an empty string apart
    // from the General bucket it renders in, which scopes an operation to the
    // wrong set - the same class of defect as a `??` fallback in place of `||`.
    expect(groupOf({})).toBe('General');
    expect(groupOf({ group: '' })).toBe('General');
    expect(groupOf({ group: 'Walls' })).toBe('Walls');
  });
});

describe('groupBands (issue #394)', () => {
  it('bands groups by first appearance, so a measurement reorder cannot move a group', () => {
    const rows = [
      grouped('w1', 'Walls'),
      grouped('w2', 'Walls'),
      grouped('s1', 'Slab'),
      grouped('s2', 'Slab'),
    ];
    expect(groupBands(rows)).toEqual({ Walls: 0, Slab: 1 });
    // The reported repro: send the last Slab row to the back. Its paint key
    // changes, but creation order is not something a reorder can touch, so the
    // bands are identical and the Slab block stays below Walls.
    const restacked = rows.map((r) => (r.id === 's2' ? { ...r, order: -1 } : r));
    expect(groupBands(restacked)).toEqual({ Walls: 0, Slab: 1 });
  });

  it('files a row with no group, or an empty group, under General', () => {
    // The sidebar and the exporters bucket with `m.group || 'General'`, so an
    // empty string must band where it is displayed rather than as its own
    // group - a `??` fallback would split the two apart.
    expect(groupBands([{ order: 0 }, { group: '', order: 1 }])).toEqual({ General: 0 });
  });

  it('prefers an explicit band and files the rest after the highest one', () => {
    const rows = [grouped('a', 'Alpha'), grouped('b', 'Bravo'), grouped('c', 'Charlie')];
    // Bravo was positioned deliberately; the other two must not displace it.
    expect(groupBands(rows, { Bravo: 0 })).toEqual({ Bravo: 0, Alpha: 1, Charlie: 2 });
  });

  it('keeps a fully explicit map untouched', () => {
    const rows = [grouped('a', 'Alpha'), grouped('b', 'Bravo')];
    expect(groupBands(rows, { Alpha: 5, Bravo: 2 })).toEqual({ Alpha: 5, Bravo: 2 });
  });
});

describe('sortByPaintOrder group bands (issue #394)', () => {
  it('leaves every existing caller unchanged when no band map is passed', () => {
    // The band parameter is additive: with no map every row lands in band 0 and
    // the comparator falls through to the key / index tie-breaks it always had.
    const rows = [grouped('a', 'Walls', 3), grouped('b', 'Slab', 1), grouped('c', 'Walls', 2)];
    expect(sortByPaintOrder(rows).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('paints each group as one contiguous block, ordered by band', () => {
    const rows = [
      grouped('w1', 'Walls'),
      grouped('w2', 'Walls'),
      grouped('s1', 'Slab'),
      // Sent to the back. Unbanded this drags the whole Slab block above Walls,
      // which is the defect; banded it may only move within its own group.
      grouped('s2', 'Slab', -1),
    ];
    const bands = groupBands(rows);
    expect(sortByPaintOrder(rows, bands).map((r) => r.id)).toEqual(['w1', 'w2', 's2', 's1']);
  });

  it('orders blocks by band even when a group name looks like an integer', () => {
    // Group blocks used to be enumerated off a plain object, where integer-like
    // keys sort ahead of every named key regardless of insertion order. Bands
    // are numbers compared numerically, so a group named "2" stays where the
    // document put it.
    const rows = [grouped('a', '2'), grouped('b', 'Walls'), grouped('c', '1')];
    const bands = groupBands(rows);
    expect(bands).toEqual({ '2': 0, Walls: 1, '1': 2 });
    expect(sortByPaintOrder(rows, bands).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('reorderGroups (issue #400)', () => {
  it('moves a group up, renumbering every group in one pass', () => {
    const groups = ['Walls', 'Slab', 'Roof'];
    expect(reorderGroups(groups, 'Roof', 'Walls', 'before')).toEqual({
      Roof: 0,
      Walls: 1,
      Slab: 2,
    });
  });

  it('drops the dragged group out before resolving the target index', () => {
    // Dragging downward is where splicing into the ORIGINAL list silently
    // no-ops: with Walls still present, index 1 is Slab's own slot and the
    // group lands back where it started. Removing it first makes the move real.
    const groups = ['Walls', 'Slab', 'Roof'];
    expect(reorderGroups(groups, 'Walls', 'Slab', 'after')).toEqual({
      Slab: 0,
      Walls: 1,
      Roof: 2,
    });
  });

  it('reaches the slot after the last group', () => {
    // Same defect as issue #392 for measurement rows: hardcoding 'before' makes
    // the slot past the final group unaddressable.
    const groups = ['Walls', 'Slab', 'Roof'];
    expect(reorderGroups(groups, 'Walls', 'Roof', 'after')).toEqual({
      Slab: 0,
      Roof: 1,
      Walls: 2,
    });
  });

  it('bands sequentially from zero so groupBands cannot re-derive above the result', () => {
    // The band map this returns is fed straight back into groupBands as the
    // explicit map. Sequential bands over every displayed group are what stop
    // an untouched group being re-derived above the one the user just moved.
    const groups = ['A', 'B', 'C'];
    const bands = reorderGroups(groups, 'C', 'B', 'before')!;
    expect(bands).toEqual({ A: 0, C: 1, B: 2 });
    const rows = [grouped('a', 'A'), grouped('b', 'B'), grouped('c', 'C')];
    expect(groupBands(rows, bands)).toEqual(bands);
  });

  it('returns null for a no-op drop so a document-wide write is skipped', () => {
    // Every measurement carries the band, so a write costs one PATCH per row.
    // A drop that changes nothing must not pay that.
    const groups = ['Walls', 'Slab', 'Roof'];
    expect(reorderGroups(groups, 'Walls', 'Walls', 'before')).toBeNull();
    expect(reorderGroups(groups, 'Walls', 'Slab', 'before')).toBeNull();
    expect(reorderGroups(groups, 'Slab', 'Walls', 'after')).toBeNull();
    expect(reorderGroups(groups, 'Walls', 'Nope', 'before')).toBeNull();
    expect(reorderGroups(groups, 'Nope', 'Walls', 'before')).toBeNull();
  });
});

/**
 * The banded projection is what keeps a measurement-level reorder inside its
 * own group (issue #394). These exercise the two helpers as the viewer now
 * calls them, `sortByPaintOrder(all, groupBands(all))`, because that pairing is
 * the contract: either one alone still lets a drop cross a group boundary.
 */
describe('banded projection keeps a reorder inside its group (issue #394)', () => {
  /** Row with a group, matching how the viewer shapes its measurements. */
  const gRow = (id: string, group: string, order?: number) => ({ id, group, order });

  /** Project the way TakeoffViewerModule does, in one place. */
  const project = <T extends { group?: string; order?: number }>(rows: T[]) =>
    sortByPaintOrder(rows, groupBands(rows));

  it('keeps every group contiguous once one of its rows is restacked', () => {
    const rows = [gRow('a1', 'A'), gRow('a2', 'A'), gRow('b1', 'B'), gRow('b2', 'B')];
    // Send a1 to the very back of the flat stack, the strongest possible pull
    // away from its group.
    rows[0]!.order = -100;
    const ids = project(rows).map((r) => r.id);
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2']);
    // Stated separately so a failure says which half broke: the group blocks
    // are still whole, and B did not move.
    expect(ids.slice(0, 2).every((id) => id.startsWith('a'))).toBe(true);
    expect(ids.slice(2)).toEqual(['b1', 'b2']);
  });

  it('cannot pull a row into another group by giving it a huge key', () => {
    const rows = [gRow('a1', 'A', 999), gRow('a2', 'A'), gRow('b1', 'B'), gRow('b2', 'B')];
    // Unbanded this puts a1 last, on top of group B. Banded it can only reach
    // the top of its own group.
    expect(project(rows).map((r) => r.id)).toEqual(['a2', 'a1', 'b1', 'b2']);
    expect(sortByPaintOrder(rows).map((r) => r.id)).toEqual(['a2', 'b1', 'b2', 'a1']);
  });

  it('bands a group by first appearance, not by its members paint keys', () => {
    // B's rows all carry keys below A's, which without banding would put the
    // whole B block first. A appears first in the array, so A bands first.
    const rows = [gRow('a1', 'A', 50), gRow('b1', 'B', 1), gRow('b2', 'B', 2)];
    expect(project(rows).map((r) => r.id)).toEqual(['a1', 'b1', 'b2']);
  });

  it('bands an empty-string group with General rather than beside it', () => {
    // `groupOf` normalises both to General; a raw group comparison would band
    // them separately and split one rendered bucket across two blocks.
    const rows = [gRow('x', ''), gRow('g', 'General'), gRow('b', 'B')];
    const bands = groupBands(rows);
    expect(bands[groupOf(rows[0]!)]).toBe(bands[groupOf(rows[1]!)]);
    expect(project(rows).map((r) => r.id)).toEqual(['x', 'g', 'b']);
  });

  it('collapses to the flat projection when every row shares one group', () => {
    // The single-group document is the common case and must be untouched.
    const rows = [gRow('a', 'A', 3), gRow('b', 'A', 1), gRow('c', 'A', 2)];
    expect(project(rows).map((r) => r.id)).toEqual(
      sortByPaintOrder(rows).map((r) => r.id),
    );
  });
});

/**
 * A drop onto a row of another group has to land where it was dropped (issue
 * #393). The key competes only inside the target's band, so these pin that the
 * neighbours are scoped to the target's group rather than to the flat list.
 */
describe('orderKeyForDrop scopes the key to the target group (issue #393)', () => {
  const gRow = (id: string, group: string, order?: number) => ({ id, group, order });

  /** The rows and pinned bands a drop produces, the way the viewer writes them.
   *  A drop that ran out of fractional space returns a whole-group renumbering
   *  instead of one key, and the viewer writes every row it names. */
  const dropRows = (
    rows: { id: string; group: string; order?: number }[],
    draggedId: string,
    targetId: string,
    place: 'before' | 'after',
  ) => {
    const drop = orderKeyForDrop(rows, draggedId, targetId, place);
    if (drop === null) return null;
    let key: number;
    let renumbered: Record<string, number> | null = null;
    if (isRenormalisedDrop(drop)) {
      renumbered = drop.orders;
      key = drop.orders[draggedId]!;
    } else {
      key = drop;
    }
    const targetGroup = groupOf(rows.find((r) => r.id === targetId)!);
    const regroups = groupOf(rows.find((r) => r.id === draggedId)!) !== targetGroup;
    // Freeze BEFORE the move, exactly where the viewer freezes.
    const pinned = regroups ? freezeGroupBands(rows) : {};
    const next = rows.map((r) => {
      if (r.id === draggedId) return { ...r, order: key, group: targetGroup };
      const renumberedOrder = renumbered?.[r.id];
      return renumberedOrder === undefined ? r : { ...r, order: renumberedOrder };
    });
    return { next, pinned, renumbered };
  };

  /** Apply a computed drop and read back the on-screen order, the way the
   *  viewer does: write the key, write the group, then project. */
  const applyDrop = (
    rows: { id: string; group: string; order?: number }[],
    draggedId: string,
    targetId: string,
    place: 'before' | 'after',
  ) => {
    const applied = dropRows(rows, draggedId, targetId, place);
    if (applied === null) return null;
    return sortByPaintOrder(applied.next, groupBands(applied.next, applied.pinned)).map(
      (r) => r.id,
    );
  };

  it('lands a cross-group drop next to the row it was dropped on', () => {
    const rows = [gRow('a1', 'A'), gRow('a2', 'A'), gRow('b1', 'B'), gRow('b2', 'B')];
    // Dropped before b2, so it must sit between b1 and b2 and nowhere else.
    // Group A stays banded first even though the member it was banded from has
    // just left it, which is what the pre-move freeze buys.
    expect(applyDrop(rows, 'a1', 'b2', 'before')).toEqual(['a2', 'b1', 'a1', 'b2']);
  });

  it('ignores the dragged row own group keys when picking neighbours', () => {
    // a1 carries a key far above everything in B. Scoped to B it still lands
    // between b1 and b2; against the flat list it would be pinned to the end.
    const rows = [gRow('a1', 'A', 500), gRow('b1', 'B', 1), gRow('b2', 'B', 2)];
    expect(applyDrop(rows, 'a1', 'b2', 'before')).toEqual(['b1', 'a1', 'b2']);
  });

  it('reports a move even when the key happens not to change', () => {
    // Same numeric key, different group: still a real move, so the helper must
    // not report the no-op that would make the caller skip the group write.
    const rows = [gRow('a1', 'A', 0), gRow('b1', 'B', 0), gRow('b2', 'B', 1)];
    expect(orderKeyForDrop(rows, 'a1', 'b1', 'before')).not.toBeNull();
  });

  it('still reports a same-group drop onto the slot it already holds as a no-op', () => {
    const rows = [gRow('a1', 'A', 0), gRow('a2', 'A', 1), gRow('a3', 'A', 2)];
    // a2 dropped before a3 is where a2 already is.
    expect(orderKeyForDrop(rows, 'a2', 'a3', 'before')).toBeNull();
  });

  it('returns null for a target that is not in the list', () => {
    const rows = [gRow('a1', 'A'), gRow('a2', 'A')];
    expect(orderKeyForDrop(rows, 'a1', 'nope', 'before')).toBeNull();
  });
});

/**
 * Pinning the band map (issues #393/#398). The freeze is only half a fix if it
 * lives in component state, so these follow it all the way through the mirror
 * and back, which is the round trip a reload actually makes.
 */
describe('pinned group bands survive a reload (issue #393)', () => {
  const gRow = (id: string, group: string, order?: number) =>
    ({ id, group, order }) as { id: string; group: string; order?: number; groupBand?: number };

  const ids = (rows: { id: string; group: string; order?: number; groupBand?: number }[],
                bands: Record<string, number>) =>
    sortByPaintOrder(rows, groupBands(rows, bands)).map((r) => r.id);

  it('reproduces the on-screen group order after a rehydrate from the mirror', () => {
    const before = [gRow('a1', 'A'), gRow('a2', 'A'), gRow('b1', 'B'), gRow('b2', 'B')];
    const pinned = freezeGroupBands(before);
    // The move that would otherwise re-derive A from a2 and swap the blocks.
    const moved = before.map((r) => (r.id === 'a1' ? { ...r, group: 'B', order: 2.5 } : r));
    const onScreen = ids(moved, pinned);
    expect(onScreen).toEqual(['a2', 'b1', 'a1', 'b2']);

    // Persist: the map is stamped onto the rows, which is all that reaches the
    // server. Then a cold client learns the map back from the rows alone.
    const stamped = stampGroupBands(moved, pinned);
    const relearned = hydrateGroupBands({}, stamped);
    expect(ids(stamped, relearned)).toEqual(onScreen);
  });

  it('stamps every group in the document, not only the ones on a page', () => {
    // A group living on another sheet must keep its band, or reopening the file
    // would reorder groups the user never touched.
    const rows = [gRow('p1', 'A'), gRow('p2', 'B'), gRow('p3', 'C')];
    const pinned = freezeGroupBands(rows);
    expect(Object.keys(pinned).sort()).toEqual(['A', 'B', 'C']);
  });

  it('leaves the map empty when nothing has been pinned', () => {
    // The derived default has to stay reachable: a document nobody regrouped
    // must store no bands at all.
    const rows = [gRow('a1', 'A'), gRow('b1', 'B')];
    expect(hydrateGroupBands({}, rows)).toEqual({});
    expect(stampGroupBands(rows, {})).toBe(rows);
  });

  it('hydrates from the mirror first, then stamps from the map, never both', () => {
    const rows = [gRow('a1', 'A'), gRow('b1', 'B')];
    rows[0]!.groupBand = 7;
    // First pass for a document: the mirror is the input.
    const first = groupBandCommit({ bands: {}, items: rows, hydratedFor: null }, 'doc');
    expect(first.bands).toEqual({ A: 7 });
    expect(first.items).toBeNull();
    expect(first.hydratedFor).toBe('doc');
    // Once hydrated the map is the input and the mirror is the output.
    const second = groupBandCommit(
      { bands: { A: 7, B: 8 }, items: rows, hydratedFor: 'doc' },
      'doc',
    );
    expect(second.bands).toBeNull();
    expect(second.items?.map((r) => r.groupBand)).toEqual([7, 8]);
  });

  it('does not declare an empty document hydrated', () => {
    // Rows still arriving from the server would otherwise be read as a document
    // with nothing pinned, and the pin would be lost on every open.
    const action = groupBandCommit({ bands: {}, items: [], hydratedFor: null }, 'doc');
    expect(action.hydratedFor).toBeNull();
    expect(action.bands).toBeNull();
    expect(action.items).toBeNull();
  });

  it('settles: stamping what was just hydrated produces no further write', () => {
    // The #398 failure mode was a pair with no fixed point. One pass each way
    // has to converge.
    const rows = [gRow('a1', 'A'), gRow('b1', 'B')];
    rows[0]!.groupBand = 0;
    rows[1]!.groupBand = 1;
    const learned = hydrateGroupBands({}, rows);
    expect(stampGroupBands(rows, learned)).toBe(rows);
  });
});

/**
 * Every slot in the list has to be reachable in one gesture (issue #392). The
 * slot after the last row of a group is the one that had none: with "before"
 * as the only side, no pointer position over any row produced it.
 */
describe('a drop can land after the target, not only before it (issue #392)', () => {
  const gRow = (id: string, group: string, order?: number) => ({ id, group, order });

  const applyDrop = (
    rows: { id: string; group: string; order?: number }[],
    draggedId: string,
    targetId: string,
    place: 'before' | 'after',
  ) => {
    const drop = orderKeyForDrop(rows, draggedId, targetId, place);
    if (drop === null) return null;
    // These fixtures never exhaust the key space, so the drop is always a key.
    // Asserted rather than assumed, so a change that starts renumbering here
    // fails loudly instead of writing an object into ``order``.
    expect(isRenormalisedDrop(drop)).toBe(false);
    const next = rows.map((r) => (r.id === draggedId ? { ...r, order: drop as number } : r));
    return sortByPaintOrder(next, groupBands(next)).map((r) => r.id);
  };

  it('reaches the slot after the last row, which before had no gesture', () => {
    const rows = [gRow('a', 'G'), gRow('b', 'G'), gRow('c', 'G')];
    // The reporter's repro: dragging a onto c must be able to produce b, c, a.
    expect(applyDrop(rows, 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
    // And the other half of the same row still produces the old answer.
    expect(applyDrop(rows, 'a', 'c', 'before')).toEqual(['b', 'a', 'c']);
  });

  it('reaches the slot after the last row of a group that is followed by another', () => {
    // This slot used to be reachable only by aiming at the first row of the
    // NEXT group, which worked only because a cross-group drop did nothing.
    const rows = [gRow('a1', 'A'), gRow('a2', 'A'), gRow('b1', 'B')];
    expect(applyDrop(rows, 'a1', 'a2', 'after')).toEqual(['a2', 'a1', 'b1']);
  });

  it('reaches the slot before the first row', () => {
    const rows = [gRow('a', 'G'), gRow('b', 'G'), gRow('c', 'G')];
    expect(applyDrop(rows, 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
  });

  it('treats a drop onto the side the row already occupies as a no-op', () => {
    const rows = [gRow('a', 'G', 0), gRow('b', 'G', 1), gRow('c', 'G', 2)];
    // b after a, and b before c, are both where b already is.
    expect(orderKeyForDrop(rows, 'b', 'a', 'after')).toBeNull();
    expect(orderKeyForDrop(rows, 'b', 'c', 'before')).toBeNull();
  });

  it('survives repeated drops into the same gap', () => {
    // Each drop into one gap halves the interval, so a long session of nudges
    // is where float precision would give out and two rows would compare equal.
    let rows = [gRow('a', 'G'), gRow('b', 'G'), gRow('c', 'G')];
    for (let i = 0; i < 60; i++) {
      const moved = i % 2 === 0 ? 'a' : 'c';
      const drop = orderKeyForDrop(rows, moved, 'b', 'after');
      if (drop === null) continue;
      // This run is long enough to exhaust the gap, so it is the one existing
      // scenario that reaches the whole-group renumbering.
      if (isRenormalisedDrop(drop)) {
        const orders = drop.orders;
        rows = rows.map((r) =>
          orders[r.id] === undefined ? r : { ...r, order: orders[r.id]! },
        );
      } else {
        rows = rows.map((r) => (r.id === moved ? { ...r, order: drop } : r));
      }
    }
    const ids = sortByPaintOrder(rows, groupBands(rows)).map((r) => r.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // b keeps its slot; the two rows being nudged stay on the side they landed.
    expect(ids.indexOf('b')).toBeLessThan(ids.length - 1);
  });

});

/**
 * Running out of fractional key space (issue #379).
 *
 * Every drop into one slot halves the gap between its neighbours, so a long
 * enough run reaches a gap whose midpoint IS one of its bounds. What these pin
 * down is the drop on which that happens: it still has to land where it was
 * released, which is the assertion the halving test above cannot make.
 */
describe('exhausting the key space between two neighbours (issue #379)', () => {
  type Row = { id: string; group: string; order?: number };
  const gRow = (id: string, group: string, order?: number): Row => ({ id, group, order });

  /** Rows after a drop, the way the viewer writes them: one key normally, and
   *  the whole group when the drop had to renumber to land. */
  const dropped = (
    rows: Row[],
    draggedId: string,
    targetId: string,
    place: 'before' | 'after',
  ): { renumbered: boolean; next: Row[] } | null => {
    const drop = orderKeyForDrop(rows, draggedId, targetId, place);
    if (drop === null) return null;
    if (!isRenormalisedDrop(drop)) {
      return {
        renumbered: false,
        next: rows.map((r) => (r.id === draggedId ? { ...r, order: drop } : r)),
      };
    }
    const orders = drop.orders;
    return {
      renumbered: true,
      // Compared against undefined, not for truthiness: 0 is a real key and the
      // first row of a renumbered group always gets it.
      next: rows.map((r) => (orders[r.id] === undefined ? r : { ...r, order: orders[r.id]! })),
    };
  };

  it('lands the drop on which the fractional space runs out', () => {
    // The halving test stops at "the list is still sane", which stays true even
    // when a drop was silently refused. This asserts the projected order on
    // EVERY drop, so the one where the midpoint collapses onto its bound has to
    // land too. Before renumbering, that drop either painted the row on the far
    // side of the target or tied their keys and was swallowed as a no-op.
    let rows = [gRow('a', 'G'), gRow('b', 'G'), gRow('c', 'G')];
    let renumbers = 0;
    for (let i = 0; i < 80; i++) {
      const moved = i % 2 === 0 ? 'a' : 'c';
      const applied = dropped(rows, moved, 'b', 'after');
      expect(applied).not.toBeNull();
      if (applied!.renumbered) renumbers++;
      const projected = sortByPaintOrder(applied!.next, groupBands(applied!.next)).map(
        (r) => r.id,
      );
      // Released on the upper half of b, so the moved row paints directly above
      // it. Stated as an adjacency rather than a fixed list, so the assertion is
      // about where this drop landed and not about where the other row drifted.
      expect(projected.indexOf(moved)).toBe(projected.indexOf('b') + 1);
      rows = applied!.next;
    }
    // The run has to actually reach exhaustion, or everything above is only
    // exercising the fast path and would pass against the unfixed function too.
    expect(renumbers).toBeGreaterThan(0);
  });

  it('gives every row of the group an explicit key when it renumbers', () => {
    // A row that was never reordered has no key and falls back to its array
    // index. Renumbering only the keyed rows would leave it on that fallback,
    // sorted against integers that mean something else entirely.
    const rows = [
      gRow('a', 'G', 1),
      gRow('b', 'G', 2),
      gRow('c', 'G', 1.9999999999999998),
      gRow('unkeyed', 'G'),
    ];
    const drop = orderKeyForDrop(rows, 'a', 'c', 'after');
    expect(isRenormalisedDrop(drop)).toBe(true);
    const orders = (drop as RenormalisedDrop).orders;
    expect(Object.keys(orders).sort()).toEqual(['a', 'b', 'c', 'unkeyed']);
    expect(Object.values(orders).every(Number.isInteger)).toBe(true);
  });

  it('renumbers only the target group', () => {
    // The renumber is scoped the way the neighbour search is. Rewriting keys
    // outside the target group would move rows the user never touched.
    const rows = [
      gRow('a1', 'A', 1),
      gRow('a2', 'A', 2),
      gRow('a3', 'A', 1.9999999999999998),
      gRow('b1', 'B', 5),
      gRow('b2', 'B', 6),
    ];
    const drop = orderKeyForDrop(rows, 'a1', 'a3', 'after');
    expect(isRenormalisedDrop(drop)).toBe(true);
    expect(Object.keys((drop as RenormalisedDrop).orders).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('still returns a plain number when there is room between the neighbours', () => {
    // The renumbering path is the exception. Guards against a change that makes
    // every ordinary drop pay for a multi-row write.
    const rows = [gRow('a', 'G', 0), gRow('b', 'G', 10), gRow('c', 'G', 20)];
    expect(orderKeyForDrop(rows, 'a', 'b', 'after')).toBe(15);
  });
});

/**
 * Dragging a whole group block (issue #400). ``reorderGroups`` is covered above
 * on its own; these pin the composition the viewer actually performs, which is
 * where the per-document rule is easy to get wrong.
 */
describe('dragging a group block to a new slot (issue #400)', () => {
  const gRow = (id: string, group: string, page = 1) => ({ id, group, page });

  /** The viewer's step: current bands, current on-screen group order, reorder. */
  const dragGroup = (
    rows: { id: string; group: string; page: number }[],
    pinned: Record<string, number>,
    dragged: string,
    target: string,
    place: 'before' | 'after',
  ) => {
    const current = groupBands(rows, pinned);
    const displayed = [...new Set(rows.map(groupOf))].sort(
      (a, b) => (current[a] ?? 0) - (current[b] ?? 0),
    );
    return reorderGroups(displayed, dragged, target, place);
  };

  it('moves the dragged block and leaves the others in their order', () => {
    const rows = [gRow('a', 'A'), gRow('b', 'B'), gRow('c', 'C')];
    const next = dragGroup(rows, {}, 'C', 'A', 'before')!;
    expect(next).not.toBeNull();
    const ids = sortByPaintOrder(rows, groupBands(rows, next)).map((r) => r.group);
    expect(ids).toEqual(['C', 'A', 'B']);
  });

  it('drops a group into the middle rather than the front', () => {
    // The trap the reorderGroups docstring calls out: banding only the dragged
    // group would re-derive the untouched ones above it.
    const rows = [gRow('a', 'A'), gRow('b', 'B'), gRow('c', 'C')];
    const next = dragGroup(rows, {}, 'C', 'B', 'before')!;
    const order = sortByPaintOrder(rows, groupBands(rows, next)).map((r) => r.group);
    expect(order).toEqual(['A', 'C', 'B']);
  });

  it('keeps the band of a group that lives only on another page', () => {
    // The sidebar renders one page. Renumbering only what is on screen would
    // silently drop the band of every group on the other sheets.
    const rows = [gRow('a', 'A', 1), gRow('b', 'B', 1), gRow('z', 'Z', 7)];
    const next = dragGroup(rows, {}, 'B', 'A', 'before')!;
    expect(Object.keys(next).sort()).toEqual(['A', 'B', 'Z']);
    const order = sortByPaintOrder(rows, groupBands(rows, next)).map((r) => r.group);
    expect(order).toEqual(['B', 'A', 'Z']);
  });

  it('composes with an already pinned map instead of starting over', () => {
    // Two drags in a row: the second must read the map the first produced.
    const rows = [gRow('a', 'A'), gRow('b', 'B'), gRow('c', 'C')];
    const first = dragGroup(rows, {}, 'C', 'A', 'before')!;
    const second = dragGroup(rows, first, 'B', 'C', 'before')!;
    const order = sortByPaintOrder(rows, groupBands(rows, second)).map((r) => r.group);
    expect(order).toEqual(['B', 'C', 'A']);
  });

  it('reports a drop back into the same slot as nothing to write', () => {
    const rows = [gRow('a', 'A'), gRow('b', 'B'), gRow('c', 'C')];
    expect(dragGroup(rows, {}, 'B', 'A', 'after')).toBeNull();
    expect(dragGroup(rows, {}, 'B', 'C', 'before')).toBeNull();
  });
});
