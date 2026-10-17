import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import exifr from 'exifr';
import { injectExifIntoJpeg } from '../../server/exifWriter.ts';

describe('Server: EXIF metadata embedding and parsing', () => {
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
});
