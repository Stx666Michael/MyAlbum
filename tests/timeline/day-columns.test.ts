import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../server/app.ts';
import { buildTimelineDayColumns, buildVirtualStringItems, computeFlowingCardState } from '../../src/utils/timelineMath.ts';

describe('Timeline: day columns, spacing modes, and loop transitions', () => {
  const app = createApiApp();

  it('computes timeline columns (oldest left -> newest right, newest top -> oldest bottom), spacing modes, and downward infinite loop transitions', async () => {
    const demoRes = await request(app).post('/api/demo').send({});
    const photos = demoRes.body.photos;

    const compactCols = buildTimelineDayColumns(photos, 'compact', 256);
    const propCols = buildTimelineDayColumns(photos, 'proportional', 256);

    expect(compactCols.length).toBe(9);
    // Verify chronological left-to-right ordering of days
    for (let i = 1; i < compactCols.length; i++) {
      expect(compactCols[i].dayKey > compactCols[i - 1].dayKey).toBe(true);
      expect(compactCols[i].xOffsetPx - compactCols[i - 1].xOffsetPx).toBe(256);
      // Adjacent columns have different flow speeds
      expect(compactCols[i].speedPxPerSec).not.toBe(compactCols[i - 1].speedPxPerSec);
    }

    // Verify proportional mode expands multi-day gaps compared to 1-day gap
    const oneDayGap = propCols[1].xOffsetPx - propCols[0].xOffsetPx; // 2025-03-14 -> 2025-03-15 (1 day)
    const multiMonthGap = propCols[2].xOffsetPx - propCols[1].xOffsetPx; // 2025-03-15 -> 2025-05-20 (66 days)
    expect(oneDayGap).toBe(256);
    expect(multiMonthGap).toBeGreaterThan(oneDayGap + 300);

      // Verify within each day column, photos are sorted newest (top, index 0) to oldest (bottom, index N-1)
    for (const col of compactCols) {
      for (let j = 1; j < col.photos.length; j++) {
        const prevMs = new Date(col.photos[j - 1].timestamp).getTime();
        const currMs = new Date(col.photos[j].timestamp).getTime();
        expect(currMs).toBeLessThanOrEqual(prevMs);
      }
    }

    // Verify deterministic tie-breaking when two photos share the exact same timestamp
    const tiePhotos = [
      { id: 't1', timestamp: '2025-06-01T12:00:00.000Z', fileName: 'alpha.jpg' },
      { id: 't2', timestamp: '2025-06-01T12:00:00.000Z', fileName: 'zeta.jpg' },
      { id: 't3', timestamp: '2025-06-01T15:30:00.000Z', fileName: 'mid.jpg' },
    ] as any[];
    const tieCols = buildTimelineDayColumns(tiePhotos, 'compact', 256);
    expect(tieCols.length).toBe(1);
    expect(tieCols[0].photos.map((p) => p.id)).toEqual(['t3', 't2', 't1']);

    // Verify downward flow, initial top-to-bottom placement (#1 newest at top), and smooth entry/exit transitions
    const col0 = compactCols[0];
    const { items } = buildVirtualStringItems(col0.photos, 640, 192);
    const firstCardAt0 = computeFlowingCardState(0, items.length, 0, 640, 192);
    const secondCardAt0 = computeFlowingCardState(1, items.length, 0, 640, 192);
    const lastCardAt0 = computeFlowingCardState(items.length - 1, items.length, 0, 640, 192);

    // Photo #1 (virtualIndex 0) starts right at the top of the visible string (y = 24)
    expect(firstCardAt0.y).toBe(24);
    expect(firstCardAt0.opacity).toBe(1);
    // Photo #2 (virtualIndex 1) is directly below Photo #1
    expect(secondCardAt0.y).toBe(24 + 192);
    expect(secondCardAt0.y).toBeGreaterThan(firstCardAt0.y);
    // The last virtual item is queued above the top entry zone ready to flow in
    expect(lastCardAt0.y).toBe(24 - 192);

    const stateAt50 = computeFlowingCardState(1, items.length, 50, 640, 192);
    expect(stateAt50.y).toBeGreaterThan(secondCardAt0.y); // Flows downwards (+y)
    expect(stateAt50.opacity).toBe(1);
    expect(stateAt50.scale).toBe(1);
  });
});
