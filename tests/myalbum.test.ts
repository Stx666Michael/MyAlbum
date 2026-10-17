import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import exifr from 'exifr';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-expect-error jsdom package has no bundled type declarations
import { JSDOM } from 'jsdom';
import { createApiApp } from '../server/app.ts';
import { injectExifIntoJpeg } from '../server/exifWriter.ts';
import {
  BASE_TIME_CARD_HEIGHT_PX,
  BASE_TIME_CARD_WIDTH_PX,
  FAST_STRING_FLOW_MULTIPLIER,
  MAX_TIMELINE_ZOOM,
  MIN_TIME_CARD_WIDTH_PX,
  MIN_TIMELINE_ZOOM,
  STRING_END_ZONE_HEIGHT_PX,
  buildTimelineDayColumns,
  buildVirtualStringItems,
  clampTimelinePanX,
  computeCenteredTimelinePanX,
  computeFlowingCardState,
  computeStringFlowVelocity,
  getTimelineZoomMetrics,
  resolveStringEndHoverDirection,
  resolveTimelineGranularity,
} from '../src/utils/timelineMath.ts';
import {
  createPhotoSupercluster,
  queryMapClusters,
} from '../src/utils/mapClusters.ts';
import { TimelineView } from '../src/components/TimelineView.tsx';

describe('MyAlbum Full-Stack Verification Suite', () => {
  const app = createApiApp();
  let tempDir = '';

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myalbum-test-'));
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('embeds binary EXIF + GPS into JPEG and parses back accurately via exifr', async () => {
    const rawJpeg = await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: { r: 20, g: 60, b: 120 },
      },
    })
      .jpeg()
      .toBuffer();

    const jpegWithExif = injectExifIntoJpeg(rawJpeg, {
      make: 'Hasselblad',
      model: 'X2D 100C',
      lensModel: 'XCD 55mm f/2.5V',
      dateTimeOriginal: '2025-05-20T16:45:30.000Z',
      exposureTime: [1, 500],
      fNumber: 2.5,
      iso: 64,
      focalLength: 55,
      width: 320,
      height: 240,
      lat: -33.8568,
      lng: 151.2153,
    });

    const parsed = await exifr.parse(jpegWithExif, { tiff: true, exif: true, gps: true });
    expect(parsed.Make).toBe('Hasselblad');
    expect(parsed.Model).toBe('X2D 100C');
    expect(parsed.LensModel).toBe('XCD 55mm f/2.5V');
    expect(parsed.ISO).toBe(64);
    expect(parsed.FNumber).toBeCloseTo(2.5, 1);
    expect(parsed.FocalLength).toBeCloseTo(55, 1);
    expect(parsed.latitude).toBeCloseTo(-33.8568, 3);
    expect(parsed.longitude).toBeCloseTo(151.2153, 3);
  });

  it('generates and scans the built-in Demo Album with nested subfolders via POST /api/demo', async () => {
    const res = await request(app)
      .post('/api/demo')
      .send({ reset: true })
      .expect(200);

    expect(res.body.totalCount).toBe(52);
    expect(res.body.locatedCount).toBe(48);
    expect(res.body.subfolders.length).toBeGreaterThanOrEqual(8);
    expect(res.body.subfolders).toContain('2025-03-Tokyo-Spring/Day1-Shibuya');
    expect(res.body.subfolders).toContain('2025-07-Iceland-Highlands/South-Coast');

    const firstPhoto = res.body.photos[0];
    expect(firstPhoto.exif.make).toBeTruthy();
    expect(firstPhoto.exif.model).toBeTruthy();
    expect(firstPhoto.exif.fNumber).toBeGreaterThan(0);

    // Verify /api/photo streams the generated JPEG image
    const imgRes = await request(app)
      .get('/api/photo')
      .query({ path: firstPhoto.fullPath })
      .expect(200);
    expect(imgRes.headers['content-type']).toContain('image/jpeg');
    expect(imgRes.body[0]).toBe(0xff);
    expect(imgRes.body[1]).toBe(0xd8);
  }, 30000);

  it('recursively scans nested subfolders and supports batch time & location edits with sidecar persistence', async () => {
    const subA = path.join(tempDir, 'Trip-2025', 'Day1');
    const subB = path.join(tempDir, 'Trip-2025', 'Day2');
    await fs.mkdir(subA, { recursive: true });
    await fs.mkdir(subB, { recursive: true });

    const baseJpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 80, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    const p1 = injectExifIntoJpeg(baseJpeg, {
      make: 'Sony',
      model: 'A7RV',
      dateTimeOriginal: '2025-04-10T09:00:00.000Z',
      lat: 35.68,
      lng: 139.76,
    });
    const p2 = injectExifIntoJpeg(baseJpeg, {
      make: 'Sony',
      model: 'A7RV',
      dateTimeOriginal: '2025-04-10T14:30:00.000Z',
      lat: 35.69,
      lng: 139.77,
    });
    const p3 = injectExifIntoJpeg(baseJpeg, {
      make: 'Leica',
      model: 'Q3',
      dateTimeOriginal: '2025-04-12T11:15:00.000Z',
      // No GPS on p3 initially
    });

    await fs.writeFile(path.join(subA, 'morning.jpg'), p1);
    await fs.writeFile(path.join(subA, 'afternoon.jpg'), p2);
    await fs.writeFile(path.join(subB, 'studio.jpg'), p3);

    // 1. Initial scan
    const scanRes = await request(app)
      .post('/api/scan')
      .send({ folderPath: tempDir })
      .expect(200);

    expect(scanRes.body.totalCount).toBe(3);
    expect(scanRes.body.locatedCount).toBe(2);
    expect(scanRes.body.subfolders).toEqual(['Trip-2025/Day1', 'Trip-2025/Day2']);

    const ids = scanRes.body.photos.map((p: any) => p.id);
    const intervalBefore =
      new Date(scanRes.body.photos[1].timestamp).getTime() -
      new Date(scanRes.body.photos[0].timestamp).getTime();

    // 2. Batch shift time by +3 hours (+10,800,000 ms) on first two photos
    const shiftRes = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: tempDir,
        photoIds: [ids[0], ids[1]],
        timeEdit: { mode: 'offset', offsetMs: 3 * 3600 * 1000 },
      })
      .expect(200);

    const shifted0 = shiftRes.body.photos.find((p: any) => p.id === ids[0]);
    const shifted1 = shiftRes.body.photos.find((p: any) => p.id === ids[1]);
    expect(shifted0.timestamp).toBe('2025-04-10T12:00:00.000Z');
    expect(shifted1.timestamp).toBe('2025-04-10T17:30:00.000Z');
    expect(shifted0.isTimeEdited).toBe(true);
    expect(shifted0.originalTimestamp).toBe('2025-04-10T09:00:00.000Z');
    // Interval between photos must be strictly preserved
    const intervalAfter =
      new Date(shifted1.timestamp).getTime() - new Date(shifted0.timestamp).getTime();
    expect(intervalAfter).toBe(intervalBefore);

    // 3. Batch set exact timestamp with stepMinutes = 15
    const exactRes = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: tempDir,
        photoIds: [ids[0], ids[1]],
        timeEdit: {
          mode: 'exact',
          timestamp: '2025-06-01T08:00:00.000Z',
          stepMinutes: 15,
        },
      })
      .expect(200);

    const exact0 = exactRes.body.photos.find((p: any) => p.id === ids[0]);
    const exact1 = exactRes.body.photos.find((p: any) => p.id === ids[1]);
    expect(exact0.timestamp).toBe('2025-06-01T08:00:00.000Z');
    expect(exact1.timestamp).toBe('2025-06-01T08:15:00.000Z');

    // 4. Batch assign location to unlocated photo p3
    const addLocRes = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: tempDir,
        photoIds: [ids[2]],
        locationEdit: {
          mode: 'set',
          location: { lat: 48.8584, lng: 2.2945, name: 'Tour Eiffel, Paris' },
        },
      })
      .expect(200);

    expect(addLocRes.body.locatedCount).toBe(3);
    const updatedP3 = addLocRes.body.photos.find((p: any) => p.id === ids[2]);
    expect(updatedP3.location).toEqual({
      lat: 48.8584,
      lng: 2.2945,
      name: 'Tour Eiffel, Paris',
    });

    // 5. Batch remove location from all 3 photos
    const remLocRes = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: tempDir,
        photoIds: ids,
        locationEdit: { mode: 'remove' },
      })
      .expect(200);

    expect(remLocRes.body.locatedCount).toBe(0);
    const removedP1 = remLocRes.body.photos.find((p: any) => p.id === ids[0]);
    expect(removedP1.location).toBeNull();
    expect(removedP1.originalLocation).not.toBeNull();

    // 6. Restore original metadata
    const restoreRes = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: tempDir,
        photoIds: ids,
        timeEdit: { mode: 'restore' },
        locationEdit: { mode: 'restore' },
      })
      .expect(200);

    expect(restoreRes.body.locatedCount).toBe(2);
    const restoredP1 = restoreRes.body.photos.find((p: any) => p.id === ids[0]);
    expect(restoredP1.timestamp).toBe('2025-04-10T09:00:00.000Z');
    expect(restoredP1.isEdited).toBe(false);
  });

  it('computes timeline columns (oldest left -> newest right, morning top -> night bottom), spacing modes, and downward infinite loop transitions', async () => {
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

    // Verify within each day column, photos are sorted oldest (top) to newest (bottom)
    for (const col of compactCols) {
      for (let j = 1; j < col.photos.length; j++) {
        const prevMs = new Date(col.photos[j - 1].timestamp).getTime();
        const currMs = new Date(col.photos[j].timestamp).getTime();
        expect(currMs).toBeGreaterThanOrEqual(prevMs);
      }
    }

    // Verify downward flow, initial top-to-bottom chronological placement (#1 at top), and smooth entry/exit transitions
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

  it('clusters dense locations at globe zoom and expands into individual markers at high zoom', async () => {
    const demoRes = await request(app).post('/api/demo').send({});
    const located = demoRes.body.photos.filter((p: any) => p.location !== null);
    const index = createPhotoSupercluster(located, 62, 16);

    // At globe zoom (zoom = 1), photos are grouped into city clusters with count badges
    const globeClusters = queryMapClusters(index, [-180, -85, 180, 85], 1);
    expect(globeClusters.length).toBeLessThan(located.length);
    const multiClusters = globeClusters.filter((n) => n.isCluster);
    expect(multiClusters.length).toBeGreaterThanOrEqual(6);

    const totalClusteredCount = globeClusters.reduce(
      (sum, node) => sum + (node.isCluster ? node.pointCount : 1),
      0
    );
    expect(totalClusteredCount).toBe(located.length);

    // At high street zoom (zoom = 17), clusters expand into individual photo pins
    const highZoomNodes = queryMapClusters(index, [-180, -85, 180, 85], 17);
    expect(highZoomNodes.length).toBe(located.length);
    expect(highZoomNodes.every((n) => !n.isCluster)).toBe(true);
  });

  it('handles edge cases: empty inputs, coordinate boundary clamping, browse endpoint, and API error paths', async () => {
    // 1. Empty inputs in timeline & cluster utilities
    expect(buildTimelineDayColumns([], 'compact')).toEqual([]);
    expect(buildTimelineDayColumns([], 'proportional')).toEqual([]);
    const emptyVirtual = buildVirtualStringItems([], 600);
    expect(emptyVirtual.items).toEqual([]);

    const emptyClusterIndex = createPhotoSupercluster([]);
    expect(queryMapClusters(emptyClusterIndex, [-180, -85, 180, 85], 2)).toEqual([]);

    // 2. Directory browser endpoint
    const browseRes = await request(app)
      .get('/api/browse')
      .query({ dir: tempDir })
      .expect(200);
    expect(browseRes.body.currentPath).toBe(path.resolve(tempDir));
    expect(Array.isArray(browseRes.body.drives)).toBe(true);
    expect(browseRes.body.directories.some((d: any) => d.name === 'Trip-2025')).toBe(true);

    // 3. Error paths on /api/scan
    await request(app).post('/api/scan').send({}).expect(400);
    await request(app)
      .post('/api/scan')
      .send({ folderPath: path.join(tempDir, 'non-existent-folder-xyz') })
      .expect(404);

    // 4. Error paths on /api/photo (unsupported extension -> 403, missing path -> 400, missing file -> 404)
    await request(app).get('/api/photo').expect(400);
    const dummyTxt = path.join(tempDir, 'notes.txt');
    await fs.writeFile(dummyTxt, 'hello');
    await request(app).get('/api/photo').query({ path: dummyTxt }).expect(403);
    await request(app)
      .get('/api/photo')
      .query({ path: path.join(tempDir, 'missing.jpg') })
      .expect(404);

    // 5. Error paths & boundary clamping on /api/photos/batch
    await request(app)
      .patch('/api/photos/batch')
      .send({ folderPath: tempDir, photoIds: [] })
      .expect(400);

    await request(app)
      .patch('/api/photos/batch')
      .send({ folderPath: tempDir, photoIds: ['non-existent-id.jpg'] })
      .expect(404);

    // Boundary coordinate clamping (lat: 125 -> 90, lng: -240 -> -180)
    const scanBefore = await request(app).post('/api/scan').send({ folderPath: tempDir });
    const targetId = scanBefore.body.photos[0].id;
    const clampRes = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: tempDir,
        photoIds: [targetId],
        locationEdit: {
          mode: 'set',
          location: { lat: 125.5, lng: -240.25, name: 'Extreme Pole' },
        },
      })
      .expect(200);
    const clampedPhoto = clampRes.body.photos.find((p: any) => p.id === targetId);
    expect(clampedPhoto.location.lat).toBe(90);
    expect(clampedPhoto.location.lng).toBe(-180);
  });

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

    // Total photos across columns is always preserved and sorted oldest -> newest inside every merged bucket
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
          expect(currMs).toBeGreaterThanOrEqual(prevMs);
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
    const boundaryPhotos = [
      { id: 'b1', timestamp: '2024-12-30T10:00:00.000Z', fileName: 'b1.jpg' },
      { id: 'b2', timestamp: '2024-12-31T22:00:00.000Z', fileName: 'b2.jpg' },
      { id: 'b3', timestamp: '2025-01-01T08:00:00.000Z', fileName: 'b3.jpg' },
    ] as any[];
    const boundaryWeeks = buildTimelineDayColumns(boundaryPhotos, 'compact', 256, 'week');
    expect(boundaryWeeks.length).toBe(1);
    expect(boundaryWeeks[0].dayKey).toBe('2025-W01');
    expect(boundaryWeeks[0].displayDate).toBe('Dec 30, 2024 – Jan 5, 2025');
    expect(boundaryWeeks[0].photos.map((p) => p.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('enforces horizontal-only panning, keeps time cards pinned at the top while resizing on zoom, and merges strings in TimelineView DOM', async () => {
    const demoRes = await request(app).post('/api/demo').send({});
    const photos = demoRes.body.photos;

    // Set up JSDOM environment for React component rendering
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/',
    });
    const prevWindow = (globalThis as any).window;
    const prevDocument = (globalThis as any).document;
    const prevNavigator = (globalThis as any).navigator;
    const prevHTMLElement = (globalThis as any).HTMLElement;
    const prevElement = (globalThis as any).Element;
    const prevNode = (globalThis as any).Node;
    const prevResizeObserver = (globalThis as any).ResizeObserver;
    const prevRaf = (globalThis as any).requestAnimationFrame;
    const prevCaf = (globalThis as any).cancelAnimationFrame;
    const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true,
      writable: true,
    });
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).Element = dom.window.Element;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => {};

    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(TimelineView, {
            photos,
            selectedIds: new Set<string>(),
            onToggleSelect: () => {},
            onSelectGroup: () => {},
            onOpenPhoto: () => {},
            spacingMode: 'compact',
            onChangeSpacingMode: () => {},
          })
        );
      });

      const canvas = container.querySelector('[data-testid="timeline-canvas"]') as HTMLElement;
      const transformLayer = container.querySelector(
        '[data-testid="timeline-transform-layer"]'
      ) as HTMLElement;
      expect(canvas).toBeTruthy();
      expect(transformLayer).toBeTruthy();

      // 1. Initial state at 100% zoom: Daily strings (9 columns), pan.y = 0, centered pan.x, time card size = 216x56
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      expect(transformLayer.style.transform).toContain('0px, 0');

      const initialDayCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(initialDayCols.length).toBe(9);

      // Verify timeline is centered on the 1280px screen instead of left-aligned:
      // 9 compact columns at 100% zoom -> total width = 8 * 256 + 216 = 2264px -> centered pan.x = (1280 - 2264) / 2 = -492px
      const expectedCenteredPanX = computeCenteredTimelinePanX(8 * 256 + BASE_TIME_CARD_WIDTH_PX, 1280);
      expect(expectedCenteredPanX).toBe(-492);
      expect(Number(transformLayer.getAttribute('data-pan-x'))).toBe(expectedCenteredPanX);

      const firstTimeCard = container.querySelector(
        '[data-testid^="timeline-time-card-"]'
      ) as HTMLElement;
      expect(firstTimeCard).toBeTruthy();
      expect(Number(firstTimeCard.getAttribute('data-card-width'))).toBe(BASE_TIME_CARD_WIDTH_PX);
      expect(Number(firstTimeCard.getAttribute('data-card-height'))).toBe(BASE_TIME_CARD_HEIGHT_PX);

      // 2. Pointer dragging with large vertical delta (+320px Y and -150px X) ONLY moves horizontally; pan.y stays 0
      const panXBeforeDrag = Number(transformLayer.getAttribute('data-pan-x'));
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 500,
            clientY: 200,
          })
        );
      });
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: 350,
            clientY: 520, // +320px vertical drag attempt
          })
        );
      });
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointerup', {
            bubbles: true,
            button: 0,
          })
        );
      });

      const panXAfterDrag = Number(transformLayer.getAttribute('data-pan-x'));
      expect(panXAfterDrag).toBeLessThan(panXBeforeDrag);
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      expect(transformLayer.style.transform).toBe(`translate3d(${panXAfterDrag}px, 0px, 0)`);

      // 3. Zooming out slightly (100% -> 85% -> 70%) resizes time cards in place without moving them vertically or changing granularity yet
      const zoomOutBtn = container.querySelector('[data-testid="timeline-zoom-out"]') as HTMLElement;
      await act(async () => {
        zoomOutBtn.click(); // 0.85
      });
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      const resizedTimeCard = container.querySelector(
        '[data-testid^="timeline-time-card-"]'
      ) as HTMLElement;
      const widthAt85 = Number(resizedTimeCard.getAttribute('data-card-width'));
      const heightAt85 = Number(resizedTimeCard.getAttribute('data-card-height'));
      expect(widthAt85).toBeLessThan(BASE_TIME_CARD_WIDTH_PX);
      expect(heightAt85).toBeLessThan(BASE_TIME_CARD_HEIGHT_PX);
      // Column remains anchored at top: 0 and scales card slot height proportionally
      const firstColEl = container.querySelector(
        '[data-testid^="timeline-day-column-"]'
      ) as HTMLElement;
      expect(firstColEl.className).toContain('top-0');
      expect(Number(firstColEl.getAttribute('data-card-slot-height'))).toBeLessThan(192);

      // 4. Zooming out further triggers automatic merging: Daily (9) -> Weekly (7) -> Monthly (7) -> Yearly (2)
      await act(async () => {
        zoomOutBtn.click(); // 0.70 (still 'day')
        zoomOutBtn.click(); // 0.55 -> merges to 'week'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('week');
      const weekDomCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(weekDomCols.length).toBe(7);
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      await act(async () => {
        zoomOutBtn.click(); // 0.40 -> merges to 'month'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('month');
      const monthDomCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(monthDomCols.length).toBe(7);
      expect(monthDomCols[0].getAttribute('data-day-key')).toBe('2025-03');

      await act(async () => {
        zoomOutBtn.click(); // 0.25 -> merges to 'year'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('year');
      const yearDomCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(yearDomCols.length).toBe(2);
      expect(yearDomCols[0].getAttribute('data-day-key')).toBe('2025');
      expect(yearDomCols[1].getAttribute('data-day-key')).toBe('2026');
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      // When zoomed out to 2 yearly strings (total width narrower than the 1280px screen), timeline centers horizontally
      const yearlyPanX = Number(transformLayer.getAttribute('data-pan-x'));
      const metricsAt25 = getTimelineZoomMetrics(0.25);
      const yearlyTimelineWidth = metricsAt25.columnStepPx + metricsAt25.columnWidthPx;
      expect(yearlyPanX).toBe(computeCenteredTimelinePanX(yearlyTimelineWidth, 1280));
      expect(yearlyPanX).toBeGreaterThan(400);

      // 5. Reset view restores 100% zoom, Daily strings (9 columns), centered pan.x, and pan.y = 0
      const resetBtn = container.querySelector('[data-testid="timeline-reset-view"]') as HTMLElement;
      await act(async () => {
        resetBtn.click();
      });
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(container.querySelectorAll('[data-testid^="timeline-day-column-"]').length).toBe(9);
      expect(Number(transformLayer.getAttribute('data-pan-x'))).toBe(expectedCenteredPanX);
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      // 6. Fast-backward and fast-forward when hovering on the two ends of a string
      const col2025_03_14 = container.querySelector(
        '[data-testid="timeline-day-column-2025-03-14"]'
      ) as HTMLElement;
      const topEndEl = container.querySelector(
        '[data-testid="string-top-end-2025-03-14"]'
      ) as HTMLElement;
      const bottomEndEl = container.querySelector(
        '[data-testid="string-bottom-end-2025-03-14"]'
      ) as HTMLElement;
      expect(col2025_03_14).toBeTruthy();
      expect(topEndEl).toBeTruthy();
      expect(bottomEndEl).toBeTruthy();

      const baseSpeed = Number(col2025_03_14.getAttribute('data-speed'));
      const phaseInitial = Number(col2025_03_14.getAttribute('data-phase'));
      expect(col2025_03_14.getAttribute('data-flow-mode')).toBe('normal');
      expect(Number(col2025_03_14.getAttribute('data-flow-velocity'))).toBe(baseSpeed);

      // Hover top end of string -> fast-backward (negative velocity, phase rewinds upwards)
      await act(async () => {
        topEndEl.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      const phaseAfterTopHover = Number(col2025_03_14.getAttribute('data-phase'));
      expect(col2025_03_14.getAttribute('data-flow-mode')).toBe('fast-backward');
      expect(Number(col2025_03_14.getAttribute('data-flow-velocity'))).toBeCloseTo(
        -baseSpeed * FAST_STRING_FLOW_MULTIPLIER,
        1
      );
      expect(phaseAfterTopHover).toBeLessThan(phaseInitial);

      // Leave top end -> returns to normal/slow column flow
      await act(async () => {
        topEndEl.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }));
      });
      expect(col2025_03_14.getAttribute('data-flow-mode')).not.toBe('fast-backward');

      // Hover bottom end of string -> fast-forward (positive +4.5x velocity, phase advances downwards)
      await act(async () => {
        bottomEndEl.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      const phaseAfterBottomHover = Number(col2025_03_14.getAttribute('data-phase'));
      expect(col2025_03_14.getAttribute('data-flow-mode')).toBe('fast-forward');
      expect(Number(col2025_03_14.getAttribute('data-flow-velocity'))).toBeCloseTo(
        baseSpeed * FAST_STRING_FLOW_MULTIPLIER,
        1
      );
      expect(phaseAfterBottomHover).toBeGreaterThan(phaseAfterTopHover);

      // 7. Zooming across granularity boundaries while hovering a daily string end clears stale hover state cleanly
      await act(async () => {
        zoomOutBtn.click(); // 0.85
        zoomOutBtn.click(); // 0.70
        zoomOutBtn.click(); // 0.55 -> 'week' (2025-03-14 unmounts into 2025-W11)
      });
      expect(canvas.getAttribute('data-granularity')).toBe('week');
      const weekCol0 = container.querySelector(
        '[data-testid="timeline-day-column-2025-W11"]'
      ) as HTMLElement;
      expect(weekCol0).toBeTruthy();
      expect(weekCol0.getAttribute('data-flow-mode')).toBe('normal');

      await act(async () => {
        resetBtn.click();
      });

      // 8. Wheel events (both vertical wheel zoom and horizontal trackpad scroll) never shift pan.y from 0
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: 120,
            deltaY: 10,
          })
        );
      });
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: 0,
            deltaY: 200,
          })
        );
      });
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      expect(Number(transformLayer.getAttribute('data-zoom'))).toBeLessThan(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      (globalThis as any).window = prevWindow;
      (globalThis as any).document = prevDocument;
      Object.defineProperty(globalThis, 'navigator', {
        value: prevNavigator,
        configurable: true,
        writable: true,
      });
      (globalThis as any).HTMLElement = prevHTMLElement;
      (globalThis as any).Element = prevElement;
      (globalThis as any).Node = prevNode;
      (globalThis as any).ResizeObserver = prevResizeObserver;
      (globalThis as any).requestAnimationFrame = prevRaf;
      (globalThis as any).cancelAnimationFrame = prevCaf;
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  });

  it('computes centered timeline pan coordinates and string top/bottom end fast-forward/backward velocities accurately', () => {
    // 1. Centering math for both wider-than-screen and narrower-than-screen timelines
    expect(computeCenteredTimelinePanX(2264, 1280)).toBe(-492);
    expect(computeCenteredTimelinePanX(420, 1280)).toBe(430);
    expect(computeCenteredTimelinePanX(0, 1280)).toBe(640);

    // Clamping preserves the centered position when timeline is narrower than viewport
    expect(clampTimelinePanX(430, 420, 1280)).toBe(430);
    expect(clampTimelinePanX(Number.NaN, 2264, 1280)).toBe(-492);
    // Clamping prevents panning a wide timeline completely off-screen
    expect(clampTimelinePanX(-99999, 2264, 1280)).toBeGreaterThan(-2500);
    expect(clampTimelinePanX(99999, 2264, 1280)).toBeLessThan(300);

    // 2. String end hover zone detection (top end -> 'backward', bottom end -> 'forward', middle -> null)
    expect(resolveStringEndHoverDirection(0, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('backward');
    expect(resolveStringEndHoverDirection(40, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('backward');
    expect(resolveStringEndHoverDirection(300, 600, STRING_END_ZONE_HEIGHT_PX)).toBeNull();
    expect(resolveStringEndHoverDirection(560, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('forward');
    expect(resolveStringEndHoverDirection(600, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('forward');
    expect(resolveStringEndHoverDirection(10, 0, STRING_END_ZONE_HEIGHT_PX)).toBeNull();

    // 3. String flow velocity calculation across normal, slow hover, paused, fast-forward, and fast-backward modes
    const baseSpeed = 30;
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: true,
        isColumnHovered: false,
        isPhotoHovered: false,
        endHoverDirection: null,
      })
    ).toBe(30);

    // Fast-backward on top end hover moves upwards (negative velocity) even when global flow is paused
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: false,
        isColumnHovered: true,
        isPhotoHovered: false,
        endHoverDirection: 'backward',
      })
    ).toBe(-30 * FAST_STRING_FLOW_MULTIPLIER);

    // Fast-forward on bottom end hover moves downwards at +4.5x speed
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: true,
        isColumnHovered: true,
        isPhotoHovered: false,
        endHoverDirection: 'forward',
      })
    ).toBe(30 * FAST_STRING_FLOW_MULTIPLIER);

    // Negative phase offsets (from rewinding/fast-backward) wrap cleanly in computeFlowingCardState
    const cardAtNegPhase = computeFlowingCardState(0, 6, -120, 640, 192);
    expect(Number.isFinite(cardAtNegPhase.y)).toBe(true);
    expect(cardAtNegPhase.y).toBeGreaterThanOrEqual(-192);
  });
});


