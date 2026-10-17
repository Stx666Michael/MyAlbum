import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { injectExifIntoJpeg } from '../../server/exifWriter.ts';

// Trip-2025 folder: two GPS-tagged photos in Day1 and one unlocated photo in Day2.
export async function createTripFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myalbum-test-'));
  const subA = path.join(dir, 'Trip-2025', 'Day1');
  const subB = path.join(dir, 'Trip-2025', 'Day2');
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
  });

  await fs.writeFile(path.join(subA, 'morning.jpg'), p1);
  await fs.writeFile(path.join(subA, 'afternoon.jpg'), p2);
  await fs.writeFile(path.join(subB, 'studio.jpg'), p3);
  return dir;
}

export async function removeFixture(dir: string): Promise<void> {
  if (dir) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
