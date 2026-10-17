import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTrackFile, TrackFormatError } from '../../server/trackReader.ts';

// Scratch files live in the gitignored test-results/ folder because temp directories are not writable here.
const SCRATCH_ROOT = fileURLToPath(new URL('../../test-results/', import.meta.url));
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const BASE_MS = Date.UTC(2026, 0, 1);

const GPX_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="track-reader-test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="35.6586" lon="139.7454"><time>2026-01-01T00:00:00Z</time></wpt>
  <trk>
    <trkseg>
      <trkpt lon="139.76" lat="35.68"><time>2026-01-01T01:00:00Z</time></trkpt>
      <trkpt lon="139.77" lat="35.69"><time>2026-01-01T10:30:00+09:00</time></trkpt>
    </trkseg>
  </trk>
  <rte>
    <rtept lon="139.8" lat="35.7"><time>2026-01-01T03:00:00Z</time></rtept>
  </rte>
</gpx>`;

let scratchDir = '';

function iso(utcMs: number): string {
  return new Date(utcMs).toISOString();
}

async function writeFixture(name: string, content: string): Promise<string> {
  const filePath = path.join(scratchDir, name);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

async function writeLargeRecords(filePath: string, count: number): Promise<void> {
  const handle = await fs.open(filePath, 'w');
  try {
    await handle.write('{"locations":[');
    const chunkSize = 5000;
    for (let start = 0; start < count; start += chunkSize) {
      const items: string[] = [];
      for (let i = start; i < Math.min(start + chunkSize, count); i++) {
        // 7919 is coprime with count, so every minute appears once, in shuffled order.
        const minute = (i * 7919) % count;
        items.push(
          JSON.stringify({
            timestampMs: String(BASE_MS + minute * MINUTE_MS),
            latitudeE7: 350000000 + i,
            longitudeE7: 1390000000 + i,
          }),
        );
      }
      await handle.write((start === 0 ? '' : ',') + items.join(','));
    }
    await handle.write(']}');
  } finally {
    await handle.close();
  }
}

beforeAll(async () => {
  await fs.mkdir(SCRATCH_ROOT, { recursive: true });
  scratchDir = await fs.mkdtemp(path.join(SCRATCH_ROOT, 'myalbum-track-reader-'));
});

afterAll(async () => {
  if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
});

describe('readTrackFile GPX', () => {
  it('reads trkpt, rtept and wpt points with mixed attribute order and offsets', async () => {
    const filePath = await writeFixture('track.gpx', GPX_TEXT);
    const result = await readTrackFile(filePath);

    expect(result.format).toBe('gpx');
    expect(result.points).toEqual([
      { lat: 35.6586, lng: 139.7454, utcMs: BASE_MS },
      { lat: 35.68, lng: 139.76, utcMs: BASE_MS + HOUR_MS },
      { lat: 35.69, lng: 139.77, utcMs: BASE_MS + HOUR_MS + 30 * MINUTE_MS },
      { lat: 35.7, lng: 139.8, utcMs: BASE_MS + 3 * HOUR_MS },
    ]);
    expect(result.spanStartMs).toBe(BASE_MS);
    expect(result.spanEndMs).toBe(BASE_MS + 3 * HOUR_MS);
  });

  it('filters points to the window while the span still covers the whole file', async () => {
    const filePath = await writeFixture('track-window.gpx', GPX_TEXT);
    const result = await readTrackFile(filePath, {
      startMs: BASE_MS + HOUR_MS,
      endMs: BASE_MS + 2 * HOUR_MS,
    });

    expect(result.points.map((point) => point.utcMs)).toEqual([
      BASE_MS + HOUR_MS,
      BASE_MS + HOUR_MS + 30 * MINUTE_MS,
    ]);
    expect(result.spanStartMs).toBe(BASE_MS);
    expect(result.spanEndMs).toBe(BASE_MS + 3 * HOUR_MS);
  });
});

describe('readTrackFile Records.json', () => {
  const records = {
    locations: [
      {
        timestamp: iso(BASE_MS + 2 * HOUR_MS),
        latitudeE7: 356800000,
        longitudeE7: 1397600000,
        accuracy: 12,
      },
      { timestampMs: String(BASE_MS + HOUR_MS), latitudeE7: 356900000, longitudeE7: 1397700000 },
      { timestamp: iso(BASE_MS + 30 * MINUTE_MS), latitudeE7: 357000000, longitudeE7: 1397800000 },
      { timestampMs: BASE_MS + 3 * HOUR_MS, latitudeE7: 357100000, longitudeE7: 1397900000 },
      { latitudeE7: 357200000, longitudeE7: 1398000000 },
      { timestamp: iso(BASE_MS + 4 * HOUR_MS), latitudeE7: 910000000, longitudeE7: 0 },
    ],
  };

  it('returns points sorted by UTC with the span covering every usable item', async () => {
    const filePath = await writeFixture('records.json', JSON.stringify(records));
    const result = await readTrackFile(filePath);

    expect(result.format).toBe('records');
    expect(result.points).toEqual([
      { lat: 35.7, lng: 139.78, utcMs: BASE_MS + 30 * MINUTE_MS },
      { lat: 35.69, lng: 139.77, utcMs: BASE_MS + HOUR_MS },
      { lat: 35.68, lng: 139.76, utcMs: BASE_MS + 2 * HOUR_MS },
      { lat: 35.71, lng: 139.79, utcMs: BASE_MS + 3 * HOUR_MS },
    ]);
    expect(result.spanStartMs).toBe(BASE_MS + 30 * MINUTE_MS);
    expect(result.spanEndMs).toBe(BASE_MS + 3 * HOUR_MS);
  });

  it('keeps only points inside the window, with inclusive bounds', async () => {
    const filePath = await writeFixture('records-window.json', JSON.stringify(records));
    const result = await readTrackFile(filePath, {
      startMs: BASE_MS + HOUR_MS,
      endMs: BASE_MS + 2 * HOUR_MS,
    });

    expect(result.points.map((point) => point.utcMs)).toEqual([BASE_MS + HOUR_MS, BASE_MS + 2 * HOUR_MS]);
    expect(result.spanStartMs).toBe(BASE_MS + 30 * MINUTE_MS);
    expect(result.spanEndMs).toBe(BASE_MS + 3 * HOUR_MS);
  });

  it('detects Records when a location item contains a nested semanticSegments key', async () => {
    const filePath = await writeFixture(
      'records-nested-trap.json',
      JSON.stringify({
        locations: [
          {
            timestampMs: String(BASE_MS),
            latitudeE7: 350000000,
            longitudeE7: 1390000000,
            semanticSegments: [{ startTime: iso(BASE_MS), timelinePath: [] }],
          },
        ],
      }),
    );
    const result = await readTrackFile(filePath);

    expect(result.format).toBe('records');
    expect(result.points).toEqual([{ lat: 35, lng: 139, utcMs: BASE_MS }]);
  });

  it('ignores nested semanticSegments and rawSignals under unknown root keys', async () => {
    const filePath = await writeFixture(
      'records-unknown-root-trap.json',
      JSON.stringify({
        meta: { semanticSegments: [{ startTime: iso(BASE_MS) }], rawSignals: [] },
        locations: [{ timestampMs: String(BASE_MS), latitudeE7: 350000000, longitudeE7: 1390000000 }],
      }),
    );
    const result = await readTrackFile(filePath);

    expect(result.format).toBe('records');
    expect(result.points).toHaveLength(1);
  });
});

describe('readTrackFile on-device Timeline.json', () => {
  it('merges semanticSegments and rawSignals points after an unknown root key', async () => {
    const filePath = await writeFixture(
      'timeline.json',
      JSON.stringify({
        userLocationProfile: { frequentPlaces: [{ placeId: 'home', label: 'HOME' }] },
        semanticSegments: [
          {
            startTime: iso(BASE_MS),
            endTime: iso(BASE_MS + 2 * HOUR_MS),
            timelinePath: [{ point: '35.6800°, 139.7600°', durationMinutesOffsetFromStartTime: '60' }],
          },
          {
            startTime: iso(BASE_MS + 4 * HOUR_MS),
            endTime: iso(BASE_MS + 5 * HOUR_MS),
            visit: { topCandidate: { placeLocation: { latLng: 'geo:35.7100,139.8100' } } },
          },
        ],
        rawSignals: [
          { position: { LatLng: 'geo:35.6900°, 139.7700°', timestamp: iso(BASE_MS + 90 * MINUTE_MS) } },
          {
            position: { LatLng: '35.7000°, 139.8000°' },
            timestamp: iso(BASE_MS + 3 * HOUR_MS),
            // A nested key must not be read as a root-level semanticSegments array.
            semanticSegments: [
              {
                startTime: iso(BASE_MS + 6 * HOUR_MS),
                endTime: iso(BASE_MS + 6 * HOUR_MS),
                visit: { topCandidate: { placeLocation: { latLng: 'geo:36.0000,140.0000' } } },
              },
            ],
          },
        ],
      }),
    );
    const result = await readTrackFile(filePath);

    expect(result.format).toBe('timeline');
    expect(result.points).toEqual([
      { lat: 35.68, lng: 139.76, utcMs: BASE_MS + HOUR_MS },
      { lat: 35.69, lng: 139.77, utcMs: BASE_MS + 90 * MINUTE_MS },
      { lat: 35.7, lng: 139.8, utcMs: BASE_MS + 3 * HOUR_MS },
      { lat: 35.71, lng: 139.81, utcMs: BASE_MS + 4 * HOUR_MS },
      { lat: 35.71, lng: 139.81, utcMs: BASE_MS + 5 * HOUR_MS },
    ]);
    expect(result.spanStartMs).toBe(BASE_MS + HOUR_MS);
    expect(result.spanEndMs).toBe(BASE_MS + 5 * HOUR_MS);
  });

  it('filters merged timeline points to the window', async () => {
    const filePath = await writeFixture(
      'timeline-window.json',
      JSON.stringify({
        semanticSegments: [
          {
            startTime: iso(BASE_MS),
            endTime: iso(BASE_MS + 2 * HOUR_MS),
            timelinePath: [{ point: '35.6800°, 139.7600°', durationMinutesOffsetFromStartTime: '60' }],
          },
        ],
        rawSignals: [
          { position: { LatLng: 'geo:35.6900°, 139.7700°', timestamp: iso(BASE_MS + 90 * MINUTE_MS) } },
          { position: { LatLng: '35.7000°, 139.8000°', timestamp: iso(BASE_MS + 3 * HOUR_MS) } },
        ],
      }),
    );
    const result = await readTrackFile(filePath, {
      startMs: BASE_MS + 90 * MINUTE_MS,
      endMs: BASE_MS + 3 * HOUR_MS,
    });

    expect(result.points.map((point) => point.utcMs)).toEqual([BASE_MS + 90 * MINUTE_MS, BASE_MS + 3 * HOUR_MS]);
    expect(result.spanStartMs).toBe(BASE_MS + HOUR_MS);
    expect(result.spanEndMs).toBe(BASE_MS + 3 * HOUR_MS);
  });
});

describe('readTrackFile rejects unsupported input', () => {
  it('rejects legacy Semantic Location History files', async () => {
    const filePath = await writeFixture(
      'legacy.json',
      JSON.stringify({ timelineObjects: [{ placeVisit: { duration: {} } }] }),
    );

    await expect(readTrackFile(filePath)).rejects.toBeInstanceOf(TrackFormatError);
    await expect(readTrackFile(filePath)).rejects.toThrow('Semantic Location History');
  });

  it('rejects JSON with no recognised root keys', async () => {
    const filePath = await writeFixture('unknown.json', '{"foo": []}');

    await expect(readTrackFile(filePath)).rejects.toBeInstanceOf(TrackFormatError);
  });

  it('rejects malformed JSON with an error instead of hanging', async () => {
    const filePath = await writeFixture('broken.json', 'not json');

    await expect(readTrackFile(filePath)).rejects.toThrow();
  });

  it('rejects unsupported extensions', async () => {
    const filePath = await writeFixture('points.csv', 'lat,lng,time\n35.68,139.76,2026-01-01T01:00:00Z');

    await expect(readTrackFile(filePath)).rejects.toBeInstanceOf(TrackFormatError);
    await expect(readTrackFile(filePath)).rejects.toThrow('Track file must be .gpx or .json');
  });
});

describe('readTrackFile large Records.json', () => {
  it('streams 30,000 out-of-order items into sorted points', async () => {
    const count = 30_000;
    const filePath = path.join(scratchDir, 'large-records.json');
    await writeLargeRecords(filePath, count);

    const result = await readTrackFile(filePath);
    expect(result.format).toBe('records');
    expect(result.points).toHaveLength(count);
    expect(result.points.findIndex((point, index) => point.utcMs !== BASE_MS + index * MINUTE_MS)).toBe(-1);
    expect(result.spanStartMs).toBe(BASE_MS);
    expect(result.spanEndMs).toBe(BASE_MS + (count - 1) * MINUTE_MS);

    const windowed = await readTrackFile(filePath, {
      startMs: BASE_MS,
      endMs: BASE_MS + (count / 2 - 1) * MINUTE_MS,
    });
    expect(windowed.points).toHaveLength(count / 2);
    expect(windowed.spanEndMs).toBe(BASE_MS + (count - 1) * MINUTE_MS);
  });
});
