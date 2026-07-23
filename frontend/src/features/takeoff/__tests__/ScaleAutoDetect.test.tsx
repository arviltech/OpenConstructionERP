// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Tests for the self-contained scale auto-detect widget:
 *   1. While the detect request is in flight it renders nothing.
 *   2. When a scale is found it shows "Detected scale: 1:100" + evidence and a
 *      "Use this" button that calls onApply with the canonical preset scale.
 *   3. A candidate on the current page is preferred over the document-wide best.
 *   4. A null best -> renders nothing (quiet; never blocks the host).
 *   5. A fetch error -> renders nothing and never throws.
 *   6. A disabled module (null response) -> renders nothing.
 *   7. An invalid detected ratio is refused (never applied).
 *
 * The widget only ever produces output in the actionable "found" state; every
 * idle state (in flight, no scale note, failed, disabled) renders null so it
 * occupies no space on an uncalibrated page. The host mounts it only while the
 * page is uncalibrated, so a found suggestion also disappears once a scale is
 * set - that gate lives in the viewer and is covered by live smoke, not here.
 */

// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScaleAutoDetect } from '../components/ScaleAutoDetect';
import { takeoffApi } from '../api';
import { presetScale } from '../../../modules/pdf-takeoff/data/scale-helpers';

function candidate(over = {}) {
  return {
    ratio: 100,
    label: '1:100',
    confidence: 0.95,
    page: 1,
    evidence: 'SCALE 1:100',
    source: 'ratio',
    detail: {},
    ...over,
  };
}

describe('ScaleAutoDetect', () => {
  it('renders nothing while detection is in flight', () => {
    vi.spyOn(takeoffApi, 'detectScale').mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <ScaleAutoDetect documentId="doc-1" pageNumber={1} onApply={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('scale-autodetect-found')).toBeNull();
  });

  it('shows the detected scale and applies the canonical preset on click', async () => {
    const onApply = vi.fn();
    vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue({
      best: candidate(),
      candidates: [candidate()],
      source: 'text_layer',
    });
    render(<ScaleAutoDetect documentId="doc-1" pageNumber={1} onApply={onApply} />);

    const useBtn = await screen.findByTestId('scale-autodetect-use');
    expect(screen.getByTestId('scale-autodetect-found').textContent).toContain('1:100');
    expect(screen.getByTestId('scale-autodetect-evidence').textContent).toContain('SCALE 1:100');

    fireEvent.click(useBtn);
    expect(onApply).toHaveBeenCalledTimes(1);
    const scale = onApply.mock.calls[0][0];
    expect(scale.pixelsPerUnit).toBeCloseTo(presetScale(100).pixelsPerUnit, 6);
    expect(scale.unitLabel).toBe('m');
    expect(scale.invalid).toBeFalsy();
  });

  it('prefers a candidate on the current page over the document-wide best', async () => {
    const onApply = vi.fn();
    vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue({
      best: candidate({ ratio: 100, label: '1:100', page: 1 }),
      candidates: [
        candidate({ ratio: 100, label: '1:100', page: 1 }),
        candidate({ ratio: 20, label: '1:20', page: 3, evidence: 'SCALE 1:20' }),
      ],
      source: 'text_layer',
    });
    render(<ScaleAutoDetect documentId="doc-1" pageNumber={3} onApply={onApply} />);

    await screen.findByTestId('scale-autodetect-use');
    expect(screen.getByTestId('scale-autodetect-found').textContent).toContain('1:20');
    fireEvent.click(screen.getByTestId('scale-autodetect-use'));
    const scale = onApply.mock.calls[0][0];
    expect(scale.pixelsPerUnit).toBeCloseTo(presetScale(20).pixelsPerUnit, 6);
  });

  it('renders nothing when no scale is detected', async () => {
    const detect = vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue({
      best: null,
      candidates: [],
      source: 'text_layer',
    });
    const { container } = render(<ScaleAutoDetect documentId="doc-1" onApply={vi.fn()} />);
    await waitFor(() => expect(detect).toHaveBeenCalled());
    expect(screen.queryByTestId('scale-autodetect-found')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing (no throw) when detection fails', async () => {
    const detect = vi.spyOn(takeoffApi, 'detectScale').mockRejectedValue(new Error('network'));
    const { container } = render(<ScaleAutoDetect documentId="doc-1" onApply={vi.fn()} />);
    await waitFor(() => expect(detect).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('scale-autodetect-found')).toBeNull();
  });

  it('renders nothing when the module is disabled (null response)', async () => {
    const detect = vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue(null);
    const { container } = render(<ScaleAutoDetect documentId="doc-1" onApply={vi.fn()} />);
    await waitFor(() => expect(detect).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('does not call onApply for an invalid detected ratio', async () => {
    const onApply = vi.fn();
    // ratio 0 -> presetScale returns an invalid config; the widget must refuse.
    vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue({
      best: candidate({ ratio: 0, label: '1:0' }),
      candidates: [candidate({ ratio: 0, label: '1:0' })],
      source: 'text_layer',
    });
    render(<ScaleAutoDetect documentId="doc-1" onApply={onApply} />);
    const useBtn = await screen.findByTestId('scale-autodetect-use');
    fireEvent.click(useBtn);
    expect(onApply).not.toHaveBeenCalled();
  });
});
