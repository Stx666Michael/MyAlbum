import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { createApiApp, scanPhotoFolder } from '../../server/app.ts';
import { injectExifIntoJpeg } from '../../server/exifWriter.ts';
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

describe('Server: batch per-photo locations (auto-locate apply)', () => {
  const app = createApiApp();
  const TOKYO = { lat: 35.6762, lng: 139.6503 };
  const PARIS = { lat: 48.8566, lng: 2.3522, name: 'Paris' };
  let rootDir = '';
  let baseJpeg: Buffer;

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myalbum-batch-per-photo-'));
    baseJpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 80, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer();
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  // a.jpg carries EXIF GPS; b.jpg and c.jpg start unlocated.
  async function createFolder(name: string): Promise<string> {
    const folder = path.join(rootDir, name);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, 'a.jpg'),
      injectExifIntoJpeg(baseJpeg, { dateTimeOriginal: '2025:05:01 09:00:00', lat: TOKYO.lat, lng: TOKYO.lng })
    );
    await fs.writeFile(path.join(folder, 'b.jpg'), injectExifIntoJpeg(baseJpeg, { dateTimeOriginal: '2025:05:01 10:00:00' }));
    await fs.writeFile(path.join(folder, 'c.jpg'), injectExifIntoJpeg(baseJpeg, { dateTimeOriginal: '2025:05:01 11:00:00' }));
    return folder;
  }

  async function readSidecar(folder: string): Promise<Record<string, Record<string, unknown>>> {
    return JSON.parse(await fs.readFile(path.join(folder, '.myalbum-overrides.json'), 'utf8'));
  }

  async function readRawSidecar(folder: string): Promise<string | null> {
    return fs.readFile(path.join(folder, '.myalbum-overrides.json'), 'utf8').catch(() => null);
  }

  async function snapshot(folder: string) {
    const scan = await scanPhotoFolder(folder);
    return scan.photos.map((p) => ({
      id: p.id,
      location: p.location,
      isAutoLocated: p.isAutoLocated,
      timestamp: p.timestamp,
    }));
  }

  async function expectRejected(folder: string, payload: Record<string, unknown>) {
    const before = await snapshot(folder);
    const rawBefore = await readRawSidecar(folder);
    const res = await request(app)
      .patch('/api/photos/batch')
      .send({ folderPath: folder, ...payload })
      .expect(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(await snapshot(folder)).toEqual(before);
    expect(await readRawSidecar(folder)).toBe(rawBefore);
  }

  it('applies per-photo locations with clamped coordinates and marks each as auto-located', async () => {
    const folder = await createFolder('apply');
    const res = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: folder,
        photoIds: ['b.jpg', 'c.jpg'],
        perPhotoLocations: [
          { photoId: 'b.jpg', location: { lat: 95, lng: 200, name: 'Arctic Edge' } },
          { photoId: 'c.jpg', location: { lat: -100, lng: -190.5, name: 'Antarctic Edge' } },
        ],
      })
      .expect(200);

    expect(res.body.totalCount).toBe(3);
    expect(res.body.locatedCount).toBe(3);
    const findPhoto = (id: string) => res.body.photos.find((p: any) => p.id === id);
    expect(findPhoto('b.jpg').location).toEqual({ lat: 90, lng: 180, name: 'Arctic Edge' });
    expect(findPhoto('b.jpg').isAutoLocated).toBe(true);
    expect(findPhoto('c.jpg').location).toEqual({ lat: -90, lng: -180, name: 'Antarctic Edge' });
    expect(findPhoto('c.jpg').isAutoLocated).toBe(true);
    expect(findPhoto('a.jpg').isAutoLocated).toBe(false);

    const sidecar = await readSidecar(folder);
    expect(sidecar['b.jpg']).toEqual({
      location: { lat: 90, lng: 180, name: 'Arctic Edge' },
      locationSource: 'auto-locate',
    });
    expect(sidecar['c.jpg']).toEqual({
      location: { lat: -90, lng: -180, name: 'Antarctic Edge' },
      locationSource: 'auto-locate',
    });
    expect(sidecar['a.jpg']).toBeUndefined();
  });

  it('accepts perPhotoLocations without photoIds or with an empty photoIds list', async () => {
    const folder = await createFolder('optional-photo-ids');
    await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: folder,
        perPhotoLocations: [{ photoId: 'b.jpg', location: PARIS }],
      })
      .expect(200);

    const res = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: folder,
        photoIds: [],
        perPhotoLocations: [{ photoId: 'c.jpg', location: { lat: 40.7128, lng: -74.006, name: 'New York' } }],
      })
      .expect(200);

    expect(res.body.locatedCount).toBe(3);
    const sidecar = await readSidecar(folder);
    expect(sidecar['b.jpg'].locationSource).toBe('auto-locate');
    expect(sidecar['c.jpg'].locationSource).toBe('auto-locate');
  });

  const mismatchedPhotoIds: Array<{ label: string; photoIds: unknown }> = [
    { label: 'extra photoId', photoIds: ['b.jpg', 'c.jpg', 'a.jpg'] },
    { label: 'missing photoId', photoIds: ['b.jpg'] },
    { label: 'different photoId', photoIds: ['a.jpg', 'b.jpg'] },
    { label: 'non-array photoIds', photoIds: 'b.jpg' },
  ];

  it.each(mismatchedPhotoIds)('rejects photoIds that do not match perPhotoLocations ($label)', async ({ label, photoIds }) => {
    const folder = await createFolder(`mismatch-${label.replace(/\W+/g, '-')}`);
    await expectRejected(folder, {
      photoIds,
      perPhotoLocations: [
        { photoId: 'b.jpg', location: { lat: 1, lng: 1, name: 'One' } },
        { photoId: 'c.jpg', location: { lat: 2, lng: 2, name: 'Two' } },
      ],
    });
  });

  const combinedEdits: Array<{ label: string; edit: Record<string, unknown> }> = [
    { label: 'timeEdit', edit: { timeEdit: { mode: 'offset', offsetMs: 3600000 } } },
    { label: 'locationEdit', edit: { locationEdit: { mode: 'remove' } } },
  ];

  it.each(combinedEdits)('rejects perPhotoLocations combined with $label', async ({ label, edit }) => {
    const folder = await createFolder(`combined-${label}`);
    await expectRejected(folder, {
      perPhotoLocations: [{ photoId: 'b.jpg', location: { lat: 1, lng: 1, name: 'One' } }],
      ...edit,
    });
  });

  const invalidBatches: Array<{ label: string; perPhotoLocations: unknown }> = [
    { label: 'empty perPhotoLocations', perPhotoLocations: [] },
    { label: 'non-array perPhotoLocations', perPhotoLocations: { photoId: 'b.jpg', location: PARIS } },
    {
      label: 'duplicate photoId',
      perPhotoLocations: [
        { photoId: 'b.jpg', location: PARIS },
        { photoId: 'b.jpg', location: PARIS },
      ],
    },
    { label: 'unknown photoId', perPhotoLocations: [{ photoId: 'missing.jpg', location: PARIS }] },
    { label: 'non-string photoId', perPhotoLocations: [{ photoId: 42, location: PARIS }] },
    { label: 'null location', perPhotoLocations: [{ photoId: 'b.jpg', location: null }] },
    { label: 'null latitude', perPhotoLocations: [{ photoId: 'b.jpg', location: { lat: null, lng: 2, name: 'x' } }] },
    { label: 'string longitude', perPhotoLocations: [{ photoId: 'b.jpg', location: { lat: 1, lng: '2', name: 'x' } }] },
    { label: 'missing name', perPhotoLocations: [{ photoId: 'b.jpg', location: { lat: 1, lng: 2 } }] },
    { label: 'numeric name', perPhotoLocations: [{ photoId: 'b.jpg', location: { lat: 1, lng: 2, name: 42 } }] },
  ];

  it.each(invalidBatches)('rejects an invalid perPhotoLocations batch ($label)', async ({ label, perPhotoLocations }) => {
    const folder = await createFolder(`invalid-${label.replace(/\W+/g, '-')}`);
    await expectRejected(folder, { perPhotoLocations });
  });

  it('rejects a non-finite latitude', async () => {
    const folder = await createFolder('non-finite');
    const before = await snapshot(folder);
    // Raw JSON, because supertest cannot encode Infinity. JSON.parse turns 1e400 into Infinity.
    const rawBody = `{"folderPath":${JSON.stringify(folder)},"perPhotoLocations":[{"photoId":"b.jpg","location":{"lat":1e400,"lng":2,"name":"Overflow"}}]}`;
    const res = await request(app)
      .patch('/api/photos/batch')
      .set('Content-Type', 'application/json')
      .send(rawBody)
      .expect(400);
    expect(res.body.error).toBe('Invalid location coordinates for photoId: b.jpg');
    expect(await snapshot(folder)).toEqual(before);
  });

  it('accepts an empty location name', async () => {
    const folder = await createFolder('empty-name');
    const res = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: folder,
        perPhotoLocations: [{ photoId: 'b.jpg', location: { lat: 10, lng: 20, name: '' } }],
      })
      .expect(200);

    const b = res.body.photos.find((p: any) => p.id === 'b.jpg');
    expect(b.location).toEqual({ lat: 10, lng: 20, name: '' });
    expect(b.isAutoLocated).toBe(true);
  });

  it('leaves the store unchanged when any entry is invalid', async () => {
    const folder = await createFolder('atomic');
    await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: folder,
        photoIds: ['c.jpg'],
        locationEdit: { mode: 'set', location: { lat: 1, lng: 1, name: 'Manual' } },
      })
      .expect(200);

    await expectRejected(folder, {
      perPhotoLocations: [
        { photoId: 'b.jpg', location: PARIS },
        { photoId: 'c.jpg', location: { lat: null, lng: 2, name: 'Broken' } },
      ],
    });
    const scan = await snapshot(folder);
    expect(scan.find((p) => p.id === 'b.jpg')?.location).toBeNull();
    expect(scan.find((p) => p.id === 'c.jpg')?.location).toEqual({ lat: 1, lng: 1, name: 'Manual' });
  });

  it('restores the original EXIF location and clears the auto-locate marker', async () => {
    const folder = await createFolder('restore');
    const original = (await snapshot(folder)).find((p) => p.id === 'a.jpg');
    expect(original?.location).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });

    const applied = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: folder,
        photoIds: ['a.jpg'],
        perPhotoLocations: [{ photoId: 'a.jpg', location: PARIS }],
      })
      .expect(200);
    expect(applied.body.photos.find((p: any) => p.id === 'a.jpg').location).toEqual(PARIS);

    const restored = await request(app)
      .patch('/api/photos/batch')
      .send({ folderPath: folder, photoIds: ['a.jpg'], locationEdit: { mode: 'restore' } })
      .expect(200);

    const a = restored.body.photos.find((p: any) => p.id === 'a.jpg');
    expect(a.location).toEqual(original?.location);
    expect(a.isAutoLocated).toBe(false);
    expect((await readSidecar(folder))['a.jpg']?.locationSource).toBeUndefined();
  });

  it('keeps an existing time edit when a photo receives an auto-located location', async () => {
    const folder = await createFolder('keeps-time-edit');
    const shifted = await request(app)
      .patch('/api/photos/batch')
      .send({ folderPath: folder, photoIds: ['b.jpg'], timeEdit: { mode: 'offset', offsetMs: 3600000 } })
      .expect(200);
    const shiftedB = shifted.body.photos.find((p: any) => p.id === 'b.jpg');

    const res = await request(app)
      .patch('/api/photos/batch')
      .send({ folderPath: folder, perPhotoLocations: [{ photoId: 'b.jpg', location: PARIS }] })
      .expect(200);

    const b = res.body.photos.find((p: any) => p.id === 'b.jpg');
    expect(b.timestamp).toBe(shiftedB.timestamp);
    expect(b.isTimeEdited).toBe(true);
    expect(b.location).toEqual(PARIS);
    expect(b.isAutoLocated).toBe(true);
  });
});
