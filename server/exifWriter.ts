export interface RawExifInput {
  make?: string;
  model?: string;
  lensModel?: string;
  dateTimeOriginal?: string; // ISO string or "YYYY:MM:DD HH:MM:SS"
  offsetTimeOriginal?: string; // "+HH:MM" or "-HH:MM", written as tag 0x9011
  offsetTimeDigitized?: string; // "+HH:MM" or "-HH:MM", written as tag 0x9012
  exposureTime?: [number, number]; // [numerator, denominator]
  fNumber?: number; // e.g. 2.8
  iso?: number;
  focalLength?: number;
  width?: number;
  height?: number;
  lat?: number;
  lng?: number;
}

interface IfdEntrySpec {
  tag: number;
  type: 1 | 2 | 3 | 4 | 5;
  count: number;
  data: Buffer;
}

function asciiEntry(tag: number, str: string): IfdEntrySpec {
  const buf = Buffer.from(str + '\0', 'utf8');
  return { tag, type: 2, count: buf.length, data: buf };
}

function shortEntry(tag: number, val: number): IfdEntrySpec {
  const buf = Buffer.alloc(4, 0);
  buf.writeUInt16LE(val, 0);
  return { tag, type: 3, count: 1, data: buf };
}

function longEntry(tag: number, val: number): IfdEntrySpec {
  const buf = Buffer.alloc(4, 0);
  buf.writeUInt32LE(val, 0);
  return { tag, type: 4, count: 1, data: buf };
}

function rationalEntry(tag: number, num: number, den: number): IfdEntrySpec {
  const buf = Buffer.alloc(8, 0);
  buf.writeUInt32LE(Math.max(0, Math.round(num)), 0);
  buf.writeUInt32LE(Math.max(1, Math.round(den)), 4);
  return { tag, type: 5, count: 1, data: buf };
}

function gpsCoordEntry(tag: number, absDeg: number): IfdEntrySpec {
  const deg = Math.floor(absDeg);
  const minFloat = (absDeg - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 10000);
  const buf = Buffer.alloc(24, 0);
  buf.writeUInt32LE(deg, 0);
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(min, 8);
  buf.writeUInt32LE(1, 12);
  buf.writeUInt32LE(sec, 16);
  buf.writeUInt32LE(10000, 20);
  return { tag, type: 5, count: 3, data: buf };
}

// Hours are capped at 14, the largest real UTC offset (UTC+14:00).
const UTC_OFFSET_PATTERN = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;

function checkUtcOffset(field: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !UTC_OFFSET_PATTERN.test(value)) {
    throw new Error(`Invalid ${field} "${String(value)}": expected "+HH:MM" or "-HH:MM" (hours 00-14, minutes 00-59)`);
  }
  return value;
}

export function formatExifDate(isoOrExif: string): string {
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(isoOrExif)) {
    return isoOrExif;
  }
  const d = new Date(isoOrExif);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function serializeIfd(entries: IfdEntrySpec[], ifdStartOffset: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const headerSize = 2 + sorted.length * 12 + 4;
  let dataOffset = ifdStartOffset + headerSize;

  const headerBuf = Buffer.alloc(headerSize, 0);
  headerBuf.writeUInt16LE(sorted.length, 0);

  const extraBuffers: Buffer[] = [];

  sorted.forEach((entry, idx) => {
    const pos = 2 + idx * 12;
    headerBuf.writeUInt16LE(entry.tag, pos);
    headerBuf.writeUInt16LE(entry.type, pos + 2);
    headerBuf.writeUInt32LE(entry.count, pos + 4);

    if (entry.data.length <= 4) {
      entry.data.copy(headerBuf, pos + 8);
    } else {
      headerBuf.writeUInt32LE(dataOffset, pos + 8);
      extraBuffers.push(entry.data);
      dataOffset += entry.data.length;
      if (entry.data.length % 2 === 1) {
        extraBuffers.push(Buffer.from([0]));
        dataOffset += 1;
      }
    }
  });

  // Next IFD offset = 0
  headerBuf.writeUInt32LE(0, 2 + sorted.length * 12);

  return Buffer.concat([headerBuf, ...extraBuffers]);
}

export function buildExifApp1Segment(input: RawExifInput): Buffer {
  const hasGps = typeof input.lat === 'number' && typeof input.lng === 'number';
  const dateStr = input.dateTimeOriginal ? formatExifDate(input.dateTimeOriginal) : undefined;
  const offsetTimeOriginal = checkUtcOffset('offsetTimeOriginal', input.offsetTimeOriginal);
  const offsetTimeDigitized = checkUtcOffset('offsetTimeDigitized', input.offsetTimeDigitized);

  // Build Exif SubIFD entries
  const exifEntries: IfdEntrySpec[] = [];
  if (input.exposureTime) {
    exifEntries.push(rationalEntry(0x829a, input.exposureTime[0], input.exposureTime[1]));
  }
  if (typeof input.fNumber === 'number') {
    exifEntries.push(rationalEntry(0x829d, Math.round(input.fNumber * 100), 100));
  }
  if (typeof input.iso === 'number') {
    exifEntries.push(shortEntry(0x8827, input.iso));
  }
  if (dateStr) {
    exifEntries.push(asciiEntry(0x9003, dateStr));
    exifEntries.push(asciiEntry(0x9004, dateStr));
  }
  if (offsetTimeOriginal) {
    exifEntries.push(asciiEntry(0x9011, offsetTimeOriginal));
  }
  if (offsetTimeDigitized) {
    exifEntries.push(asciiEntry(0x9012, offsetTimeDigitized));
  }
  if (typeof input.focalLength === 'number') {
    exifEntries.push(rationalEntry(0x920a, Math.round(input.focalLength * 10), 10));
  }
  if (typeof input.width === 'number') {
    exifEntries.push(longEntry(0xa002, input.width));
  }
  if (typeof input.height === 'number') {
    exifEntries.push(longEntry(0xa003, input.height));
  }
  if (input.lensModel) {
    exifEntries.push(asciiEntry(0xa434, input.lensModel));
  }

  // Build GPS SubIFD entries
  const gpsEntries: IfdEntrySpec[] = [];
  if (hasGps && input.lat !== undefined && input.lng !== undefined) {
    gpsEntries.push(asciiEntry(0x0001, input.lat >= 0 ? 'N' : 'S'));
    gpsEntries.push(gpsCoordEntry(0x0002, Math.abs(input.lat)));
    gpsEntries.push(asciiEntry(0x0003, input.lng >= 0 ? 'E' : 'W'));
    gpsEntries.push(gpsCoordEntry(0x0004, Math.abs(input.lng)));
  }

  // First pass to compute IFD0 size
  const makeIfd0Entries = (exifOffset: number, gpsOffset: number): IfdEntrySpec[] => {
    const list: IfdEntrySpec[] = [];
    if (input.make) list.push(asciiEntry(0x010f, input.make));
    if (input.model) list.push(asciiEntry(0x0110, input.model));
    if (dateStr) list.push(asciiEntry(0x0132, dateStr));
    list.push(longEntry(0x8769, exifOffset));
    if (hasGps) {
      list.push(longEntry(0x8825, gpsOffset));
    }
    return list;
  };

  const tiffHeader = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const ifd0Start = 8;
  const dummyIfd0 = serializeIfd(makeIfd0Entries(0, 0), ifd0Start);
  const exifIfdStart = ifd0Start + dummyIfd0.length;
  const exifIfdBuf = serializeIfd(exifEntries, exifIfdStart);
  const gpsIfdStart = exifIfdStart + exifIfdBuf.length;
  const gpsIfdBuf = hasGps ? serializeIfd(gpsEntries, gpsIfdStart) : Buffer.alloc(0);

  const finalIfd0Buf = serializeIfd(makeIfd0Entries(exifIfdStart, gpsIfdStart), ifd0Start);
  const tiffPayload = Buffer.concat([tiffHeader, finalIfd0Buf, exifIfdBuf, gpsIfdBuf]);

  const exifHeader = Buffer.from('Exif\0\0', 'ascii');
  const app1Data = Buffer.concat([exifHeader, tiffPayload]);
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1;
  marker.writeUInt16BE(app1Data.length + 2, 2);

  return Buffer.concat([marker, app1Data]);
}

export function injectExifIntoJpeg(jpegBuffer: Buffer, exif: RawExifInput): Buffer {
  if (jpegBuffer.length < 2 || jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) {
    throw new Error('Invalid JPEG buffer: missing SOI marker');
  }
  const app1 = buildExifApp1Segment(exif);
  return Buffer.concat([jpegBuffer.subarray(0, 2), app1, jpegBuffer.subarray(2)]);
}
