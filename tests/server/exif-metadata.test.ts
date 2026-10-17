import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import exifr from 'exifr';
import { injectExifIntoJpeg, type RawExifInput } from '../../server/exifWriter.ts';

// Same options as exifr.parse in scanPhotoFolder (server/app.ts), so these tests read tags the way the scanner does.
const SCAN_EXIFR_OPTIONS = { tiff: true, exif: true, gps: true };

const MALFORMED_OFFSETS = ['0900', '+9:00', '+09:0', '09:00', '+09:00Z', 'UTC', '+09-00', '', ' +09:00', '+15:00', '+09:60'];

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

describe('Server: EXIF OffsetTime tags', () => {
  async function makeJpeg(exif: RawExifInput): Promise<Buffer> {
    const rawJpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 60, b: 120 } },
    })
      .jpeg()
      .toBuffer();
    return injectExifIntoJpeg(rawJpeg, exif);
  }

  it('reads OffsetTimeOriginal "+09:00" written beside DateTimeOriginal', async () => {
    const jpeg = await makeJpeg({ dateTimeOriginal: '2025:05:01 09:00:00', offsetTimeOriginal: '+09:00' });

    const parsed = await exifr.parse(jpeg, SCAN_EXIFR_OPTIONS);
    const taken: Date = parsed.DateTimeOriginal;
    expect([taken.getFullYear(), taken.getMonth() + 1, taken.getDate(), taken.getHours()]).toEqual([2025, 5, 1, 9]);
    expect(parsed.OffsetTimeOriginal).toBe('+09:00');
  });

  it('reads a negative OffsetTimeOriginal "-05:30"', async () => {
    const jpeg = await makeJpeg({ dateTimeOriginal: '2025:05:01 09:00:00', offsetTimeOriginal: '-05:30' });

    const parsed = await exifr.parse(jpeg, SCAN_EXIFR_OPTIONS);
    expect(parsed.OffsetTimeOriginal).toBe('-05:30');
  });

  it('reads OffsetTimeDigitized "+09:00" written beside CreateDate', async () => {
    const jpeg = await makeJpeg({ dateTimeOriginal: '2025:05:01 09:00:00', offsetTimeDigitized: '+09:00' });

    const parsed = await exifr.parse(jpeg, SCAN_EXIFR_OPTIONS);
    expect(parsed.OffsetTimeDigitized).toBe('+09:00');
  });

  it('keeps both offsets when they are written together', async () => {
    const jpeg = await makeJpeg({
      dateTimeOriginal: '2025:05:01 09:00:00',
      offsetTimeOriginal: '+09:00',
      offsetTimeDigitized: '-05:30',
    });

    const parsed = await exifr.parse(jpeg, SCAN_EXIFR_OPTIONS);
    expect(parsed.OffsetTimeOriginal).toBe('+09:00');
    expect(parsed.OffsetTimeDigitized).toBe('-05:30');
  });

  it('keeps camera, exposure and GPS tags readable when offsets are written too', async () => {
    const jpeg = await makeJpeg({
      make: 'Hasselblad',
      model: 'X2D 100C',
      lensModel: 'XCD 55mm f/2.5V',
      dateTimeOriginal: '2025:05:01 09:00:00',
      offsetTimeOriginal: '+09:00',
      offsetTimeDigitized: '+09:00',
      exposureTime: [1, 500],
      fNumber: 2.5,
      iso: 64,
      focalLength: 55,
      width: 320,
      height: 240,
      lat: -33.8568,
      lng: 151.2153,
    });

    expect((await sharp(jpeg).metadata()).width).toBe(64);
    const parsed = await exifr.parse(jpeg, SCAN_EXIFR_OPTIONS);
    expect(parsed.Make).toBe('Hasselblad');
    expect(parsed.Model).toBe('X2D 100C');
    expect(parsed.LensModel).toBe('XCD 55mm f/2.5V');
    expect(parsed.ISO).toBe(64);
    expect(parsed.FNumber).toBeCloseTo(2.5, 1);
    expect(parsed.FocalLength).toBeCloseTo(55, 1);
    expect(parsed.latitude).toBeCloseTo(-33.8568, 3);
    expect(parsed.longitude).toBeCloseTo(151.2153, 3);
    expect(parsed.OffsetTimeOriginal).toBe('+09:00');
    expect(parsed.OffsetTimeDigitized).toBe('+09:00');
  });

  it('writes no OffsetTime tags when no offsets are given', async () => {
    const jpeg = await makeJpeg({ dateTimeOriginal: '2025:05:01 09:00:00' });

    const parsed = await exifr.parse(jpeg, SCAN_EXIFR_OPTIONS);
    expect(parsed.OffsetTimeOriginal).toBeUndefined();
    expect(parsed.OffsetTimeDigitized).toBeUndefined();
    expect(parsed.DateTimeOriginal).toBeInstanceOf(Date);
  });

  it('names the field and the expected format in the error for a malformed offset', async () => {
    await expect(makeJpeg({ offsetTimeDigitized: '0900' })).rejects.toThrow(
      'Invalid offsetTimeDigitized "0900": expected "+HH:MM" or "-HH:MM" (hours 00-14, minutes 00-59)'
    );
  });

  it.each(MALFORMED_OFFSETS)('rejects malformed offsetTimeOriginal %j', async (value) => {
    await expect(makeJpeg({ offsetTimeOriginal: value })).rejects.toThrow(`Invalid offsetTimeOriginal "${value}"`);
  });

  it.each(MALFORMED_OFFSETS)('rejects malformed offsetTimeDigitized %j', async (value) => {
    await expect(makeJpeg({ offsetTimeDigitized: value })).rejects.toThrow(`Invalid offsetTimeDigitized "${value}"`);
  });
});
