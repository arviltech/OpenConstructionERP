import { describe, expect, it } from 'vitest';
import {
  orthoSnap,
  orthoSnapVertexDrag,
  snapToVertex,
} from '@/features/takeoff/lib/takeoff-viewport';
import type { Point } from '@/features/takeoff/lib/takeoff-types';

describe('orthoSnapVertexDrag', () => {
  it('uses the sole adjacent vertex for an open endpoint', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    const cursor = { x: 20, y: 40 };

    expect(orthoSnapVertexDrag(points, 0, cursor, false)).toEqual(
      orthoSnap(points[1]!, cursor),
    );
  });

  it('chooses the closer adjacent-anchor result for an interior vertex', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ];
    const cursor = { x: 55, y: 30 };

    expect(orthoSnapVertexDrag(points, 1, cursor, false)).toEqual(
      orthoSnap(points[2]!, cursor),
    );
  });

  it('uses the wraparound neighbour for the first vertex of a polygon', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const cursor = { x: 10, y: 65 };

    expect(orthoSnapVertexDrag(points, 0, cursor, true)).toEqual(
      orthoSnap(points[3]!, cursor),
    );
  });

  it('snaps an endpoint segment to a clean 45-degree direction', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ];
    const snapped = orthoSnapVertexDrag(points, 1, { x: 80, y: 70 }, false);

    expect(Math.abs(snapped.x - points[0]!.x)).toBeCloseTo(
      Math.abs(snapped.y - points[0]!.y),
      5,
    );
    // The snap is length-preserving BY DESIGN: the raw cursor distance is
    // projected onto the snapped direction, never its axis component.
    expect(Math.hypot(snapped.x - points[0]!.x, snapped.y - points[0]!.y)).toBeCloseTo(
      Math.hypot(80 - points[0]!.x, 70 - points[0]!.y),
      5,
    );
  });

  it('preserves the raw cursor distance through an axis snap', () => {
    // A nearly-horizontal drag (3.5 degrees off) snaps to the horizontal ray
    // at the FULL raw distance - the segment must not shorten to its x span.
    const anchor: Point = { x: 0, y: 0 };
    const snapped = orthoSnap(anchor, { x: 196, y: 12 });

    expect(snapped.y).toBeCloseTo(0, 5);
    expect(snapped.x).toBeCloseTo(Math.hypot(196, 12), 5);
  });

  it('leaves magnet snap ahead of the ortho candidate', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const cursor = { x: 76, y: 26 };
    const magnet = snapToVertex(cursor, [{ x: 75, y: 25 }], 1);
    const point = magnet ?? orthoSnapVertexDrag(points, 1, cursor, false);

    expect(point).toEqual({ x: 75, y: 25 });
  });
});

describe('ortho-snapped translation vector', () => {
  it('derives a 45-degree delta from the drag start and snapped cursor', () => {
    const start = { x: 10, y: 10 };
    const snapped = orthoSnap(start, { x: 80, y: 65 });
    const dx = snapped.x - start.x;
    const dy = snapped.y - start.y;

    expect(Math.abs(dx)).toBeCloseTo(Math.abs(dy), 5);
    // Length-preserving: the translation magnitude equals the raw drag.
    expect(Math.hypot(dx, dy)).toBeCloseTo(Math.hypot(80 - 10, 65 - 10), 5);
  });
});
