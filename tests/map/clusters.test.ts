import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../server/app.ts';
import { createPhotoSupercluster, queryMapClusters } from '../../src/utils/mapClusters.ts';

describe('Map: globe clusters and high-zoom expansion', () => {
  const app = createApiApp();

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
});
