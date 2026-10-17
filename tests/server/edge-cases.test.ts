import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApiApp } from '../../server/app.ts';
import { buildTimelineDayColumns, buildVirtualStringItems } from '../../src/utils/timelineMath.ts';
import { createPhotoSupercluster, queryMapClusters } from '../../src/utils/mapClusters.ts';
import { createTripFixture, removeFixture } from '../helpers/album-fixtures.ts';

describe('Server: edge cases and API error paths', () => {
  const app = createApiApp();
  let tempDir = '';

  beforeAll(async () => {
    tempDir = await createTripFixture();
  });

  afterAll(async () => {
    await removeFixture(tempDir);
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
});
