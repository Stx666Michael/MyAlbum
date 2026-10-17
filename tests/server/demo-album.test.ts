import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../server/app.ts';
import { buildDemoSampleTrackGpx, DEMO_PHOTO_SPECS, demoRoutePointAt } from '../../server/demoGenerator.ts';
import { haversineKm, matchTrack, parseGpx } from '../../src/utils/autoLocate.ts';

const NEW_UNLOCATED_SHOTS = [
  '2025-03-Tokyo-Spring/Day1-Shibuya/IMG_1013_Shibuya_Scramble_Umbrellas.jpg',
  '2025-03-Tokyo-Spring/Day1-Shibuya/IMG_1014_Shibuya_Sky_Rooftop_Walk.jpg',
  '2025-03-Tokyo-Spring/Day1-Shibuya/IMG_1015_Harajuku_Takeshita_Crepes.jpg',
  '2025-11-Cairo-Desert/IMG_5007_Khan_El_Khalili_Spice_Stalls.jpg',
  '2025-11-Cairo-Desert/IMG_5008_Zamalek_Corniche_Lights.jpg',
  'Misc/IMG_9001.jpg',
];

const TRACK_SHOT_FILE_NAMES = [
  'IMG_1014_Shibuya_Sky_Rooftop_Walk.jpg',
  'IMG_1015_Harajuku_Takeshita_Crepes.jpg',
];

describe('Server: built-in demo album API', () => {
  const app = createApiApp();

  it('generates and scans the built-in Demo Album with nested subfolders via POST /api/demo', async () => {
    const res = await request(app)
      .post('/api/demo')
      .send({ reset: true })
      .expect(200);

    expect(res.body.totalCount).toBe(58);
    expect(res.body.locatedCount).toBe(48);
    expect(res.body.subfolders.length).toBeGreaterThanOrEqual(8);
    expect(res.body.subfolders).toContain('2025-03-Tokyo-Spring/Day1-Shibuya');
    expect(res.body.subfolders).toContain('2025-07-Iceland-Highlands/South-Coast');
    expect(res.body.subfolders).toContain('Misc');

    for (const relativePath of NEW_UNLOCATED_SHOTS) {
      const photo = res.body.photos.find((p: { relativePath: string }) => p.relativePath === relativePath);
      expect(photo, relativePath).toBeDefined();
      expect(photo.location, relativePath).toBeNull();
    }

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

  it('builds a demo sample GPX track with at least 100 trackpoints', () => {
    const gpx = buildDemoSampleTrackGpx();
    expect(gpx.match(/<trkpt /g)?.length ?? 0).toBeGreaterThanOrEqual(100);
  });

  it('auto-locates the track-only demo shots by interpolating the sample GPX track at 30 and 120 min', () => {
    const points = parseGpx(buildDemoSampleTrackGpx());
    const trackShots = DEMO_PHOTO_SPECS.filter((spec) => TRACK_SHOT_FILE_NAMES.includes(spec.fileName));
    expect(trackShots).toHaveLength(TRACK_SHOT_FILE_NAMES.length);

    for (const windowMinutes of [30, 120]) {
      for (const spec of trackShots) {
        const utcMs = Date.parse(spec.dateIso);
        const match = matchTrack(points, utcMs, windowMinutes * 60 * 1000);
        const expected = demoRoutePointAt(utcMs);
        if (!match || !expected) throw new Error(`No track match for ${spec.fileName} at ${windowMinutes} min`);
        expect(haversineKm(match, expected), `${spec.fileName} at ${windowMinutes} min`).toBeLessThanOrEqual(0.05);
        expect(match.confidence, spec.fileName).toBeGreaterThanOrEqual(0.9);
        expect(match.confidence, spec.fileName).toBeLessThanOrEqual(0.98);
      }
    }
  });
});
