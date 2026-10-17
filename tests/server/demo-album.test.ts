import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../server/app.ts';

describe('Server: built-in demo album API', () => {
  const app = createApiApp();

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
});
