import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../server/app.ts';
import { injectExifIntoJpeg } from '../../server/exifWriter.ts';

const SCRATCH_ROOT = fileURLToPath(new URL('../../test-results/', import.meta.url));
const BASE_TIME = '2025-03-14T14:37:00.000Z';
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="auto-locate-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="35.680000" lon="139.760000"><time>2025-03-14T14:35:00.000Z</time></trkpt>
    <trkpt lat="35.700000" lon="139.780000"><time>2025-03-14T14:40:00.000Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

interface PhotoSpec {
  fileName: string;
  folder?: string;
  timestamp: string;
  lat?: number;
  lng?: number;
}

let scratchDir = '';
let baseJpeg: Buffer;
let nominatimServer: Server | undefined;
let nominatimBaseUrl = '';
let nominatimRequests: Array<{ path: string; userAgent: string | undefined }> = [];

const app = createApiApp();

beforeAll(async () => {
  await fs.mkdir(SCRATCH_ROOT, { recursive: true });
  scratchDir = await fs.mkdtemp(path.join(SCRATCH_ROOT, 'myalbum-auto-locate-'));
  baseJpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 140, b: 190 } },
  })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  if (nominatimServer) {
    await new Promise<void>((resolve, reject) => {
      nominatimServer?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
});

async function createPhotoFolder(name: string, photos: PhotoSpec[]): Promise<string> {
  const folderPath = path.join(scratchDir, name);
  await fs.mkdir(folderPath, { recursive: true });
  for (const photo of photos) {
    const photoDir = path.join(folderPath, photo.folder ?? '');
    await fs.mkdir(photoDir, { recursive: true });
    await fs.writeFile(
      path.join(photoDir, photo.fileName),
      injectExifIntoJpeg(baseJpeg, {
        dateTimeOriginal: photo.timestamp,
        ...(photo.lat === undefined ? {} : { lat: photo.lat }),
        ...(photo.lng === undefined ? {} : { lng: photo.lng }),
      }),
    );
  }
  return folderPath;
}

async function scanFolder(folderPath: string) {
  return request(app).post('/api/scan').send({ folderPath }).expect(200);
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    windowMinutes: 120,
    utcOffsetMinutes: 0,
    driftMinutes: 0,
    useEmbeddedOffset: true,
    enableCompanion: false,
    enableGazetteer: false,
    ...overrides,
  };
}

describe('POST /api/photos/auto-locate', () => {
  it('matches a track file and the sample track, and warns when target times do not overlap', async () => {
    const folderPath = await createPhotoFolder('track-album', [
      {
        folder: 'Tokyo',
        fileName: 'anchor.jpg',
        timestamp: '2025-03-14T14:00:00.000Z',
        lat: 35.6762,
        lng: 139.6503,
      },
      { folder: 'Tokyo', fileName: 'track-target.jpg', timestamp: BASE_TIME },
      { folder: 'Tokyo', fileName: 'far-target.jpg', timestamp: '2025-05-20T14:37:00.000Z' },
    ]);
    const trackPath = path.join(scratchDir, 'route.gpx');
    await fs.writeFile(trackPath, GPX, 'utf8');
    const scan = await scanFolder(folderPath);
    const targetId = scan.body.photos.find((photo: { fileName: string }) => photo.fileName === 'track-target.jpg').id;
    const farTargetId = scan.body.photos.find((photo: { fileName: string }) => photo.fileName === 'far-target.jpg').id;

    const fileResult = await request(app)
      .post('/api/photos/auto-locate')
      .send({
        folderPath,
        photoIds: [targetId],
        trackSource: { type: 'file', path: trackPath },
        options: options(),
      })
      .expect(200);

    expect(fileResult.body.suggestions).toHaveLength(1);
    expect(fileResult.body.suggestions[0]).toMatchObject({
      photoId: targetId,
      strategy: 'track',
      utcIso: BASE_TIME,
      previouslyRemoved: false,
    });
    expect(fileResult.body.suggestions[0].location.lat).toBeCloseTo(35.688, 3);
    expect(fileResult.body.suggestions[0].location.lng).toBeCloseTo(139.768, 3);
    expect(fileResult.body.stats.trackPoints).toBe(2);
    expect(fileResult.body).not.toHaveProperty('track');

    const sampleResult = await request(app)
      .post('/api/photos/auto-locate')
      .send({
        folderPath,
        photoIds: [targetId],
        trackSource: { type: 'sample' },
        options: options(),
      })
      .expect(200);
    expect(sampleResult.body.suggestions[0].strategy).toBe('track');
    expect(sampleResult.body.stats.trackPoints).toBeGreaterThan(100);

    const outOfSpanResult = await request(app)
      .post('/api/photos/auto-locate')
      .send({
        folderPath,
        photoIds: [farTargetId],
        trackSource: { type: 'file', path: trackPath },
        options: options(),
      })
      .expect(200);
    expect(outOfSpanResult.body.suggestions).toHaveLength(0);
    expect(outOfSpanResult.body.unmatchedPhotoIds).toEqual([farTargetId]);
    expect(outOfSpanResult.body.warnings.join(' ')).toMatch(/Check the UTC offset or camera clock drift/);
  });

  it('marks a location that was previously removed while allowing it to be matched', async () => {
    const folderPath = await createPhotoFolder('removed-location-album', [
      {
        folder: 'Tokyo',
        fileName: 'anchor.jpg',
        timestamp: '2025-03-14T14:00:00.000Z',
        lat: 35.6762,
        lng: 139.6503,
      },
      {
        folder: 'Tokyo',
        fileName: 'removed.jpg',
        timestamp: '2025-03-14T14:35:00.000Z',
        lat: 35.6800,
        lng: 139.7600,
      },
    ]);
    await fs.writeFile(
      path.join(folderPath, '.myalbum-overrides.json'),
      JSON.stringify({ 'Tokyo/removed.jpg': { location: null } }),
      'utf8',
    );
    const scan = await scanFolder(folderPath);
    const removedId = scan.body.photos.find((photo: { fileName: string }) => photo.fileName === 'removed.jpg').id;

    const result = await request(app)
      .post('/api/photos/auto-locate')
      .send({
        folderPath,
        photoIds: [removedId],
        options: options({ enableCompanion: true }),
      })
      .expect(200);

    expect(result.body.suggestions[0]).toMatchObject({
      photoId: removedId,
      strategy: 'companion',
      previouslyRemoved: true,
    });
  });

  it('rejects missing tracks, unsupported extensions, empty ids and invalid windows', async () => {
    const folderPath = await createPhotoFolder('validation-album', [
      { fileName: 'target.jpg', timestamp: BASE_TIME },
    ]);
    const scan = await scanFolder(folderPath);
    const targetId = scan.body.photos[0].id;

    const requestBody = {
      folderPath,
      photoIds: [targetId],
      options: options(),
    };
    await request(app)
      .post('/api/photos/auto-locate')
      .send({ ...requestBody, trackSource: { type: 'file', path: path.join(scratchDir, 'missing.gpx') } })
      .expect(404);
    await request(app)
      .post('/api/photos/auto-locate')
      .send({ ...requestBody, trackSource: { type: 'file', path: path.join(scratchDir, 'bad.txt') } })
      .expect(400);
    await request(app)
      .post('/api/photos/auto-locate')
      .send({ ...requestBody, photoIds: [] })
      .expect(400);
    await request(app)
      .post('/api/photos/auto-locate')
      .send({ ...requestBody, options: options({ windowMinutes: 45 }) })
      .expect(400);
  });
});

describe('track browsing and Nominatim opt-in', () => {
  it('returns track files and serves the generated sample GPX', async () => {
    const browseDir = path.join(scratchDir, 'browse-tracks');
    await fs.mkdir(browseDir, { recursive: true });
    await fs.writeFile(path.join(browseDir, 'walk.GPX'), GPX, 'utf8');
    await fs.writeFile(path.join(browseDir, 'records.json'), '{}', 'utf8');
    await fs.writeFile(path.join(browseDir, 'ignore.txt'), 'ignored', 'utf8');

    const browseResult = await request(app)
      .get('/api/browse')
      .query({ dir: browseDir, kind: 'track' })
      .expect(200);
    expect(browseResult.body.files.map((file: { name: string }) => file.name)).toEqual(['records.json', 'walk.GPX']);
    expect(browseResult.body.files[0].size).toBe(2);

    const sampleResult = await request(app).get('/api/demo/sample-track.gpx').expect(200);
    expect(sampleResult.headers['content-type']).toContain('application/gpx+xml');
    expect((sampleResult.text.match(/<trkpt\b/g) ?? []).length).toBeGreaterThan(100);
  });

  it('leaves Nominatim off by default and caches an opted-in lookup', async () => {
    nominatimRequests = [];
    nominatimServer = createServer((incoming, outgoing) => {
      nominatimRequests.push({
        path: incoming.url ?? '',
        userAgent: incoming.headers['user-agent'],
      });
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(
        JSON.stringify([
          {
            lat: '64.1466',
            lon: '-21.9426',
            name: 'Reykjavik',
            display_name: 'Reykjavik, Iceland',
            importance: 0.7,
          },
        ]),
      );
    });
    await new Promise<void>((resolve, reject) => {
      nominatimServer?.once('error', reject);
      nominatimServer?.listen(0, '127.0.0.1', resolve);
    });
    const address = nominatimServer.address();
    if (!address || typeof address === 'string') throw new Error('Nominatim stub did not bind to a TCP port');
    nominatimBaseUrl = `http://127.0.0.1:${address.port}`;

    const folderPath = await createPhotoFolder('nominatim-album', [
      {
        folder: 'Mystery-Place',
        fileName: 'Unknown_Cove.jpg',
        timestamp: BASE_TIME,
      },
    ]);
    const scan = await scanFolder(folderPath);
    const targetId = scan.body.photos[0].id;
    const previousBaseUrl = process.env.NOMINATIM_BASE_URL;
    const previousDataDir = process.env.MYALBUM_DATA_DIR;
    const dataDir = path.join(scratchDir, 'nominatim-cache');
    process.env.NOMINATIM_BASE_URL = nominatimBaseUrl;
    process.env.MYALBUM_DATA_DIR = dataDir;
    try {
      const requestBody = {
        folderPath,
        photoIds: [targetId],
        options: options({ enableGazetteer: true }),
      };
      const disabledResult = await request(app)
        .post('/api/photos/auto-locate')
        .send(requestBody)
        .expect(200);
      expect(disabledResult.body.suggestions).toHaveLength(0);
      expect(nominatimRequests).toHaveLength(0);

      const enabledBody = {
        ...requestBody,
        options: options({ enableGazetteer: true, enableNominatim: true }),
      };
      const enabledResult = await request(app)
        .post('/api/photos/auto-locate')
        .send(enabledBody)
        .expect(200);
      expect(enabledResult.body.suggestions[0]).toMatchObject({
        strategy: 'nominatim',
        location: { name: 'Reykjavik', lat: 64.1466, lng: -21.9426 },
      });
      expect(enabledResult.body.attribution).toBe('© OpenStreetMap contributors');
      expect(enabledResult.body.stats.geocodeLookups).toBe(1);
      expect(nominatimRequests).toHaveLength(1);
      expect(nominatimRequests[0].path).toContain('/search?format=jsonv2');
      expect(nominatimRequests[0].userAgent).toBe('MyAlbum-LocalPhotoApp/1.0 (local-photo-organizer)');

      const cachePath = path.join(dataDir, 'geocode-cache.json');
      const cacheContents = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      expect(Object.keys(cacheContents.entries)).toContain('unknown');

      const cachedResult = await request(app)
        .post('/api/photos/auto-locate')
        .send(enabledBody)
        .expect(200);
      expect(cachedResult.body.suggestions[0].strategy).toBe('nominatim');
      expect(cachedResult.body.stats.geocodeLookups).toBe(0);
      expect(nominatimRequests).toHaveLength(1);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.NOMINATIM_BASE_URL;
      else process.env.NOMINATIM_BASE_URL = previousBaseUrl;
      if (previousDataDir === undefined) delete process.env.MYALBUM_DATA_DIR;
      else process.env.MYALBUM_DATA_DIR = previousDataDir;
    }
  });
});
