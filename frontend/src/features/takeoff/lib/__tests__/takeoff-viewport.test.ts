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
  });
});
