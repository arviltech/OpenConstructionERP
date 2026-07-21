// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Shared takeoff types — kept here (not in the module) so lib helpers and
 * tests can import without pulling the whole TakeoffViewerModule graph.
 *
 * Mirrors the types defined in
 * `frontend/src/modules/pdf-takeoff/TakeoffViewerModule.tsx`.
 */

export type MeasureTool =
  | 'select'
  | 'distance'
  | 'polyline'
  | 'area'
  // Measured rectangle: a 2-click area tool that produces a `type: 'area'`
  // measurement (it is a tool, never a stored measurement type).
  | 'rectarea'
  | 'volume'
  | 'count'
  | 'cloud'
  | 'arrow'
  | 'text'
  | 'rectangle'
  | 'highlight';

export type MeasurementType =
  | 'distance'
  | 'polyline'
  | 'area'
  | 'volume'
  | 'count'
  | 'cloud'
  | 'arrow'
  | 'text'
  | 'rectangle'
  | 'highlight';

export interface Point {
  x: number;
  y: number;
}

export interface Measurement {
  id: string;
  type: MeasurementType;
  points: Point[];
  value: number;
  unit: string;
  label: string;
  annotation: string;
  page: number;
  group: string;
  depth?: number;
  area?: number;
  text?: string;
  color?: string;
  width?: number;
  height?: number;
  /** Per-measurement fill opacity override (issue #311, 0..1). */
  fillAlpha?: number;
  /** Per-measurement stroke width override in CSS px (issue #312). */
  strokeWidth?: number;
  /** Per-measurement STROKE (line) opacity override for LINEAR types
   *  (distance, polyline), 0..1 (issue #332). Undefined = fully opaque, so a
   *  measurement drawn before this field existed renders exactly as before. */
  strokeAlpha?: number;
  /** True-surface slope / pitch factor for an AREA measurement (roofs, ramps):
   *  true surface qty = plan area x slopeFactor (>= 1). Undefined = 1 (flat). */
  slopeFactor?: number;
  /** Material wastage / allowance percent added on top of the reported
   *  quantity (e.g. 10 = +10%). Undefined = 0 (no allowance). */
  wastagePct?: number;
  /** Typical-multiplier: this measurement stands for N identical repeats
   *  (typical floors / bays). Effective qty = base x multiplier. Undefined = 1. */
  multiplier?: number;
  /** Free-form notes entered via the properties panel. */
  notes?: string;
  /** Opening deduction: an `area` measurement representing a void (door,
   *  window, cut-out) whose area is subtracted from its group's gross
   *  area so net = gross - openings. Stored as a positive gross area. */
  isDeduction?: boolean;
  serverId?: string;
  linkedPositionId?: string;
  linkedPositionOrdinal?: string;
  linkedBoqId?: string;
  linkedPositionLabel?: string;
  /** AI-suggested but unconfirmed (issue #194 Recognize); never persisted
   *  until accepted (which clears the flag). */
  suggested?: boolean;
  /** Recognition confidence 0..1 on AI-sourced measurements. */
  confidence?: number;
  /** ISO creation stamp carried in memory for the canonical ordering
   *  tie-break (server rows map it from `created_at`; in-session creates
   *  stamp it at build time). Display-only ordering data — never sent to
   *  the server, which keeps its own authoritative `created_at`. */
  createdAt?: string;
  /** Persisted z/list-order key (`metadata.order_key`): a fractional index
   *  compared by plain codepoint order. Absent on rows that were never
   *  explicitly placed — keyless rows sort after every keyed row, in
   *  creation order (the append semantic). See lib/order-key.ts. */
  orderKey?: string;
  /** This row's GROUP's persisted band-order triple
   *  (`metadata.group_order_key/_rev/_actor`), mirrored onto every member
   *  row because groups have no server entity. Must be re-stamped to the
   *  destination band's entry (or cleared) whenever the row changes group —
   *  a stale triple riding along re-teaches the map the old band's key for
   *  the new group. See lib/group-order.ts. */
  groupOrder?: import('./group-order').GroupOrderEntry;
}

/** Describes a reversible measurement operation for the undo stack. */
export type UndoOperation =
  | { kind: 'add_point'; tool: MeasureTool; point: Point }
  | {
      kind: 'complete_measurement';
      measurement: Measurement;
      previousActivePoints: Point[];
    }
  | {
      kind: 'add_count_point';
      measurementId: string;
      point: Point;
      wasNew: boolean;
      previousMeasurement: Measurement | null;
    }
  | { kind: 'delete_measurement'; measurement: Measurement }
  | {
      kind: 'change_annotation';
      measurementId: string;
      previousAnnotation: string;
    }
  | {
      kind: 'move_measurement';
      measurementId: string;
      previousGroup: string;
      /** The row's post-materialization key at its OLD position (a group
       *  move materializes keys first, so this is never undefined for a
       *  placed move; group-only moves record the key the row already had,
       *  if any). Undo restores it and lets the comparator re-place the row;
       *  no numeric index is stored (indexes go stale under edits). */
      previousOrderKey?: string;
    };
