import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../server/app.ts';
import { createTripFixture, removeFixture } from '../helpers/album-fixtures.ts';

describe('Server: batch time and location edits', () => {
  const app = createApiApp();
  let tempDir = '';

  beforeAll(async () => {
    tempDir = await createTripFixture();
  });

  afterAll(async () => {
    await removeFixture(tempDir);
  });

  it('recursively scans nested subfolders and supports batch time & location edits with sidecar persistence', async () => {

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
});
