import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import { createApiApp, scanPhotoFolder } from '../../server/app.ts';
import { injectExifIntoJpeg } from '../../server/exifWriter.ts';
import type { BatchLocationEdit, PhotoLocation } from '../../src/types/photo.ts';

const DATE_TIME_ORIGINAL = 0x9003;
const CREATE_DATE = 0x9004;
const OFFSET_TIME_ORIGINAL = 0x9011;
const OFFSET_TIME_DIGITIZED = 0x9012;

const PARIS: PhotoLocation = { lat: 48.8566, lng: 2.3522, name: 'Paris, France' };
const TOKYO: PhotoLocation = { lat: 35.6762, lng: 139.6503, name: 'Tokyo, Japan' };

interface AsciiExifTag {
  tag: number;
  value: string;
}

// Builds an Exif APP1 with ASCII tags in the Exif SubIFD. Covers inputs exifWriter cannot write (CreateDate alone, malformed offsets).
function buildAsciiExifApp1(tags: AsciiExifTag[]): Buffer {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  const exifIfdOffset = 8 + 2 + 12 + 4;
  const exifIfdLength = 2 + sorted.length * 12 + 4;

  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write('II', 0, 'ascii');
  tiffHeader.writeUInt16LE(0x2a, 2);
  tiffHeader.writeUInt32LE(8, 4);

  const ifd0 = Buffer.alloc(18);
  ifd0.writeUInt16LE(1, 0);
  ifd0.writeUInt16LE(0x8769, 2);
  ifd0.writeUInt16LE(4, 4);
  ifd0.writeUInt32LE(1, 6);
  ifd0.writeUInt32LE(exifIfdOffset, 10);

  const exifIfd = Buffer.alloc(exifIfdLength);
  exifIfd.writeUInt16LE(sorted.length, 0);
  const valueBuffers: Buffer[] = [];
  let valueOffset = exifIfdOffset + exifIfdLength;
  sorted.forEach(({ tag, value }, index) => {
    const bytes = Buffer.from(`${value}\0`, 'ascii');
    const padded = bytes.length % 2 === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(1)]);
    const entry = 2 + index * 12;
    exifIfd.writeUInt16LE(tag, entry);
    exifIfd.writeUInt16LE(2, entry + 2);
    exifIfd.writeUInt32LE(bytes.length, entry + 4);
    exifIfd.writeUInt32LE(valueOffset, entry + 8);
    valueBuffers.push(padded);
    valueOffset += padded.length;
  });

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiffHeader, ifd0, exifIfd, ...valueBuffers]);
  const segment = Buffer.from([0xff, 0xe1, 0, 0]);
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([segment, payload]);
}

function injectAsciiExif(jpeg: Buffer, tags: AsciiExifTag[]): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), buildAsciiExifApp1(tags), jpeg.subarray(2)]);
}

describe('Server: scan timestamp source, EXIF offset, and auto-locate flags', () => {
  const app = createApiApp();
  const scratchRoot = fileURLToPath(new URL('../../node_modules/.tmp', import.meta.url));
  let rootDir = '';
  let baseJpeg: Buffer;

  beforeAll(async () => {
    await fs.mkdir(scratchRoot, { recursive: true });
    rootDir = await fs.mkdtemp(path.join(scratchRoot, 'scan-metadata-'));
    baseJpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 80, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer();
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function createFolder(name: string, files: Record<string, Buffer>): Promise<string> {
    const folder = path.join(rootDir, name);
    await fs.mkdir(folder, { recursive: true });
    for (const [fileName, data] of Object.entries(files)) {
      await fs.writeFile(path.join(folder, fileName), data);
    }
    return folder;
  }

  async function writeSidecar(folder: string, overrides: Record<string, unknown>): Promise<void> {
    await fs.writeFile(path.join(folder, '.myalbum-overrides.json'), JSON.stringify(overrides, null, 2), 'utf8');
  }

  async function readSidecar(folder: string): Promise<Record<string, Record<string, unknown>>> {
    return JSON.parse(await fs.readFile(path.join(folder, '.myalbum-overrides.json'), 'utf8'));
  }

  async function scanSinglePhoto(folder: string) {
    const scan = await scanPhotoFolder(folder);
    expect(scan.photos).toHaveLength(1);
    return scan.photos[0];
  }

  async function fileTimeIso(filePath: string): Promise<string> {
    const stat = await fs.stat(filePath);
    return new Date(stat.mtimeMs).toISOString();
  }

  it('reports the EXIF date source and the DateTimeOriginal offset in signed minutes', async () => {
    const folder = await createFolder('dto-with-offset', {
      'photo.jpg': injectExifIntoJpeg(baseJpeg, {
        dateTimeOriginal: '2025:05:01 09:00:00',
        offsetTimeOriginal: '+09:00',
      }),
    });

    const photo = await scanSinglePhoto(folder);

    expect(photo.originalTimestamp).toBe('2025-05-01T09:00:00.000Z');
    expect(photo.timestampSource).toBe('exif');
    expect(photo.exifOffsetMinutes).toBe(540);
  });

  it('uses CreateDate with OffsetTimeDigitized when DateTimeOriginal is absent', async () => {
    const folder = await createFolder('create-date-only', {
      'photo.jpg': injectAsciiExif(baseJpeg, [
        { tag: CREATE_DATE, value: '2025:05:02 10:30:00' },
        { tag: OFFSET_TIME_DIGITIZED, value: '-03:30' },
      ]),
    });

    const photo = await scanSinglePhoto(folder);

    expect(photo.originalTimestamp).toBe('2025-05-02T10:30:00.000Z');
    expect(photo.timestampSource).toBe('exif');
    expect(photo.exifOffsetMinutes).toBe(-210);
  });

  it('returns a null offset when DateTimeOriginal has no OffsetTimeOriginal', async () => {
    const folder = await createFolder('dto-no-offset', {
      'photo.jpg': injectExifIntoJpeg(baseJpeg, { dateTimeOriginal: '2025:05:03 08:15:00' }),
    });

    const photo = await scanSinglePhoto(folder);

    expect(photo.timestampSource).toBe('exif');
    expect(photo.exifOffsetMinutes).toBeNull();
  });

  it('ignores OffsetTimeDigitized when the date comes from DateTimeOriginal', async () => {
    const folder = await createFolder('dto-digitized-offset-only', {
      'photo.jpg': injectExifIntoJpeg(baseJpeg, {
        dateTimeOriginal: '2025:05:04 12:00:00',
        offsetTimeDigitized: '+02:00',
      }),
    });

    const photo = await scanSinglePhoto(folder);

    expect(photo.timestampSource).toBe('exif');
    expect(photo.exifOffsetMinutes).toBeNull();
  });

  it('returns a null offset for malformed offset tags', async () => {
    const malformedOffsets = ['+9:00', '+15:00', '0900', '+09:60'];
    const folder = await createFolder(
      'malformed-offsets',
      Object.fromEntries(
        malformedOffsets.map((offset, index): [string, Buffer] => [
          `offset-${index}.jpg`,
          injectAsciiExif(baseJpeg, [
            { tag: DATE_TIME_ORIGINAL, value: '2025:05:05 07:00:00' },
            { tag: OFFSET_TIME_ORIGINAL, value: offset },
          ]),
        ])
      )
    );

    const scan = await scanPhotoFolder(folder);

    expect(scan.photos.every((p) => p.timestampSource === 'exif')).toBe(true);
    expect(Object.fromEntries(scan.photos.map((p) => [p.fileName, p.exifOffsetMinutes]))).toEqual({
      'offset-0.jpg': null,
      'offset-1.jpg': null,
      'offset-2.jpg': null,
      'offset-3.jpg': null,
    });
  });

  it('falls back to file time with a null offset when the EXIF date is unusable', async () => {
    const folder = await createFolder('unusable-dto', {
      'photo.jpg': injectAsciiExif(baseJpeg, [
        { tag: DATE_TIME_ORIGINAL, value: 'not a date' },
        { tag: OFFSET_TIME_ORIGINAL, value: '+09:00' },
      ]),
    });

    const photo = await scanSinglePhoto(folder);

    expect(photo.timestampSource).toBe('file');
    expect(photo.exifOffsetMinutes).toBeNull();
    expect(photo.originalTimestamp).toBe(await fileTimeIso(path.join(folder, 'photo.jpg')));
  });

  it('uses file time with a null offset when the photo has no EXIF date', async () => {
    const folder = await createFolder('no-exif', { 'photo.jpg': baseJpeg });

    const photo = await scanSinglePhoto(folder);

    expect(photo.timestampSource).toBe('file');
    expect(photo.exifOffsetMinutes).toBeNull();
    expect(photo.originalTimestamp).toBe(await fileTimeIso(path.join(folder, 'photo.jpg')));
  });

  it('keeps the original EXIF metadata and auto-located flag when a time offset is applied', async () => {
    const folder = await createFolder('time-offset', {
      'photo.jpg': injectExifIntoJpeg(baseJpeg, {
        dateTimeOriginal: '2025:05:01 09:00:00',
        offsetTimeOriginal: '+09:00',
      }),
    });
    await writeSidecar(folder, { 'photo.jpg': { location: TOKYO, locationSource: 'auto-locate' } });

    const res = await request(app)
      .patch('/api/photos/batch')
      .send({
        folderPath: folder,
        photoIds: ['photo.jpg'],
        timeEdit: { mode: 'offset', offsetMs: 3 * 3600 * 1000 },
      })
      .expect(200);

    const photo = res.body.photos[0];
    expect(photo.timestamp).toBe('2025-05-01T12:00:00.000Z');
    expect(photo.originalTimestamp).toBe('2025-05-01T09:00:00.000Z');
    expect(photo.timestampSource).toBe('exif');
    expect(photo.exifOffsetMinutes).toBe(540);
    expect(photo.isAutoLocated).toBe(true);
  });

  it('sets isAutoLocated only for auto-located overrides that have an effective location', async () => {
    const folder = await createFolder('auto-located-flags', {
      'auto.jpg': baseJpeg,
      'manual.jpg': baseJpeg,
      'removed.jpg': baseJpeg,
    });
    await writeSidecar(folder, {
      'auto.jpg': { location: PARIS, locationSource: 'auto-locate' },
      'manual.jpg': { location: TOKYO },
      'removed.jpg': { location: null, locationSource: 'auto-locate' },
    });

    const scan = await scanPhotoFolder(folder);

    expect(Object.fromEntries(scan.photos.map((p) => [p.fileName, p.isAutoLocated]))).toEqual({
      'auto.jpg': true,
      'manual.jpg': false,
      'removed.jpg': false,
    });
  });

  const manualLocationEdits: Array<{ mode: string; locationEdit: BatchLocationEdit }> = [
    {
      mode: 'set',
      locationEdit: { mode: 'set', location: { lat: 40.7128, lng: -74.006, name: 'New York, NY, USA' } },
    },
    { mode: 'remove', locationEdit: { mode: 'remove' } },
    { mode: 'restore', locationEdit: { mode: 'restore' } },
  ];

  it.each(manualLocationEdits)('clears locationSource on a batch location $mode edit', async ({ locationEdit }) => {
    const folder = await createFolder(`batch-location-${locationEdit.mode}`, {
      'photo.jpg': injectExifIntoJpeg(baseJpeg, {
        dateTimeOriginal: '2025:05:06 13:00:00',
        lat: TOKYO.lat,
        lng: TOKYO.lng,
      }),
    });
    await writeSidecar(folder, { 'photo.jpg': { location: PARIS, locationSource: 'auto-locate' } });
    const before = await scanSinglePhoto(folder);
    expect(before.isAutoLocated).toBe(true);
    expect(before.originalLocation).not.toBeNull();

    const res = await request(app)
      .patch('/api/photos/batch')
      .send({ folderPath: folder, photoIds: ['photo.jpg'], locationEdit })
      .expect(200);

    expect(res.body.photos[0].isAutoLocated).toBe(false);
    expect((await readSidecar(folder))['photo.jpg']?.locationSource).toBeUndefined();
  });
});
