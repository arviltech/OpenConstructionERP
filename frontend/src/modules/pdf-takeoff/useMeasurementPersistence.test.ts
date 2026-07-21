import { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useMeasurementPersistence,
  getDocumentIndex,
  removeFromStorage,
} from './useMeasurementPersistence';
import { emptyPageScales, type PageScales } from './data/page-scales';

// Keep these unit tests hermetic: the hook now calls the server (gated on a
// project + document UUID), so stub the API to return no rows. Each test then
// exercises the localStorage path deterministically.
vi.mock('@/features/takeoff/api', () => ({
  takeoffApi: {
    list: vi.fn().mockResolvedValue([]),
    bulkCreate: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    // Issue #334: the load effect also fetches the document (for its
    // authoritative page_scales) and PATCHes it when the user calibrates.
    getDocument: vi.fn().mockResolvedValue(null),
    saveDocumentScales: vi.fn().mockResolvedValue({ page_scales: null }),
  },
}));

// Mock measurements. The explicit return type includes the optional fields a
// few tests set after the fact (serverId / color / text) so a ``let rows =
// [makeMeasurement(...)]`` array can be reassigned with those props without a
// narrowed-literal type error.
type TestMeasurement = {
  id: string;
  type: 'distance';
  points: { x: number; y: number }[];
  value: number;
  unit: string;
  label: string;
  annotation: string;
  page: number;
  group: string;
  serverId?: string;
  color?: string;
  text?: string;
  strokeWidthReal?: number;
  orderKey?: string;
  createdAt?: string;
  groupOrder?: { key: string; rev: number; actor: string };
};
const makeMeasurement = (id: string, page = 1): TestMeasurement => ({
  id,
  type: 'distance',
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  value: 2.5,
  unit: 'm',
  label: 'D1',
  annotation: `Distance ${id}`,
  page,
  group: 'General',
});

// The hook dispatches both plain arrays and functional updaters (the stamp
// path is functional so it cannot clobber a same-tick rename). Replay the
// recorded dispatches in order, exactly as React's queue would, to recover
// the resulting state from a vi.fn() setter.
const replayDispatches = (
  setM: ReturnType<typeof vi.fn>,
  initial: TestMeasurement[] = [],
): TestMeasurement[] =>
  setM.mock.calls.reduce(
    (state: TestMeasurement[], c: unknown[]) =>
      typeof c[0] === 'function'
        ? (c[0] as (p: TestMeasurement[]) => TestMeasurement[])(state)
        : (c[0] as TestMeasurement[]),
    initial,
  );

const defaultScale = { pixelsPerUnit: 100, unitLabel: 'm' };
const basePageScales: PageScales = emptyPageScales();

// Stable identity (issue #238): measurements are keyed by project + a stable
// document UUID, never the filename. The composite localStorage key is
// ``oe_takeoff_<projectId>__<documentId>``.
const PROJECT = 'proj-1';
const DOC = 'doc-uuid-1';
const compositeKey = `oe_takeoff_${PROJECT}__${DOC}`;

describe('useMeasurementPersistence', () => {
  // Reset the module-default mock behaviour AND call history before every test.
  // The hook now flushes a server sync on unmount (issue #281), so the
  // testing-library cleanup of one test can dispatch bulkCreate/delete that
  // would otherwise pollute the next test's call counts; several tests also
  // install persistent implementations (``mockResolvedValue`` /
  // ``mockImplementation``). A full reset here makes the full-file run match
  // the isolated run.
  beforeEach(async () => {
    localStorage.clear();
    vi.useRealTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
    (takeoffApi.bulkCreate as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({});
    (takeoffApi.delete as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    (takeoffApi.getDocument as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    (takeoffApi.saveDocumentScales as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ page_scales: null });
  });

  // Defensive: if a test leaves fake timers on (e.g. an assertion threw before
  // its own ``vi.useRealTimers()``), restore real timers so the NEXT test's
  // ``waitFor`` polling is not frozen. Real-timer tests are unaffected.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty state when no fileName', () => {
    const setM = vi.fn();
    const setPS = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: null,
        documentId: null,
        measurements: [],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
      }),
    );
    expect(result.current.hasPersistedData).toBe(false);
    expect(result.current.savedDocumentCount).toBe(0);
  });

  it('saveNow persists under the project+document composite key', () => {
    const m1 = makeMeasurement('m1');
    const setM = vi.fn();
    const setPS = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'test.pdf',
        documentId: DOC,
        measurements: [m1],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    act(() => {
      result.current.saveNow();
    });

    // Keyed by project+document, NOT by filename (issue #238).
    expect(localStorage.getItem('oe_takeoff_test.pdf')).toBeNull();
    const raw = localStorage.getItem(compositeKey);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.measurements).toHaveLength(1);
    expect(parsed.measurements[0].id).toBe('m1');
    expect(parsed.pageScales.defaultScale.pixelsPerUnit).toBe(100);
    expect(parsed.scale.pixelsPerUnit).toBe(100);
    expect(parsed.savedAt).toBeGreaterThan(0);
    expect(getDocumentIndex()).toContain(compositeKey);
  });

  it('persists locally (not under a composite key) when there is no document UUID', () => {
    const m1 = makeMeasurement('m1');
    const setM = vi.fn();
    const setPS = vi.fn();
    // A freshly dropped local file: documentId null. It must persist locally
    // but never under the project+document key (it isn't a server document).
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'dropped.pdf',
        documentId: null,
        measurements: [m1],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    act(() => {
      result.current.saveNow();
    });

    const raw = localStorage.getItem('oe_takeoff_local__dropped.pdf');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).measurements).toHaveLength(1);
    // A local-only drop is not added to the synced-document index.
    expect(getDocumentIndex()).toEqual([]);
  });

  it('migrates a legacy single-scale document into the page-scale default', async () => {
    // Pre-populate localStorage in the OLD format (filename key, only ``scale``).
    const m1 = makeMeasurement('m1');
    const savedScale = { pixelsPerUnit: 50, unitLabel: 'm' };
    localStorage.setItem(
      'oe_takeoff_plan.pdf',
      JSON.stringify({ measurements: [m1], scale: savedScale, savedAt: Date.now() }),
    );

    const setM = vi.fn();
    const setPS = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'plan.pdf',
        documentId: DOC,
        measurements: [],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    // The load path is async (server first, then localStorage); the legacy
    // filename key is read and migrated into the composite key.
    await waitFor(() => expect(setM).toHaveBeenCalledWith([m1]));
    const ps = setPS.mock.calls[0]![0] as PageScales;
    expect(ps.defaultScale.pixelsPerUnit).toBe(50);
    expect(ps.byPage).toEqual({});
    // The legacy entry was rewritten under the composite key.
    const migrated = localStorage.getItem(compositeKey);
    expect(migrated).toBeTruthy();
    expect(JSON.parse(migrated!).measurements[0].id).toBe('m1');
  });

  it('reads back a new per-page scale document under the composite key', async () => {
    const m1 = makeMeasurement('m1', 3);
    const pageScales: PageScales = {
      defaultScale: { pixelsPerUnit: 100, unitLabel: 'm' },
      byPage: { 3: { pixelsPerUnit: 25, unitLabel: 'm' } },
    };
    localStorage.setItem(
      compositeKey,
      JSON.stringify({ measurements: [m1], pageScales, scale: defaultScale, savedAt: Date.now() }),
    );
    localStorage.setItem('oe_takeoff_index', JSON.stringify([compositeKey]));

    const setM = vi.fn();
    const setPS = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'multi.pdf',
        documentId: DOC,
        measurements: [],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    await waitFor(() => expect(setPS).toHaveBeenCalled());
    const ps = setPS.mock.calls[0]![0] as PageScales;
    expect(ps.defaultScale.pixelsPerUnit).toBe(100);
    expect(ps.byPage[3]!.pixelsPerUnit).toBe(25);
  });

  it('clearPersisted removes data under the composite key', () => {
    const setM = vi.fn();
    const setPS = vi.fn();
    localStorage.setItem(
      compositeKey,
      JSON.stringify({ measurements: [], scale: defaultScale, savedAt: Date.now() }),
    );
    localStorage.setItem('oe_takeoff_index', JSON.stringify([compositeKey]));

    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'test.pdf',
        documentId: DOC,
        measurements: [],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    act(() => {
      result.current.clearPersisted();
    });

    expect(localStorage.getItem(compositeKey)).toBeNull();
    expect(getDocumentIndex()).not.toContain(compositeKey);
  });

  it('getDocumentIndex returns list of saved documents', () => {
    expect(getDocumentIndex()).toEqual([]);

    localStorage.setItem('oe_takeoff_index', JSON.stringify(['a', 'b']));
    expect(getDocumentIndex()).toEqual(['a', 'b']);
  });

  it('removeFromStorage removes a specific project+document', () => {
    const keyA = `oe_takeoff_${PROJECT}__${DOC}`;
    const keyB = `oe_takeoff_${PROJECT}__doc-2`;
    localStorage.setItem(keyA, '{}');
    localStorage.setItem(keyB, '{}');
    localStorage.setItem('oe_takeoff_index', JSON.stringify([keyA, keyB]));

    removeFromStorage(PROJECT, DOC);

    expect(localStorage.getItem(keyA)).toBeNull();
    expect(getDocumentIndex()).toEqual([keyB]);
  });

  it('auto-saves on measurement changes (debounced) under the composite key', () => {
    vi.useFakeTimers();
    const m1 = makeMeasurement('m1');
    const setM = vi.fn();
    const setPS = vi.fn();

    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'auto.pdf',
        documentId: DOC,
        measurements: [m1],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    // Before debounce
    expect(localStorage.getItem(compositeKey)).toBeNull();

    // After 500ms debounce
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const raw = localStorage.getItem(compositeKey);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).measurements).toHaveLength(1);

    vi.useRealTimers();
  });

  it('savedDocumentCount reflects storage index size', () => {
    localStorage.setItem('oe_takeoff_index', JSON.stringify(['a', 'b', 'c']));
    const setM = vi.fn();
    const setPS = vi.fn();

    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: null,
        documentId: null,
        measurements: [],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
      }),
    );

    expect(result.current.savedDocumentCount).toBe(3);
  });

  it('handles corrupt localStorage gracefully', async () => {
    localStorage.setItem(compositeKey, '{invalid json');
    localStorage.setItem('oe_takeoff_index', JSON.stringify([compositeKey]));

    const setM = vi.fn();
    const setPS = vi.fn();
    await act(async () => {
      renderHook(() =>
        useMeasurementPersistence({
          fileName: 'bad.pdf',
          documentId: DOC,
          measurements: [],
          setMeasurements: setM,
          pageScales: basePageScales,
          setPageScales: setPS,
          scale: defaultScale,
          projectId: PROJECT,
        }),
      );
      // Flush the async load (server -> localStorage fallback).
      await Promise.resolve();
    });

    // Should not call setMeasurements with corrupt data
    expect(setM).not.toHaveBeenCalled();
  });

  // ── Issue #242: two PDFs that share a filename must not share measurements ──
  // The pre-#238 build keyed measurements by filename, so uploading a second
  // PDF whose name matched an earlier one surfaced the earlier file's
  // measurements (cross-document bleed). Identity is now project + a stable
  // document UUID, so two same-named documents are fully isolated and the
  // shared filename key is never written.
  it('isolates two same-named PDFs by document UUID (issue #242)', () => {
    const fileName = 'Floor Plan.pdf';
    const docA = 'doc-uuid-A';
    const docB = 'doc-uuid-B';
    const setM = vi.fn();
    const setPS = vi.fn();

    // Draw + save a measurement against document A.
    const { result: a } = renderHook(() =>
      useMeasurementPersistence({
        fileName,
        documentId: docA,
        measurements: [makeMeasurement('a1')],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );
    act(() => {
      a.current.saveNow();
    });

    // Draw + save a different measurement against document B - same filename,
    // same project, different upload.
    const { result: b } = renderHook(() =>
      useMeasurementPersistence({
        fileName,
        documentId: docB,
        measurements: [makeMeasurement('b1')],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );
    act(() => {
      b.current.saveNow();
    });

    const keyA = `oe_takeoff_${PROJECT}__${docA}`;
    const keyB = `oe_takeoff_${PROJECT}__${docB}`;
    // Each document keeps its own namespace; neither sees the other's work.
    expect(JSON.parse(localStorage.getItem(keyA)!).measurements[0].id).toBe('a1');
    expect(JSON.parse(localStorage.getItem(keyB)!).measurements[0].id).toBe('b1');
    // Nothing was ever written under a filename-derived key (the old bug).
    expect(localStorage.getItem('oe_takeoff_Floor Plan.pdf')).toBeNull();
    expect(localStorage.getItem('oe_takeoff_Floor_Plan.pdf')).toBeNull();
    // Both documents are tracked independently in the index.
    expect(getDocumentIndex()).toEqual(expect.arrayContaining([keyA, keyB]));
  });

  // ── Issue #242: a freshly dropped local file never syncs to the server ──
  // A drop with no server document UUID must stay local-only (no bulkCreate),
  // so the "uploaded PDF vanishes on refresh" path can only ever be backed by
  // a real server document, never a client-only blob the server never saw.
  it('does not server-sync a local drop that has no document UUID (issue #242)', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    const setM = vi.fn();
    const setPS = vi.fn();

    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'dropped.pdf',
        documentId: null,
        measurements: [makeMeasurement('m1')],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    // Past the 3s server-sync debounce: still no server write, because identity
    // (project + document UUID) is incomplete.
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(takeoffApi.bulkCreate).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ── Issue #276: server measurements must survive a setter identity change ──
  // The viewer used to pass inline-arrow setters whose identity changed on
  // every render. Those setters sat in the load effect's dependency array, so
  // a re-render WHILE the initial server fetch was in flight tore the effect
  // down (cancelled = true) and the resolved rows were dropped - the saved
  // takeoff silently failed to reappear. The hook now keeps the setters in
  // refs and depends only on the document identity, so an unstable setter can
  // no longer cancel an in-flight load.
  it('keeps server measurements when the setter identity changes mid-load (issue #276)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    let resolveList: ((rows: unknown[]) => void) | null = null;
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveList = res as unknown as (rows: unknown[]) => void;
        }),
    );

    const received: Array<Array<{ id: string }>> = [];
    const setPS = vi.fn();

    // Each render hands the hook brand-new inline-arrow setter closures (the
    // exact #276 trigger).
    const { rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'race.pdf',
        documentId: DOC,
        measurements: [],
        setMeasurements: (ms) => {
          received.push(ms as Array<{ id: string }>);
        },
        pageScales: basePageScales,
        setPageScales: (ps) => setPS(ps),
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    // Re-render twice while the server list promise is still pending.
    rerender();
    rerender();

    // The server now returns one measurement.
    await act(async () => {
      resolveList?.([
        {
          id: 's1', project_id: PROJECT, document_id: DOC, page: 1,
          type: 'distance', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          group_name: 'General', group_color: '#3B82F6', annotation: 'D1',
          measurement_value: 1, measurement_unit: 'm', depth: null,
          volume: null, perimeter: null, count_value: null,
          scale_pixels_per_unit: 100, linked_boq_position_id: null,
          is_deduction: false,
          metadata: { frontend_id: 'm1', scale_calibrated: false },
        },
      ]);
      await Promise.resolve();
    });

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    const last = received[received.length - 1]!;
    expect(last).toHaveLength(1);
    expect(last[0]!.id).toBe('m1');
  });

  // ── Issue #277: an uncalibrated page must not show a phantom calibration ──
  // A measurement drawn on a page still using the factory default carries the
  // default ratio (100 px/unit). Reconstructing per-page scale from the server
  // used to treat that as a real calibration, so the page came back showing
  // "Calibrated 1:N" instead of "Not calibrated". The page-scale model is now
  // only overwritten for pages that were genuinely calibrated.
  const serverRow = (over: Record<string, unknown>) => ({
    id: 's', project_id: PROJECT, document_id: DOC, page: 1, type: 'distance',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], group_name: 'General',
    group_color: '#3B82F6', annotation: '', measurement_value: 1,
    measurement_unit: 'm', depth: null, volume: null, perimeter: null,
    count_value: null, scale_pixels_per_unit: 100, linked_boq_position_id: null,
    is_deduction: false, metadata: { frontend_id: 'm' },
    ...over,
  });

  it('does not restore an uncalibrated default-scale page as calibrated (issue #277)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      serverRow({
        page: 1, scale_pixels_per_unit: 100,
        metadata: { frontend_id: 'm1', scale_calibrated: false },
      }),
    ]);
    const setM = vi.fn();
    const setPS = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'flat.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    // Measurements still load from the server...
    await waitFor(() => expect(setM).toHaveBeenCalled());
    // ...but the page-scale model is NOT replaced with a phantom calibration:
    // an explicit ``scale_calibrated:false`` page stays on the default.
    expect(setPS).not.toHaveBeenCalled();
  });

  it('restores an explicitly calibrated page from the server (issue #277)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      serverRow({
        id: 's2', page: 2, scale_pixels_per_unit: 25,
        metadata: { frontend_id: 'm1', scale_calibrated: true },
      }),
    ]);
    const setM = vi.fn();
    const setPS = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'sheet.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    await waitFor(() => expect(setPS).toHaveBeenCalled());
    const ps = setPS.mock.calls[0]![0] as PageScales;
    expect(ps.byPage[2]!.pixelsPerUnit).toBe(25);
    expect(ps.byPage[1]).toBeUndefined();
  });

  it('infers calibration for legacy rows (no flag) from the ratio (issue #277)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      // Legacy row still on the factory default -> not calibrated.
      serverRow({ id: 'a', page: 1, scale_pixels_per_unit: 100, metadata: { frontend_id: 'a' } }),
      // Legacy row at a real ratio -> a genuine per-sheet calibration.
      serverRow({ id: 'b', page: 2, scale_pixels_per_unit: 50, metadata: { frontend_id: 'b' } }),
    ]);
    const setM = vi.fn();
    const setPS = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'legacy.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    await waitFor(() => expect(setPS).toHaveBeenCalled());
    const ps = setPS.mock.calls[0]![0] as PageScales;
    expect(ps.byPage[2]!.pixelsPerUnit).toBe(50);
    expect(ps.byPage[1]).toBeUndefined();
  });

  it('persists the page calibration flag on server sync (issue #277)', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.bulkCreate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const calibrated: PageScales = {
      defaultScale,
      byPage: { 1: { pixelsPerUnit: 40, unitLabel: 'm' } },
    };
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'cal.pdf', documentId: DOC,
        measurements: [makeMeasurement('m1', 1)],
        setMeasurements: vi.fn(), pageScales: calibrated, setPageScales: vi.fn(),
        scale: { pixelsPerUnit: 40, unitLabel: 'm' }, projectId: PROJECT,
      }),
    );

    // Past the 3s server-sync debounce.
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(takeoffApi.bulkCreate).toHaveBeenCalled();
    const row = (takeoffApi.bulkCreate as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0][0];
    expect(row.scale_pixels_per_unit).toBe(40);
    expect(row.metadata.scale_calibrated).toBe(true);

    vi.useRealTimers();
  });

  /* ── Issue #281 / #282: create / update / delete sync + flush + reset ── */

  // A synced measurement (one carrying a serverId) is the precondition for the
  // delete + non-geometry-edit paths, so build one explicitly.
  const makeSyncedMeasurement = (id: string, serverId: string, page = 1) => ({
    ...makeMeasurement(id, page),
    serverId,
  });

  // ── #282 A: deleting a synced measurement DELETEs it on the server ──
  it('syncs a delete of a synced measurement to the server (issue #282)', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    const m1 = makeSyncedMeasurement('m1', 'srv-1');
    let rows = [m1];
    const setM = vi.fn();
    const setPS = vi.fn();

    const { result, rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'del.pdf',
        documentId: DOC,
        measurements: rows,
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    // User deletes m1: the viewer registers the deletion then drops it from
    // state. We mirror that here (registerDeletion + remove from the array).
    act(() => {
      result.current.registerDeletion('srv-1');
    });
    rows = [];
    rerender();

    // The delete is queued to localStorage immediately so a reload before the
    // debounce still removes it.
    expect(
      JSON.parse(localStorage.getItem(`${compositeKey}__pending_deletes`)!),
    ).toEqual(['srv-1']);

    // Past the 3s server-sync debounce the DELETE fires and the queue clears.
    await act(async () => {
      vi.advanceTimersByTime(3500);
      await Promise.resolve();
    });
    expect(takeoffApi.delete).toHaveBeenCalledWith('srv-1');
    expect(localStorage.getItem(`${compositeKey}__pending_deletes`)).toBeNull();

    vi.useRealTimers();
  });

  // ── #282 A: a deleted synced row does NOT resurrect on the next load ──
  it('does not resurrect a locally-deleted row when the server still returns it (issue #282)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // Seed a pending delete for srv-1 as if a prior session deleted it but the
    // server still has the row (the DELETE had not been applied / confirmed).
    localStorage.setItem(`${compositeKey}__pending_deletes`, JSON.stringify(['srv-1']));
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'srv-1', project_id: PROJECT, document_id: DOC, page: 1,
        type: 'distance', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        group_name: 'General', group_color: '#3B82F6', annotation: 'D1',
        measurement_value: 1, measurement_unit: 'm', depth: null,
        volume: null, perimeter: null, count_value: null,
        scale_pixels_per_unit: 100, linked_boq_position_id: null,
        is_deduction: false, metadata: { frontend_id: 'm1', scale_calibrated: false },
      },
      {
        id: 'srv-2', project_id: PROJECT, document_id: DOC, page: 1,
        type: 'distance', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
        group_name: 'General', group_color: '#3B82F6', annotation: 'D2',
        measurement_value: 2, measurement_unit: 'm', depth: null,
        volume: null, perimeter: null, count_value: null,
        scale_pixels_per_unit: 100, linked_boq_position_id: null,
        is_deduction: false, metadata: { frontend_id: 'm2', scale_calibrated: false },
      },
    ]);
    const setM = vi.fn();
    const setPS = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'res.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    await waitFor(() => expect(setM).toHaveBeenCalled());
    // The pending-deleted row (srv-1 / m1) is filtered out; only srv-2 loads.
    const loaded = setM.mock.calls[setM.mock.calls.length - 1]![0] as Array<{ id: string }>;
    expect(loaded.map((m) => m.id)).toEqual(['m2']);
  });

  // ── #282 B: a non-geometry edit (group/colour/annotation) PATCHes ──
  it('syncs a non-geometry edit of a synced measurement (issue #282)', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      measurement_value: 2.5, metadata: {},
    });
    const m1 = makeSyncedMeasurement('m1', 'srv-1');
    let rows = [m1];
    const setM = vi.fn();
    const setPS = vi.fn();

    const { rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'edit.pdf', documentId: DOC, measurements: rows,
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    // First render seeds the sync baseline (no PATCH yet).
    await act(async () => {
      await Promise.resolve();
    });
    expect(takeoffApi.update).not.toHaveBeenCalled();

    // Edit only NON-geometry properties: group, colour, annotation, notes.
    rows = [{ ...m1, group: 'Walls', color: '#FF0000', annotation: 'External wall', text: 'note' }];
    rerender();

    // Past the 400ms edit-PATCH debounce the row is PATCHed with the new props.
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(takeoffApi.update).toHaveBeenCalledTimes(1);
    const [patchedId, body] = (takeoffApi.update as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(patchedId).toBe('srv-1');
    expect(body.group_name).toBe('Walls');
    expect(body.group_color).toBe('#FF0000');
    expect(body.annotation).toBe('External wall');
    expect(body.metadata.text).toBe('note');

    vi.useRealTimers();
  });

  // ── #281: unmount/teardown flushes a pending change to localStorage ──
  it('flushes the latest measurements to localStorage on unmount (issue #281)', () => {
    const m1 = makeMeasurement('m1');
    const setM = vi.fn();
    const setPS = vi.fn();
    const { unmount } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'flush.pdf', documentId: DOC, measurements: [m1],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    // Nothing persisted yet (the 500ms auto-save debounce has not fired and we
    // never called saveNow).
    expect(localStorage.getItem(compositeKey)).toBeNull();

    // Leaving the document (SPA navigation / filmstrip switch remount) must
    // flush synchronously so the just-drawn measurement is not lost.
    unmount();
    const raw = localStorage.getItem(compositeKey);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).measurements[0].id).toBe('m1');
  });

  // ── #281: switching the document id loads the new doc, never carrying the
  //          previous document's measurements across. ──
  it('resets and reloads when the document id changes (issue #281)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    const DOC_A = 'doc-A';
    const DOC_B = 'doc-B';
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: string, d: string) =>
        Promise.resolve(
          d === DOC_B
            ? [
                {
                  id: 'srv-b', project_id: PROJECT, document_id: DOC_B, page: 1,
                  type: 'distance', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
                  group_name: 'General', group_color: '#3B82F6', annotation: 'B1',
                  measurement_value: 1, measurement_unit: 'm', depth: null,
                  volume: null, perimeter: null, count_value: null,
                  scale_pixels_per_unit: 100, linked_boq_position_id: null,
                  is_deduction: false, metadata: { frontend_id: 'b1', scale_calibrated: false },
                },
              ]
            : [],
        ),
    );
    const setM = vi.fn();
    const setPS = vi.fn();
    let docId = DOC_A;
    const { rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'doc-a.pdf', documentId: docId, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    // Doc A had no server rows; nothing loaded.
    await act(async () => { await Promise.resolve(); });
    setM.mockClear();

    // Switch to document B (a different id => new identity => fresh load).
    docId = DOC_B;
    rerender();

    // Document B's own measurement loads; A's nothing is carried across.
    await waitFor(() => expect(setM).toHaveBeenCalled());
    const loaded = setM.mock.calls[setM.mock.calls.length - 1]![0] as Array<{ id: string }>;
    expect(loaded.map((m) => m.id)).toEqual(['b1']);
  });

  // ── #282: an undo that restores a deleted synced row cancels the queued
  //          server delete instead of orphaning it. ──
  it('cancels a queued delete when the row is restored before the sync (issue #282)', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.delete as unknown as ReturnType<typeof vi.fn>).mockClear();
    const m1 = makeSyncedMeasurement('m1', 'srv-1');
    let rows = [m1];
    const setM = vi.fn();
    const setPS = vi.fn();

    const { result, rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'undo.pdf', documentId: DOC, measurements: rows,
        setMeasurements: setM, pageScales: basePageScales, setPageScales: setPS,
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    // Delete then immediately undo (the row reappears in state with its
    // serverId) - all before the 3s debounce fires.
    act(() => { result.current.registerDeletion('srv-1'); });
    rows = [];
    rerender();
    rows = [m1]; // undo restored it
    rerender();

    await act(async () => {
      vi.advanceTimersByTime(3500);
      await Promise.resolve();
    });
    // The delete was cancelled because the row is live again.
    expect(takeoffApi.delete).not.toHaveBeenCalled();
    expect(localStorage.getItem(`${compositeKey}__pending_deletes`)).toBeNull();

    vi.useRealTimers();
  });

  /* ── Issue #339: real-world line width round-trips + re-syncs ── */

  // A real-world stroke width (canonical metres) rides the free-form metadata
  // blob as ``stroke_width_real`` next to the pixel ``stroke_width``. It must
  // survive a create serialize AND come back on load, so a true-width line
  // renders per each page's scale after a server round-trip.
  it('round-trips strokeWidthReal as stroke_width_real (serialize + deserialize, issue #339)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    const bulkCreate = takeoffApi.bulkCreate as unknown as ReturnType<typeof vi.fn>;
    bulkCreate.mockResolvedValue([]);

    // Serialize: saveNow pushes the create through toApiFormat immediately.
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'width.pdf',
        documentId: DOC,
        measurements: [{ ...makeMeasurement('m1'), strokeWidthReal: 0.25 }],
        setMeasurements: vi.fn(),
        pageScales: basePageScales,
        setPageScales: vi.fn(),
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );
    await act(async () => {
      result.current.saveNow();
      await Promise.resolve();
    });
    expect(bulkCreate).toHaveBeenCalled();
    const created = bulkCreate.mock.calls[0]![0][0];
    expect(created.metadata.stroke_width_real).toBe(0.25);

    // Deserialize: the same metadata blob read back hydrates strokeWidthReal.
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...created, id: 'srv-1' },
    ]);
    const setM = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'width.pdf',
        documentId: 'doc-uuid-2',
        measurements: [],
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: vi.fn(),
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    const loaded = setM.mock.calls[setM.mock.calls.length - 1]![0] as Array<{
      strokeWidthReal?: number;
    }>;
    expect(loaded[0]!.strokeWidthReal).toBe(0.25);
  });

  // An appearance-only real-width change moves no geometry, so the sync
  // signature must carry it (``swr``) or the edit would never reach the server.
  it('re-syncs (PATCHes) when only strokeWidthReal changes (issue #339)', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      measurement_value: 2.5,
      metadata: {},
    });
    const m1 = makeSyncedMeasurement('m1', 'srv-1');
    let rows: TestMeasurement[] = [m1];
    const setM = vi.fn();
    const setPS = vi.fn();

    const { rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'width-edit.pdf',
        documentId: DOC,
        measurements: rows,
        setMeasurements: setM,
        pageScales: basePageScales,
        setPageScales: setPS,
        scale: defaultScale,
        projectId: PROJECT,
      }),
    );

    // First render seeds the sync baseline (no PATCH yet).
    await act(async () => {
      await Promise.resolve();
    });
    expect(takeoffApi.update).not.toHaveBeenCalled();

    // Change ONLY the real width -> the sync signature drifts -> a PATCH fires
    // carrying the new stroke_width_real (an appearance-only, non-geometry edit).
    rows = [{ ...m1, strokeWidthReal: 0.2 }];
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(takeoffApi.update).toHaveBeenCalledTimes(1);
    const [patchedId, body] = (takeoffApi.update as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(patchedId).toBe('srv-1');
    expect(body.metadata.stroke_width_real).toBe(0.2);

    vi.useRealTimers();
  });

  /* ── Persisted measurement order (metadata.order_key) ── */

  // Server row factory for the order tests: a full API row with an optional
  // metadata.order_key and created_at.
  const apiOrderRow = (
    serverId: string,
    frontendId: string,
    createdAt: string,
    orderKey?: string,
  ) => ({
    id: serverId, project_id: PROJECT, document_id: DOC, page: 1,
    type: 'distance', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    group_name: 'General', group_color: '#3B82F6', annotation: `D-${frontendId}`,
    measurement_value: 1, measurement_unit: 'm', depth: null,
    volume: null, perimeter: null, count_value: null,
    scale_pixels_per_unit: 100, linked_boq_position_id: null,
    is_deduction: false,
    metadata: {
      frontend_id: frontendId,
      scale_calibrated: false,
      ...(orderKey ? { order_key: orderKey } : {}),
    },
    created_at: createdAt,
  });

  it('hydrates explicitly keyed rows in key order, ahead of keyless creation order', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // m1 is the OLDEST row but keyed LAST ('a2'); m2 is newer but keyed
    // first ('a1'); m3 is keyless. Creation-order hydrate would give
    // m1,m2,m3 — the keys must override to m2,m1,m3.
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      apiOrderRow('srv-3', 'm3', '2026-07-19T10:02:00Z'),
      apiOrderRow('srv-2', 'm2', '2026-07-19T10:01:00Z', 'a1'),
      apiOrderRow('srv-1', 'm1', '2026-07-19T10:00:00Z', 'a2'),
    ]);
    const setM = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'ord.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    const loaded = setM.mock.calls[setM.mock.calls.length - 1]![0] as Array<{
      id: string; orderKey?: string;
    }>;
    expect(loaded.map((m) => m.id)).toEqual(['m2', 'm1', 'm3']);
    expect(loaded.map((m) => m.orderKey)).toEqual(['a1', 'a2', undefined]);
  });

  it('reconcile: the server key wins over a stale local key when no write is pending', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // The local copy of m1 carries an OLD key 'a9' (e.g. this tab slept
    // through a move made elsewhere). Its id is NOT in pendingOrderKeys, so
    // the server's newer 'a1' must win — prefer-local would roll the move
    // back for every client.
    localStorage.setItem(compositeKey, JSON.stringify({
      measurements: [{
        ...makeMeasurement('m1'), serverId: 'srv-1', orderKey: 'a9',
      }],
      scale: defaultScale,
      savedAt: 1,
    }));
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      apiOrderRow('srv-1', 'm1', '2026-07-19T10:00:00Z', 'a1'),
      apiOrderRow('srv-2', 'm2', '2026-07-19T10:01:00Z', 'a2'),
    ]);
    const setM = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'ord.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    const loaded = setM.mock.calls[setM.mock.calls.length - 1]![0] as Array<{
      id: string; orderKey?: string;
    }>;
    expect(loaded.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(loaded[0]!.orderKey).toBe('a1');
  });

  it('reconcile: a pending local key wins and the interrupted flush resumes on reload', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // A move to 'a9' was applied locally but its PATCH never landed (reload
    // mid-flush): the queue + provenance set persisted with the rows. On
    // load the local key must win over the server's stale 'a1' AND the
    // queued write must be re-sent.
    localStorage.setItem(compositeKey, JSON.stringify({
      measurements: [{
        ...makeMeasurement('m1'), serverId: 'srv-1', orderKey: 'a9',
      }],
      scale: defaultScale,
      savedAt: 1,
      orderQueue: [{ id: 'm1', orderKey: 'a9' }],
      pendingOrderKeys: ['m1'],
    }));
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      apiOrderRow('srv-1', 'm1', '2026-07-19T10:00:00Z', 'a1'),
      apiOrderRow('srv-2', 'm2', '2026-07-19T10:01:00Z', 'a2'),
    ]);
    const setM = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'ord.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    const loaded = replayDispatches(setM);
    // Local pending key wins: m1 ('a9') sorts after m2 ('a2').
    expect(loaded.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(loaded.find((m) => m.id === 'm1')!.orderKey).toBe('a9');
    // The queued write resumes against the server.
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledWith('srv-1', {
        metadata: { order_key: 'a9' },
      }),
    );
  });

  it('persistOrderKeys drains strictly sequentially with metadata-only bodies', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    let inFlight = 0;
    let maxInFlight = 0;
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight -= 1;
        return {};
      },
    );
    const rows = [
      { ...makeMeasurement('m1'), serverId: 'srv-1' },
      { ...makeMeasurement('m2'), serverId: 'srv-2' },
      { ...makeMeasurement('m3'), serverId: 'srv-3' },
    ];
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'seq.pdf', documentId: DOC, measurements: rows,
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    act(() => {
      result.current.persistOrderKeys([
        { id: 'm1', orderKey: 'a1' },
        { id: 'm2', orderKey: 'a2' },
        { id: 'm3', orderKey: 'a3' },
      ]);
    });
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledTimes(3),
    );
    const calls = (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Queue order, one at a time, each body writing exactly the one key.
    expect(calls.map((c) => c[0])).toEqual(['srv-1', 'srv-2', 'srv-3']);
    expect(calls.map((c) => c[1])).toEqual([
      { metadata: { order_key: 'a1' } },
      { metadata: { order_key: 'a2' } },
      { metadata: { order_key: 'a3' } },
    ]);
    expect(maxInFlight).toBe(1);
    // Fully acked: the persisted resume state is empty again.
    await waitFor(() => {
      const payload = JSON.parse(localStorage.getItem(compositeKey)!);
      expect(payload.orderQueue).toEqual([]);
      expect(payload.pendingOrderKeys).toEqual([]);
    });
  });

  it('an interrupted flush keeps the un-acked suffix queued and resumes after remount', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // First write lands, second fails (network drop): the drain must stop —
    // the server now holds a PREFIX of the writes (an order every client
    // already sees) — and persist the remaining queue for resume.
    let call = 0;
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        call += 1;
        if (call === 2) throw new Error('network');
        return {};
      },
    );
    const rows = [
      { ...makeMeasurement('m1'), serverId: 'srv-1' },
      { ...makeMeasurement('m2'), serverId: 'srv-2' },
      { ...makeMeasurement('m3'), serverId: 'srv-3' },
    ];
    const { result, unmount } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'resume.pdf', documentId: DOC, measurements: rows,
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      result.current.persistOrderKeys([
        { id: 'm1', orderKey: 'a1' },
        { id: 'm2', orderKey: 'a2' },
        { id: 'm3', orderKey: 'a3' },
      ]);
      await Promise.resolve();
    });
    await waitFor(() => expect(takeoffApi.update).toHaveBeenCalledTimes(2));
    // m1 acked; m2 failed mid-write; m2+m3 remain queued (and pending).
    const payload = JSON.parse(localStorage.getItem(compositeKey)!);
    expect(payload.orderQueue).toEqual([
      { id: 'm2', field: 'order', orderKey: 'a2' },
      { id: 'm3', field: 'order', orderKey: 'a3' },
    ]);
    expect([...payload.pendingOrderKeys].sort()).toEqual(['order:m2', 'order:m3']);

    unmount();

    // Reload: the server has the prefix (m1's key); the queue must drain the
    // suffix from exactly the failed write.
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({});
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      apiOrderRow('srv-1', 'm1', '2026-07-19T10:00:00Z', 'a1'),
      apiOrderRow('srv-2', 'm2', '2026-07-19T10:01:00Z'),
      apiOrderRow('srv-3', 'm3', '2026-07-19T10:02:00Z'),
    ]);
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'resume.pdf', documentId: DOC, measurements: [],
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => {
      const resumed = (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(resumed).toEqual([
        ['srv-2', { metadata: { order_key: 'a2' } }],
        ['srv-3', { metadata: { order_key: 'a3' } }],
      ]);
    });
  });

  it('bulkCreate baselines from the SENT snapshot so a mid-flight edit still PATCHes', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    let resolveCreate!: (rows: unknown[]) => void;
    (takeoffApi.bulkCreate as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveCreate = r; }),
    );
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      measurement_value: 2.5, metadata: {},
    });
    const m1 = makeMeasurement('m1');
    let rows: TestMeasurement[] = [m1];
    const setM = vi.fn();
    const { rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'baseline.pdf', documentId: DOC, measurements: rows,
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );

    // Past the 3s debounce the create goes out with the ORIGINAL annotation.
    await act(async () => {
      vi.advanceTimersByTime(3500);
      await Promise.resolve();
    });
    expect(takeoffApi.bulkCreate).toHaveBeenCalledTimes(1);

    // Edit the row WHILE the create is in flight.
    rows = [{ ...m1, annotation: 'edited-mid-flight' }];
    rerender();

    // The create resolves against the OLD (sent) snapshot.
    await act(async () => {
      resolveCreate([{ id: 'srv-1', metadata: { frontend_id: 'm1' } }]);
      await Promise.resolve();
    });

    // The hook stamped serverId onto the latest (edited) row; mirror the
    // parent state update.
    const stamped = setM.mock.calls[setM.mock.calls.length - 1]![0] as TestMeasurement[];
    expect(stamped[0]!.serverId).toBe('srv-1');
    expect(stamped[0]!.annotation).toBe('edited-mid-flight');
    rows = stamped;
    rerender();

    // The baseline must be the SENT signature, so the mid-flight edit reads
    // dirty and re-PATCHes. (Seeding from the by-then-current state would
    // silently mark the edit synced — it would never reach the server.)
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    const patch = (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === 'srv-1' && c[1]?.annotation !== undefined);
    expect(patch).toBeDefined();
    expect(patch![1].annotation).toBe('edited-mid-flight');

    vi.useRealTimers();
  });

  it('the debounced PATCH skips a row whose order write is still queued', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    // The order flush is down (server rejecting): the key write stays queued.
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('down'),
    );
    const m1 = { ...makeMeasurement('m1'), serverId: 'srv-1' };
    let rows: TestMeasurement[] = [m1];
    const setM = vi.fn();
    const { result, rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'skip.pdf', documentId: DOC, measurements: rows,
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      result.current.persistOrderKeys([{ id: 'm1', orderKey: 'a1' }]);
      await Promise.resolve();
    });
    const metadataOnlyCalls = () =>
      (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(metadataOnlyCalls()).toHaveLength(1); // the failed key write

    // The row also goes field-dirty while its key write is queued. The
    // debounced PATCH must SKIP it: a concurrent full-body PATCH (which
    // carries the final key) could land a non-prefix key subset that
    // reorders the document for other clients mid-flush.
    rows = [{ ...m1, annotation: 'renamed' }];
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(
      metadataOnlyCalls().filter((c) => c[1]?.group_name !== undefined),
    ).toHaveLength(0);

    // Server back up: the queue drains, the row leaves the pending set, and
    // the field edit PATCHes on the next pass.
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      measurement_value: 2.5, metadata: {},
    });
    await act(async () => {
      result.current.persistOrderKeys([{ id: 'm1', orderKey: 'a1' }]);
      await Promise.resolve();
    });
    rows = [...rows];
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    const fullPatch = metadataOnlyCalls().find(
      (c) => c[1]?.group_name !== undefined,
    );
    expect(fullPatch).toBeDefined();
    expect(fullPatch![1].annotation).toBe('renamed');

    vi.useRealTimers();
  });

  /* ── Persisted GROUP order (metadata.group_order_* triples) ── */

  // Server row factory with a group name and an optional mirrored triple.
  const groupRow = (
    serverId: string,
    frontendId: string,
    group: string,
    createdAt: string,
    triple?: { key: string; rev: number; actor: string },
  ) => ({
    ...apiOrderRow(serverId, frontendId, createdAt),
    group_name: group,
    metadata: {
      frontend_id: frontendId,
      scale_calibrated: false,
      ...(triple
        ? {
            group_order_key: triple.key,
            group_order_rev: triple.rev,
            group_order_actor: triple.actor,
          }
        : {}),
    },
  });

  it('hydrates group-order triples from server metadata into the band map', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      groupRow('srv-1', 'm1', 'Walls', '2026-07-19T10:00:00Z', { key: 'a2', rev: 1, actor: 'A' }),
      groupRow('srv-2', 'm2', 'General', '2026-07-19T10:01:00Z', { key: 'a1', rev: 1, actor: 'A' }),
    ]);
    const setM = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    await waitFor(() =>
      expect(result.current.groupOrderKeys).toEqual({
        Walls: { key: 'a2', rev: 1, actor: 'A' },
        General: { key: 'a1', rev: 1, actor: 'A' },
      }),
    );
    // Rows carry the parsed triples too.
    const loaded = setM.mock.calls[setM.mock.calls.length - 1]![0] as TestMeasurement[];
    expect(loaded.find((m) => m.id === 'm1')!.groupOrder).toEqual({ key: 'a2', rev: 1, actor: 'A' });
  });

  it('fold-back adopts the NEWEST observed triple for a group (recency, not position)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // Two rows of one group disagree (an interrupted stamp elsewhere): the
    // (rev, actor)-newer triple must win regardless of row order.
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      groupRow('srv-1', 'm1', 'General', '2026-07-19T10:00:00Z', { key: 'a1', rev: 1, actor: 'B' }),
      groupRow('srv-2', 'm2', 'General', '2026-07-19T10:01:00Z', { key: 'a2', rev: 2, actor: 'A' }),
    ]);
    const setM = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    await waitFor(() =>
      expect(result.current.groupOrderKeys.General).toEqual({ key: 'a2', rev: 2, actor: 'A' }),
    );
  });

  it('reconcile: a NEWER local triple survives a stale server copy', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    localStorage.setItem(compositeKey, JSON.stringify({
      measurements: [{
        ...makeMeasurement('m1'), serverId: 'srv-1',
        groupOrder: { key: 'a3', rev: 2, actor: 'B' },
      }],
      scale: defaultScale,
      savedAt: 1,
    }));
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      groupRow('srv-1', 'm1', 'General', '2026-07-19T10:00:00Z', { key: 'a1', rev: 1, actor: 'A' }),
    ]);
    const setM = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    const loaded = setM.mock.calls[setM.mock.calls.length - 1]![0] as TestMeasurement[];
    expect(loaded[0]!.groupOrder).toEqual({ key: 'a3', rev: 2, actor: 'B' });
    await waitFor(() =>
      expect(result.current.groupOrderKeys.General).toEqual({ key: 'a3', rev: 2, actor: 'B' }),
    );
  });

  it('applyGroupOrder stamps member rows and drains per-row triple PATCHes', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    const rows = [
      { ...makeMeasurement('m1'), serverId: 'srv-1' },
      { ...makeMeasurement('m2'), serverId: 'srv-2', group: 'Walls' },
    ];
    const setM = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: rows,
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    const entry = { key: 'a1', rev: 1, actor: 'tab' };
    act(() => {
      result.current.applyGroupOrder([{ group: 'General', entry }]);
    });
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledWith('srv-1', {
        metadata: { group_order_key: 'a1', group_order_rev: 1, group_order_actor: 'tab' },
      }),
    );
    // Only the member row is written; the other group's row is untouched, and
    // the triple stamp does NOT trigger a full-body PATCH (queue exclusivity).
    expect(takeoffApi.update).toHaveBeenCalledTimes(1);
    expect(result.current.groupOrderKeys.General).toEqual(entry);
    // The stamp reached React state (the mock setter never feeds the prop
    // back, so replay the recorded dispatches over the initial rows).
    const stamped = replayDispatches(setM, rows);
    expect(stamped.find((m) => m.id === 'm1')!.groupOrder).toEqual(entry);
    expect(stamped.find((m) => m.id === 'm2')!.groupOrder).toBeUndefined();
  });

  it('applyGroupOrder withGroupName carries group_name on the same PATCH (rename path)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // The viewer has already rewritten the rows to the new name; the queued
    // write must land name + triple atomically per row.
    const rows = [{ ...makeMeasurement('m1'), serverId: 'srv-1', group: 'Walls' }];
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: rows,
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    const entry = { key: 'a1', rev: 1, actor: 'tab' };
    act(() => {
      result.current.applyGroupOrder([{ group: 'Walls', entry, withGroupName: true }]);
    });
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledWith('srv-1', {
        group_name: 'Walls',
        metadata: { group_order_key: 'a1', group_order_rev: 1, group_order_actor: 'tab' },
      }),
    );
  });

  it('applyGroupOrder stamp does not clobber a same-tick functional rename', async () => {
    // The rename flow dispatches its row rewrite (group name change) as a
    // functional update and calls applyGroupOrder in the SAME tick (with
    // memberIds, because the rewrite has not flushed). The stamp must also
    // be functional: a value dispatch built from the ref snapshot would
    // re-apply the pre-rename groups after React flushes the rename, and
    // the autosave would then PATCH the old name back over the server.
    const { result } = renderHook(() => {
      const [ms, setMs] = useState<TestMeasurement[]>([
        { ...makeMeasurement('m1'), serverId: 'srv-1', group: 'Walls' },
      ]);
      const hook = useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC,
        measurements: ms as Parameters<typeof useMeasurementPersistence>[0]['measurements'],
        setMeasurements: setMs as Parameters<typeof useMeasurementPersistence>[0]['setMeasurements'],
        pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      });
      return { ms, setMs, hook };
    });
    await act(async () => { await Promise.resolve(); });

    const entry = { key: 'a1', rev: 2, actor: 'tab' };
    act(() => {
      // The viewer's rename: functional rewrite of the rows…
      result.current.setMs((prev) =>
        prev.map((m) => (m.group === 'Walls' ? { ...m, group: 'Rooms' } : m)),
      );
      // …then the band-entry transfer stamp in the same tick.
      result.current.hook.applyGroupOrder([
        { group: 'Rooms', entry, withGroupName: true, memberIds: ['m1'] },
      ]);
    });
    const row = result.current.ms.find((m) => m.id === 'm1')!;
    expect(row.group).toBe('Rooms'); // the rename survived the stamp
    expect(row.groupOrder).toEqual(entry); // and the stamp landed
  });

  it('retains a group-order write for an unsynced row until its create lands', async () => {
    vi.useFakeTimers();
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.bulkCreate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'srv-1', metadata: { frontend_id: 'm1' } },
    ]);
    // m1 has NO serverId yet. Its triple cannot ride toApiUpdate (triples are
    // queue-exclusive), so the queued write must be RETAINED — not dropped —
    // until the create supplies a serverId, then drain. Mirror the parent
    // state so the hook's stamp lands back in the ``measurements`` prop, as
    // the real viewer setter does.
    let rows: TestMeasurement[] = [makeMeasurement('m1')];
    const setM = vi.fn((next: unknown) => {
      rows = typeof next === 'function'
        ? (next as (p: TestMeasurement[]) => TestMeasurement[])(rows)
        : (next as TestMeasurement[]);
    });
    const { result, rerender } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: rows,
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    const entry = { key: 'a1', rev: 1, actor: 'tab' };
    await act(async () => {
      result.current.applyGroupOrder([{ group: 'General', entry }]);
      await Promise.resolve();
    });
    rerender();
    // No PATCH possible yet; the entry stays queued.
    expect(takeoffApi.update).not.toHaveBeenCalled();
    act(() => { result.current.saveNow(); });
    const payload = JSON.parse(localStorage.getItem(compositeKey)!);
    expect(payload.orderQueue).toEqual([
      { id: 'm1', field: 'group_order', groupOrder: entry },
    ]);

    // The debounced create fires; its body carries the stamped triple, and the
    // post-create re-drain flushes the retained queue entry as a PATCH.
    await act(async () => {
      vi.advanceTimersByTime(3500);
      await Promise.resolve();
    });
    expect(takeoffApi.bulkCreate).toHaveBeenCalled();
    const created = (takeoffApi.bulkCreate as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0][0];
    expect(created.metadata.group_order_key).toBe('a1');
    expect(created.metadata.group_order_rev).toBe(1);
    // The post-create re-drain is purely promise-driven; hand the clock back
    // to real timers so waitFor can poll it.
    vi.useRealTimers();
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledWith('srv-1', {
        metadata: { group_order_key: 'a1', group_order_rev: 1, group_order_actor: 'tab' },
      }),
    );
  });

  it('does not re-enqueue an already-applied equal triple (dedup under a down server)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('down'),
    );
    const rows = [{ ...makeMeasurement('m1'), serverId: 'srv-1' }];
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: rows,
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    const entry = { key: 'a1', rev: 1, actor: 'tab' };
    await act(async () => {
      result.current.applyGroupOrder([{ group: 'General', entry }]);
      await Promise.resolve();
    });
    // Second apply of the SAME entry (e.g. the convergence effect re-running):
    // the failed write stays queued exactly once.
    await act(async () => {
      result.current.applyGroupOrder([{ group: 'General', entry }]);
      await Promise.resolve();
    });
    act(() => { result.current.saveNow(); });
    const payload = JSON.parse(localStorage.getItem(compositeKey)!);
    expect(
      payload.orderQueue.filter(
        (e: { id: string; field: string }) => e.id === 'm1' && e.field === 'group_order',
      ),
    ).toHaveLength(1);
  });

  it('legacy group-order queue entries with a corrupt triple are dropped on migration', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // A persisted queue holding one valid order write, one valid group write
    // and one corrupt group write (bad rev): migration keeps the two valid
    // entries and discards the corrupt one instead of poisoning the drain.
    localStorage.setItem(compositeKey, JSON.stringify({
      measurements: [{ ...makeMeasurement('m1'), serverId: 'srv-1', orderKey: 'a1' }],
      scale: defaultScale,
      savedAt: 1,
      orderQueue: [
        { id: 'm1', orderKey: 'a1' },
        { id: 'm1', field: 'group_order', groupOrder: { key: 'a1', rev: 1, actor: 'tab' } },
        { id: 'm1', field: 'group_order', groupOrder: { key: 'a2', rev: -5, actor: '' } },
      ],
      pendingOrderKeys: ['m1'],
    }));
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      groupRow('srv-1', 'm1', 'General', '2026-07-19T10:00:00Z'),
    ]);
    const setM = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    // Both surviving writes drain in order; the corrupt entry never fires.
    await waitFor(() => {
      const calls = (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toEqual([
        ['srv-1', { metadata: { order_key: 'a1' } }],
        ['srv-1', { metadata: { group_order_key: 'a1', group_order_rev: 1, group_order_actor: 'tab' } }],
      ]);
    });
  });

  it('persistRowGroupOrder PATCHes a crossed row to the destination band triple', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // The viewer has already rewritten the row (group + mirrored triple) in
    // its own state update; this call only queues the per-row write.
    const rows = [{ ...makeMeasurement('m1'), serverId: 'srv-1', group: 'Walls' }];
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: rows,
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    const dest = { key: 'a2', rev: 3, actor: 'tab' };
    act(() => {
      result.current.persistRowGroupOrder([{ id: 'm1', entry: dest }]);
    });
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledWith('srv-1', {
        metadata: { group_order_key: 'a2', group_order_rev: 3, group_order_actor: 'tab' },
      }),
    );
    expect(takeoffApi.update).toHaveBeenCalledTimes(1);
  });

  it('persistRowGroupOrder null CLEARS the server triple (keyless destination band)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    // A row moved into a KEYLESS band must not keep its old band's triple on
    // the server either, or a fresh hydration re-teaches the map the old key
    // for the new group and bands silently reorder.
    const rows = [{ ...makeMeasurement('m1'), serverId: 'srv-1', group: 'Keyless' }];
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: rows,
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    act(() => {
      result.current.persistRowGroupOrder([{ id: 'm1', entry: null }]);
    });
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledWith('srv-1', {
        metadata: {
          group_order_key: null,
          group_order_rev: null,
          group_order_actor: null,
        },
      }),
    );
  });

  it('a queued triple CLEAR survives reload (migration keeps groupOrder: null)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    localStorage.setItem(compositeKey, JSON.stringify({
      measurements: [{ ...makeMeasurement('m1'), serverId: 'srv-1' }],
      scale: defaultScale,
      savedAt: 1,
      orderQueue: [{ id: 'm1', field: 'group_order', groupOrder: null }],
      pendingOrderKeys: ['group_order:m1'],
    }));
    (takeoffApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      groupRow('srv-1', 'm1', 'General', '2026-07-19T10:00:00Z'),
    ]);
    const setM = vi.fn();
    renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: [],
        setMeasurements: setM, pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await waitFor(() => expect(setM).toHaveBeenCalled());
    await waitFor(() =>
      expect(takeoffApi.update).toHaveBeenCalledWith('srv-1', {
        metadata: {
          group_order_key: null,
          group_order_rev: null,
          group_order_actor: null,
        },
      }),
    );
  });

  it('persistRowGroupOrder dedups an identical queued write (down server)', async () => {
    const { takeoffApi } = await import('@/features/takeoff/api');
    (takeoffApi.update as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('down'),
    );
    const rows = [{ ...makeMeasurement('m1'), serverId: 'srv-1' }];
    const { result } = renderHook(() =>
      useMeasurementPersistence({
        fileName: 'go.pdf', documentId: DOC, measurements: rows,
        setMeasurements: vi.fn(), pageScales: basePageScales, setPageScales: vi.fn(),
        scale: defaultScale, projectId: PROJECT,
      }),
    );
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      result.current.persistRowGroupOrder([{ id: 'm1', entry: null }]);
      await Promise.resolve();
    });
    await act(async () => {
      result.current.persistRowGroupOrder([{ id: 'm1', entry: null }]);
      await Promise.resolve();
    });
    act(() => { result.current.saveNow(); });
    const payload = JSON.parse(localStorage.getItem(compositeKey)!);
    expect(
      payload.orderQueue.filter(
        (e: { id: string; field: string }) => e.id === 'm1' && e.field === 'group_order',
      ),
    ).toHaveLength(1);
  });
});
