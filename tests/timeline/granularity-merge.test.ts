import { describe, it, expect } from 'vitest';
import {
  BASE_TIME_CARD_HEIGHT_PX,
  BASE_TIME_CARD_WIDTH_PX,
  MAX_TIMELINE_ZOOM,
  MIN_TIME_CARD_WIDTH_PX,
  MIN_TIMELINE_ZOOM,
  buildTimelineDayColumns,
  computeStringGranularityTransition,
  getTimelineZoomMetrics,
  resolveTimelineGranularity,
} from '../../src/utils/timelineMath.ts';

describe('Timeline: granularity merging on zoom', () => {
  it('merges timeline strings from daily -> weekly -> monthly -> yearly when zooming out makes time cards too small', () => {
    // 1. Verify granularity thresholds & card resizing metrics
    expect(resolveTimelineGranularity(1.0)).toBe('day');
    expect(resolveTimelineGranularity(0.70)).toBe('day');
    // At zoom = 0.60, raw daily width is 216 * 0.60 = 129.6px (< 146px min), so it merges to 'week'
    expect(resolveTimelineGranularity(0.60)).toBe('week');
    expect(resolveTimelineGranularity(0.50)).toBe('week');
    // At zoom = 0.40, weekly width is 216 * 0.40 * 1.44 = 124.4px (< 146px min), so it merges to 'month'
    expect(resolveTimelineGranularity(0.40)).toBe('month');
    expect(resolveTimelineGranularity(0.30)).toBe('month');
    // At zoom = 0.20, monthly width is 216 * 0.20 * 2.25 = 97.2px (< 146px min), so it merges to 'year'
    expect(resolveTimelineGranularity(0.20)).toBe('year');

    const metricsZoom100 = getTimelineZoomMetrics(1.0);
    const metricsZoom80 = getTimelineZoomMetrics(0.8);
    expect(metricsZoom100.granularity).toBe('day');
    expect(metricsZoom80.granularity).toBe('day');
    expect(metricsZoom100.columnWidthPx).toBe(BASE_TIME_CARD_WIDTH_PX);
    expect(metricsZoom100.cardHeightPx).toBe(BASE_TIME_CARD_HEIGHT_PX);
    expect(metricsZoom100.cardSlotHeightPx).toBe(192);
    // Zooming within the same granularity band resizes the time card and photo card slot height proportionally
    expect(metricsZoom80.columnWidthPx).toBeLessThan(metricsZoom100.columnWidthPx);
    expect(metricsZoom80.cardHeightPx).toBeLessThan(metricsZoom100.cardHeightPx);
    expect(metricsZoom80.cardSlotHeightPx).toBeLessThan(metricsZoom100.cardSlotHeightPx);
    expect(metricsZoom80.columnWidthPx).toBeGreaterThanOrEqual(MIN_TIME_CARD_WIDTH_PX);

    // When zooming out triggers a merge (e.g. zoom = 0.55 -> 'week'), the merged time card stays readable (>= MIN_TIME_CARD_WIDTH_PX)
    const metricsZoom55 = getTimelineZoomMetrics(0.55);
    expect(metricsZoom55.granularity).toBe('week');
    expect(metricsZoom55.columnWidthPx).toBeGreaterThanOrEqual(MIN_TIME_CARD_WIDTH_PX);

    const metricsZoom35 = getTimelineZoomMetrics(0.35);
    expect(metricsZoom35.granularity).toBe('month');
    expect(metricsZoom35.columnWidthPx).toBeGreaterThanOrEqual(MIN_TIME_CARD_WIDTH_PX);

    // Extreme and non-finite zoom values are safely clamped/guarded
    expect(getTimelineZoomMetrics(0.01).zoom).toBe(MIN_TIMELINE_ZOOM);
    expect(getTimelineZoomMetrics(9.99).zoom).toBe(MAX_TIMELINE_ZOOM);
    expect(resolveTimelineGranularity(Number.NaN)).toBe('day');
    expect(getTimelineZoomMetrics(Number.NaN).zoom).toBe(1);
    expect(Number.isFinite(getTimelineZoomMetrics(Number.NaN).columnWidthPx)).toBe(true);

    // 2. Verify multi-granularity bucket merging across a multi-year, multi-month, multi-week, multi-day dataset
    const samplePhotos = [
      // 2024-11-04 (Mon) & 2024-11-05 (Tue) -> same ISO week (2024-W45), same month (2024-11), year 2024
      { id: 'p1', timestamp: '2024-11-04T08:30:00.000Z', fileName: 'p1.jpg' },
      { id: 'p2', timestamp: '2024-11-05T19:15:00.000Z', fileName: 'p2.jpg' },
      // 2024-11-18 (Mon) -> different ISO week (2024-W47), same month (2024-11), year 2024
      { id: 'p3', timestamp: '2024-11-18T11:00:00.000Z', fileName: 'p3.jpg' },
      // 2025-03-14 (Fri) & 2025-03-15 (Sat) -> same ISO week (2025-W11), same month (2025-03), year 2025
      { id: 'p4', timestamp: '2025-03-14T09:00:00.000Z', fileName: 'p4.jpg' },
      { id: 'p5', timestamp: '2025-03-15T14:20:00.000Z', fileName: 'p5.jpg' },
      // 2025-03-25 (Tue) -> different ISO week (2025-W13), same month (2025-03), year 2025
      { id: 'p6', timestamp: '2025-03-25T16:45:00.000Z', fileName: 'p6.jpg' },
      // 2025-07-11 (Fri) -> 2025-W28, month 2025-07, year 2025
      { id: 'p7', timestamp: '2025-07-11T10:10:00.000Z', fileName: 'p7.jpg' },
    ] as any[];

    const dayCols = buildTimelineDayColumns(samplePhotos, 'compact', 256, 'day');
    const weekCols = buildTimelineDayColumns(samplePhotos, 'compact', 256, 'week');
    const monthCols = buildTimelineDayColumns(samplePhotos, 'compact', 256, 'month');
    const yearCols = buildTimelineDayColumns(samplePhotos, 'compact', 256, 'year');

    // 7 distinct days -> 5 distinct weeks -> 3 distinct months -> 2 distinct years
    expect(dayCols.length).toBe(7);
    expect(weekCols.length).toBe(5);
    expect(monthCols.length).toBe(3);
    expect(yearCols.length).toBe(2);

    // Total photos across columns is always preserved and sorted newest (top) -> oldest (bottom) inside every merged bucket
    for (const cols of [dayCols, weekCols, monthCols, yearCols]) {
      const total = cols.reduce((acc, c) => acc + c.photos.length, 0);
      expect(total).toBe(samplePhotos.length);
      for (let i = 1; i < cols.length; i++) {
        expect(cols[i].dayKey > cols[i - 1].dayKey).toBe(true);
        expect(cols[i].xOffsetPx).toBeGreaterThan(cols[i - 1].xOffsetPx);
      }
      for (const col of cols) {
        for (let j = 1; j < col.photos.length; j++) {
          const prevMs = new Date(col.photos[j - 1].timestamp).getTime();
          const currMs = new Date(col.photos[j].timestamp).getTime();
          expect(currMs).toBeLessThanOrEqual(prevMs);
        }
      }
    }

    // Proportional spacing works cleanly across all granularities
    const propWeekCols = buildTimelineDayColumns(samplePhotos, 'proportional', 256, 'week');
    const propMonthCols = buildTimelineDayColumns(samplePhotos, 'proportional', 256, 'month');
    const propYearCols = buildTimelineDayColumns(samplePhotos, 'proportional', 256, 'year');
    expect(propWeekCols.length).toBe(5);
    expect(propMonthCols.length).toBe(3);
    expect(propMonthCols[1].gapLabel).toBe('+4mo gap');
    expect(propYearCols.length).toBe(2);
    expect(propYearCols[1].unitGapSincePrev).toBe(1);

    // 3. Verify ISO week-year boundary merging (Dec 30 & Dec 31, 2024 fall in ISO Week 1 of 2025 alongside Jan 1, 2025)
    // Ordered newest (top, b3) -> oldest (bottom, b1)
    const boundaryPhotos = [
      { id: 'b1', timestamp: '2024-12-30T10:00:00.000Z', fileName: 'b1.jpg' },
      { id: 'b2', timestamp: '2024-12-31T22:00:00.000Z', fileName: 'b2.jpg' },
      { id: 'b3', timestamp: '2025-01-01T08:00:00.000Z', fileName: 'b3.jpg' },
    ] as any[];
    const boundaryWeeks = buildTimelineDayColumns(boundaryPhotos, 'compact', 256, 'week');
    expect(boundaryWeeks.length).toBe(1);
    expect(boundaryWeeks[0].dayKey).toBe('2025-W01');
    expect(boundaryWeeks[0].displayDate).toBe('Dec 30, 2024 – Jan 5, 2025');
    expect(boundaryWeeks[0].photos.map((p) => p.id)).toEqual(['b3', 'b2', 'b1']);

    // 4. Verify computeStringGranularityTransition for merge (day -> week), unmerge (week -> day), and steady (day -> day)
    expect(computeStringGranularityTransition(dayCols, dayCols, 'day', 'day').mode).toBeNull();
    expect(computeStringGranularityTransition([], weekCols, 'day', 'week').mode).toBeNull();
    expect(computeStringGranularityTransition(dayCols, [], 'day', 'week').mode).toBeNull();

    const mergeTransition = computeStringGranularityTransition(dayCols, weekCols, 'day', 'week');
    expect(mergeTransition.mode).toBe('merge');

    // Multiple daily columns (2024-11-04 & 2024-11-05 -> 2024-W45; 2025-03-14 & 2025-03-15 -> 2025-W11) coalesce
    const mergedWeek45 = mergeTransition.enteringByKey['2024-W45'];
    expect(mergedWeek45).toBeDefined();
    expect(mergedWeek45.sourceKeys).toEqual(['2024-11-04', '2024-11-05']);
    expect(mergedWeek45.mergedCount).toBe(2);
    const expectedCentroidW45 = Math.round((dayCols[0].xOffsetPx + dayCols[1].xOffsetPx) / 2);
    expect(mergedWeek45.fromXOffsetPx).toBe(expectedCentroidW45);
    expect(mergedWeek45.deltaXPx).toBe(expectedCentroidW45 - weekCols[0].xOffsetPx);
    expect(mergedWeek45.deltaXPx).toBeGreaterThan(0);

    const mergedWeek11 = mergeTransition.enteringByKey['2025-W11'];
    expect(mergedWeek11).toBeDefined();
    expect(mergedWeek11.sourceKeys).toEqual(['2025-03-14', '2025-03-15']);
    expect(mergedWeek11.mergedCount).toBe(2);
    const expectedCentroidW11 = Math.round((dayCols[3].xOffsetPx + dayCols[4].xOffsetPx) / 2);
    expect(mergedWeek11.fromXOffsetPx).toBe(expectedCentroidW11);
    expect(mergedWeek11.deltaXPx).toBe(expectedCentroidW11 - weekCols[2].xOffsetPx);
    expect(mergedWeek11.deltaXPx).toBeGreaterThan(0);

    // Every previous daily column emits an ExitingGhostColumn pointing to its merged week column
    expect(mergeTransition.exitingGhosts.length).toBe(dayCols.length);
    const ghostDay0 = mergeTransition.exitingGhosts.find((g) => g.col.dayKey === '2024-11-04')!;
    expect(ghostDay0.targetKey).toBe('2024-W45');
    expect(ghostDay0.targetXOffsetPx).toBe(weekCols[0].xOffsetPx);
    expect(ghostDay0.deltaXPx).toBe(0);

    const ghostDay1 = mergeTransition.exitingGhosts.find((g) => g.col.dayKey === '2024-11-05')!;
    expect(ghostDay1.targetKey).toBe('2024-W45');
    expect(ghostDay1.targetXOffsetPx).toBe(weekCols[0].xOffsetPx);
    expect(ghostDay1.deltaXPx).toBe(weekCols[0].xOffsetPx - dayCols[1].xOffsetPx);
    expect(ghostDay1.deltaXPx).toBeLessThan(0);

    // Unmerge (week -> day) maps each split daily column back to its parent weekly column's xOffsetPx
    const unmergeTransition = computeStringGranularityTransition(weekCols, dayCols, 'week', 'day');
    expect(unmergeTransition.mode).toBe('unmerge');

    for (const dayKey of ['2025-03-14', '2025-03-15']) {
      const splitDay = unmergeTransition.enteringByKey[dayKey];
      expect(splitDay).toBeDefined();
      expect(splitDay.sourceKeys).toEqual(['2025-W11']);
      expect(splitDay.fromXOffsetPx).toBe(weekCols[2].xOffsetPx);
      const targetDayCol = dayCols.find((c) => c.dayKey === dayKey)!;
      expect(splitDay.deltaXPx).toBe(weekCols[2].xOffsetPx - targetDayCol.xOffsetPx);
    }
    expect(unmergeTransition.enteringByKey['2025-03-15'].deltaXPx).toBeLessThan(0);
    expect(unmergeTransition.exitingGhosts.length).toBe(weekCols.length);

    // Photo-count-weighted centroid when merging columns have unequal photo counts (3 photos vs 1 photo)
    const weightedPhotos = [
      { id: 'w1', timestamp: '2025-03-10T09:00:00.000Z', fileName: 'w1.jpg' },
      { id: 'w2', timestamp: '2025-03-10T10:00:00.000Z', fileName: 'w2.jpg' },
      { id: 'w3', timestamp: '2025-03-10T11:00:00.000Z', fileName: 'w3.jpg' },
      { id: 'w4', timestamp: '2025-03-12T15:00:00.000Z', fileName: 'w4.jpg' },
    ] as any[];
    const wDayCols = buildTimelineDayColumns(weightedPhotos, 'compact', 256, 'day');
    const wWeekCols = buildTimelineDayColumns(weightedPhotos, 'compact', 256, 'week');
    const wMerge = computeStringGranularityTransition(wDayCols, wWeekCols, 'day', 'week');
    const expectedWeightedFromX = Math.round(
      (wDayCols[0].xOffsetPx * 3 + wDayCols[1].xOffsetPx * 1) / 4
    );
    expect(wMerge.enteringByKey['2025-W11'].fromXOffsetPx).toBe(expectedWeightedFromX);
    expect(wMerge.enteringByKey['2025-W11'].fromXOffsetPx).toBeLessThan(
      Math.round((wDayCols[0].xOffsetPx + wDayCols[1].xOffsetPx) / 2)
    );
  });
});
