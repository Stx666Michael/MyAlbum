import { describe, expect, it } from 'vitest';
import type { PhotoItem } from '../../src/types/photo.ts';
import {
  extractPlaceTokens,
  haversineKm,
  interpolateLatLng,
  jitter,
  mapRecordsLocations,
  mapTimelineRawSignals,
  mapTimelineSegments,
  matchCompanions,
  matchGazetteer,
  matchTrack,
  nearestPlaceName,
  parseGpx,
  photoUtcMs,
  pickSuggestion,
  sortByUtc,
  type PlaceCandidate,
  type TimeOptions,
  type TrackPoint,
} from '../../src/utils/autoLocate.ts';
import { PLACE_GAZETTEER, type GazetteerEntry } from '../../src/utils/placeGazetteer.ts';

const MINUTE = 60_000;
const T0 = Date.parse('2024-05-01T10:00:00Z');
const at = (minutes: number): number => T0 + minutes * MINUTE;

type PhotoTime = Pick<PhotoItem, 'timestamp' | 'timestampSource' | 'exifOffsetMinutes'>;

describe('haversineKm', () => {
  it('measures Tokyo to Paris as roughly 9,700 km', () => {
    const km = haversineKm({ lat: 35.6812, lng: 139.7671 }, { lat: 48.8566, lng: 2.3522 });
    expect(km).toBeGreaterThan(9650);
    expect(km).toBeLessThan(9750);
  });

  it('is zero for identical points', () => {
    expect(haversineKm({ lat: 10, lng: 20 }, { lat: 10, lng: 20 })).toBe(0);
  });
});

describe('interpolateLatLng', () => {
  it('interpolates linearly', () => {
    expect(interpolateLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5)).toEqual({ lat: 5, lng: 10 });
  });

  it('crosses the antimeridian and stays within [-180, 180]', () => {
    const mid = interpolateLatLng({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 0.5);
    expect(Math.abs(mid.lng)).toBe(180);
    expect(mid.lat).toBe(0);
  });

  it('takes the short way across the antimeridian in both directions', () => {
    expect(interpolateLatLng({ lat: 0, lng: 170 }, { lat: 0, lng: -170 }, 0.25).lng).toBeCloseTo(175, 9);
    expect(interpolateLatLng({ lat: 0, lng: -170 }, { lat: 0, lng: 170 }, 0.25).lng).toBeCloseTo(-175, 9);
  });
});

describe('jitter', () => {
  it('is deterministic for a photo id', () => {
    expect(jitter('IMG_0001')).toEqual(jitter('IMG_0001'));
  });

  it('keeps each offset within ±0.0003 degrees', () => {
    for (let i = 0; i < 500; i++) {
      const { dLat, dLng } = jitter(`photo-${i}`);
      expect(Math.abs(dLat)).toBeLessThanOrEqual(0.0003);
      expect(Math.abs(dLng)).toBeLessThanOrEqual(0.0003);
    }
  });

  it('differs between photo ids', () => {
    expect(jitter('photo-1')).not.toEqual(jitter('photo-2'));
  });
});

describe('parseGpx', () => {
  const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><trkseg>
    <trkpt lon="139.7671" lat="35.6812"><time>2024-05-01T10:00:00Z</time></trkpt>
    <trkpt lat='35.6900' lon='139.7700'><time>2024-05-01T10:05:00+09:00</time></trkpt>
    <trkpt lat="35.7000" lon="139.8000"/>
    <trkpt lat="35.7100" lon="139.8100"><ele>12</ele></trkpt>
  </trkseg></trk>
  <rtept lat="35.5" lon="139.5"><time>2024-05-01T09:00:00Z</time></rtept>
  <wpt lat="x" lon="139"><time>2024-05-01T09:30:00Z</time></wpt>
</gpx>`;

  it('reads lat and lon in either order and quote style, converts offsets, skips untimed points, and sorts', () => {
    expect(parseGpx(gpx)).toEqual([
      { utcMs: Date.parse('2024-05-01T01:05:00Z'), lat: 35.69, lng: 139.77 },
      { utcMs: Date.parse('2024-05-01T09:00:00Z'), lat: 35.5, lng: 139.5 },
      { utcMs: Date.parse('2024-05-01T10:00:00Z'), lat: 35.6812, lng: 139.7671 },
    ]);
  });
});

describe('mapRecordsLocations', () => {
  it('divides E7 values, accepts numeric strings, and reads timestampMs as a number or a string', () => {
    const points = mapRecordsLocations([
      { latitudeE7: 355812000, longitudeE7: '1397671000', timestampMs: String(T0) },
      { latitudeE7: '355900000', longitudeE7: 1397700000, timestampMs: T0 + 5 * MINUTE },
    ]);
    expect(points).toEqual([
      { utcMs: T0, lat: 35.5812, lng: 139.7671 },
      { utcMs: T0 + 5 * MINUTE, lat: 35.59, lng: 139.77 },
    ]);
  });

  it('prefers the ISO timestamp, skips invalid entries, applies keep, and does not sort', () => {
    const points = mapRecordsLocations(
      [
        { timestamp: '2024-05-01T10:00:00Z', timestampMs: '1', latitudeE7: 355812000, longitudeE7: 1397671000 },
        { latitudeE7: 355812000, longitudeE7: 1397671000 },
        { latitudeE7: 'abc', longitudeE7: 1397671000, timestampMs: T0 },
        { latitudeE7: 355812000, longitudeE7: 1397671000, timestampMs: T0 - 10 * MINUTE },
        { latitudeE7: 355812000, longitudeE7: 1397671000, timestampMs: T0 + 10 * MINUTE },
      ],
      (utcMs) => utcMs >= T0,
    );
    expect(points.map((point) => point.utcMs)).toEqual([T0, T0 + 10 * MINUTE]);
  });
});

describe('mapTimelineSegments', () => {
  const segments = [
    {
      startTime: '2024-05-01T10:00:00.000+09:00',
      endTime: '2024-05-01T11:00:00.000+09:00',
      visit: { topCandidate: { placeLocation: { latLng: '35.6812°, 139.7671°' } } },
    },
    {
      startTime: '2024-05-01T11:00:00.000+09:00',
      endTime: '2024-05-01T11:30:00.000+09:00',
      timelinePath: [
        { point: 'geo:35.6900,139.7700', durationMinutesOffsetFromStartTime: '0' },
        { point: '35.7000, 139.8000', durationMinutesOffsetFromStartTime: 15 },
        { point: 'nonsense', durationMinutesOffsetFromStartTime: '5' },
      ],
    },
  ];

  it('maps path offsets and visit start and end points', () => {
    expect(mapTimelineSegments(segments)).toEqual([
      { utcMs: Date.parse('2024-05-01T01:00:00Z'), lat: 35.6812, lng: 139.7671 },
      { utcMs: Date.parse('2024-05-01T02:00:00Z'), lat: 35.6812, lng: 139.7671 },
      { utcMs: Date.parse('2024-05-01T02:00:00Z'), lat: 35.69, lng: 139.77 },
      { utcMs: Date.parse('2024-05-01T02:15:00Z'), lat: 35.7, lng: 139.8 },
    ]);
  });

  it('applies keep', () => {
    const points = mapTimelineSegments(segments, (utcMs) => utcMs < Date.parse('2024-05-01T02:00:00Z'));
    expect(points.map((point) => point.utcMs)).toEqual([Date.parse('2024-05-01T01:00:00Z')]);
  });
});

describe('mapTimelineRawSignals', () => {
  it('reads position.LatLng with the item or position timestamp and skips invalid entries', () => {
    const points = mapTimelineRawSignals([
      { timestamp: '2024-05-01T01:00:00.000Z', position: { LatLng: '35.6812°, 139.7671°' } },
      { position: { LatLng: 'geo:35.69,139.77', timestamp: '2024-05-01T01:05:00.000Z' } },
      { position: { LatLng: 'bad', timestamp: '2024-05-01T01:10:00.000Z' } },
      { position: { LatLng: '35.7, 139.8' } },
    ]);
    expect(points).toEqual([
      { utcMs: Date.parse('2024-05-01T01:00:00Z'), lat: 35.6812, lng: 139.7671 },
      { utcMs: Date.parse('2024-05-01T01:05:00Z'), lat: 35.69, lng: 139.77 },
    ]);
  });
});

describe('sortByUtc', () => {
  it('sorts in place by utcMs and returns the same array', () => {
    const items = [{ utcMs: 3 }, { utcMs: 1 }, { utcMs: 2 }];
    const sorted = sortByUtc(items);
    expect(sorted).toBe(items);
    expect(items.map((item) => item.utcMs)).toEqual([1, 2, 3]);
  });
});

describe('photoUtcMs', () => {
  const exifPhoto: PhotoTime = {
    timestamp: '2024-05-01T10:00:00.000Z',
    timestampSource: 'exif',
    exifOffsetMinutes: 540,
  };
  const options: TimeOptions = { utcOffsetMinutes: 0, driftMinutes: 0, useEmbeddedOffset: true };

  it('uses the embedded EXIF offset when enabled', () => {
    expect(photoUtcMs(exifPhoto, options, 'anchor')).toBe(Date.parse('2024-05-01T01:00:00Z'));
  });

  it('uses utcOffsetMinutes when the embedded offset is disabled', () => {
    const utcOffsetOnly = { ...options, utcOffsetMinutes: 60, useEmbeddedOffset: false };
    expect(photoUtcMs(exifPhoto, utcOffsetOnly, 'anchor')).toBe(Date.parse('2024-05-01T09:00:00Z'));
  });

  it('falls back to utcOffsetMinutes when the photo has no embedded offset', () => {
    const noOffset: PhotoTime = { ...exifPhoto, exifOffsetMinutes: null };
    const withFallback = { ...options, utcOffsetMinutes: 60 };
    expect(photoUtcMs(noOffset, withFallback, 'anchor')).toBe(Date.parse('2024-05-01T09:00:00Z'));
  });

  it('treats a photo without timestampSource as EXIF wall-clock time', () => {
    const untagged: PhotoTime = { timestamp: '2024-05-01T10:00:00.000Z' };
    const withOffset = { ...options, utcOffsetMinutes: 540, useEmbeddedOffset: false };
    expect(photoUtcMs(untagged, withOffset, 'anchor')).toBe(Date.parse('2024-05-01T01:00:00Z'));
  });

  it('ignores offsets and drift for file timestamps', () => {
    const filePhoto: PhotoTime = {
      timestamp: '2024-05-01T10:00:00.000Z',
      timestampSource: 'file',
      exifOffsetMinutes: 540,
    };
    const shifted = { utcOffsetMinutes: 60, driftMinutes: 15, useEmbeddedOffset: true };
    expect(photoUtcMs(filePhoto, shifted, 'target')).toBe(Date.parse('2024-05-01T10:00:00Z'));
  });

  it('applies drift to target photos only', () => {
    const zeroOffset: PhotoTime = { ...exifPhoto, exifOffsetMinutes: 0 };
    const drifted = { utcOffsetMinutes: 0, driftMinutes: 5, useEmbeddedOffset: true };
    expect(photoUtcMs(zeroOffset, drifted, 'target')).toBe(Date.parse('2024-05-01T09:55:00Z'));
    expect(photoUtcMs(zeroOffset, drifted, 'anchor')).toBe(Date.parse('2024-05-01T10:00:00Z'));
  });

  it('returns null for an unparseable timestamp', () => {
    expect(photoUtcMs({ timestamp: 'not a date' }, options, 'target')).toBeNull();
  });
});

describe('matchTrack', () => {
  const track: TrackPoint[] = [
    { utcMs: at(0), lat: 35, lng: 139 },
    { utcMs: at(10), lat: 36, lng: 140 },
  ];

  it('interpolates between track points that bracket the photo', () => {
    const match = matchTrack(track, at(5), 30 * MINUTE);
    expect(match?.lat).toBeCloseTo(35.5, 9);
    expect(match?.lng).toBeCloseTo(139.5, 9);
    expect(match?.confidence).toBeCloseTo(0.9533, 3);
    expect(match?.reason).toBe('Track position interpolated (10 min between track points)');
  });

  it('uses the nearest point when only one side is inside the window', () => {
    const match = matchTrack([{ utcMs: at(0), lat: 35, lng: 139 }], at(20), 30 * MINUTE);
    expect(match?.lat).toBe(35);
    expect(match?.lng).toBe(139);
    expect(match?.confidence).toBeCloseTo(0.9133, 3);
    expect(match?.reason).toBe('Nearest track point 20 min away');
  });

  it('returns the exact coordinates of a track point at the photo time', () => {
    const match = matchTrack(track, at(10), 30 * MINUTE);
    expect(match?.lat).toBe(36);
    expect(match?.lng).toBe(140);
    expect(match?.confidence).toBeCloseTo(0.94, 9);
    expect(match?.reason).toBe('Nearest track point 0 min away');
  });

  it('returns null when every point is outside the window or there are no points', () => {
    expect(matchTrack(track, at(120), 30 * MINUTE)).toBeNull();
    expect(matchTrack([], at(0), 30 * MINUTE)).toBeNull();
  });

  it('falls back to the nearest point when two points imply more than 1000 km/h', () => {
    const jump: TrackPoint[] = [
      { utcMs: at(0), lat: 0, lng: 0 },
      { utcMs: at(10), lat: 0, lng: 20 },
    ];
    const match = matchTrack(jump, at(2), 30 * MINUTE);
    expect(match?.lat).toBe(0);
    expect(match?.lng).toBe(0);
    expect(match?.reason).toBe('Nearest track point 2 min away');
  });
});

describe('matchCompanions', () => {
  it('interpolates between located photos an hour apart', () => {
    const anchors = [
      { utcMs: at(0), lat: 35, lng: 139 },
      { utcMs: at(60), lat: 35, lng: 139.2 },
    ];
    const match = matchCompanions(anchors, at(30), 120 * MINUTE);
    expect(match?.lat).toBeCloseTo(35, 9);
    expect(match?.lng).toBeCloseTo(139.1, 9);
    expect(match?.confidence).toBeCloseTo(0.815, 6);
    expect(match?.reason).toBe('Between located photos 60 min apart');
  });

  it('uses the nearest anchor when the bracket is wider than two hours', () => {
    const anchors = [
      { utcMs: at(0), lat: 35, lng: 139 },
      { utcMs: at(180), lat: 35, lng: 139.5 },
    ];
    const match = matchCompanions(anchors, at(60), 120 * MINUTE);
    expect(match?.lng).toBe(139);
    expect(match?.confidence).toBeCloseTo(0.725, 6);
    expect(match?.reason).toBe('Nearest located photo 60 min away');
  });

  it('does not interpolate anchors more than 100 km apart', () => {
    const anchors = [
      { utcMs: at(0), lat: 35.6812, lng: 139.7671 },
      { utcMs: at(60), lat: 34.6937, lng: 135.5023 },
    ];
    const match = matchCompanions(anchors, at(20), 120 * MINUTE);
    expect(match?.lat).toBe(35.6812);
    expect(match?.lng).toBe(139.7671);
    expect(match?.confidence).toBeCloseTo(0.775, 6);
    expect(match?.reason).toBe('Nearest located photo 20 min away');
  });

  it('returns null when no anchor is within the window', () => {
    expect(matchCompanions([{ utcMs: at(0), lat: 35, lng: 139 }], at(300), 60 * MINUTE)).toBeNull();
    expect(matchCompanions([], at(0), 60 * MINUTE)).toBeNull();
  });
});

describe('extractPlaceTokens', () => {
  it('drops camera codes, numbers, and date stamps', () => {
    expect(extractPlaceTokens('', 'IMG_1001_Meiji_Shrine_Mist.jpg')).toEqual(['Meiji', 'Shrine', 'Mist']);
  });

  it('reads folders deepest first and drops day labels', () => {
    expect(extractPlaceTokens('2025-07-Tokyo\\Day1-Shibuya', 'DSC_0001.jpg')).toEqual(['Shibuya', 'Tokyo']);
  });

  it('keeps the first occurrence of case-insensitive duplicates', () => {
    expect(extractPlaceTokens('Tokyo/Day 2', 'tokyo_Tower_20240501.jpg')).toEqual(['tokyo', 'Tower']);
  });

  it('drops month names and generic photo words', () => {
    expect(extractPlaceTokens('Copy of Trip\\July2025', 'Edit_Portrait_Sumida.jpg')).toEqual(['Sumida']);
  });

  it('keeps place names that merely start with a month abbreviation', () => {
    expect(extractPlaceTokens('', 'Maryland.jpg')).toEqual(['Maryland']);
  });
});

describe('matchGazetteer', () => {
  it('matches a landmark alias with confidence 0.80', () => {
    const match = matchGazetteer(['Meiji', 'Shrine', 'Mist'], PLACE_GAZETTEER);
    expect(match?.entry.name).toBe('Meiji Jingu');
    expect(match?.matchedText).toBe('Meiji Shrine');
    expect(match?.confidence).toBe(0.8);
    expect(match?.reason).toBe('Name "Meiji Shrine" matches Meiji Jingu');
  });

  it('matches case-insensitively and across accents', () => {
    expect(matchGazetteer(['TOKYO'], PLACE_GAZETTEER)?.entry.name).toBe('Tokyo');
    expect(matchGazetteer(['Tōkyō'], PLACE_GAZETTEER)?.entry.name).toBe('Tokyo');
  });

  it('gives region and country matches confidence 0.55', () => {
    expect(matchGazetteer(['Hokkaido'], PLACE_GAZETTEER)?.confidence).toBe(0.55);
    expect(matchGazetteer(['Japan'], PLACE_GAZETTEER)?.confidence).toBe(0.55);
  });

  it('prefers the longest phrase', () => {
    const match = matchGazetteer(['Tokyo', 'Tower'], PLACE_GAZETTEER);
    expect(match?.entry.name).toBe('Tokyo Tower');
    expect(match?.matchedText).toBe('Tokyo Tower');
  });

  it('matches names whose connector words were dropped from the tokens', () => {
    const match = matchGazetteer(['Notre', 'Dame', 'Paris'], PLACE_GAZETTEER);
    expect(match?.entry.name).toBe('Notre-Dame de Paris');
    expect(match?.matchedText).toBe('Notre Dame Paris');
  });

  it('keeps "New" so multi-word names such as New York still match', () => {
    const tokens = extractPlaceTokens('2024\\New York Weekend', 'IMG_2001.jpg');
    expect(tokens).toEqual(['New', 'York']);
    expect(matchGazetteer(tokens, PLACE_GAZETTEER)?.entry.name).toBe('New York');
    expect(matchGazetteer(['New', 'Delhi'], PLACE_GAZETTEER)?.entry.name).toBe('Delhi');
  });

  it('returns null when nothing matches', () => {
    expect(matchGazetteer(['Zzyzx', 'Quux'], PLACE_GAZETTEER)).toBeNull();
  });
});

describe('nearestPlaceName', () => {
  const towns: GazetteerEntry[] = [
    { name: 'Alpha', kind: 'city', lat: 0, lng: 0 },
    { name: 'Beta', kind: 'city', lat: 0, lng: 1 },
  ];

  it('names the nearest place within 50 km', () => {
    expect(nearestPlaceName(0.05, 0.1, towns)).toBe('Near Alpha');
    expect(nearestPlaceName(0, 0.9, towns)).toBe('Near Beta');
  });

  it('returns null beyond the distance limit', () => {
    expect(nearestPlaceName(0, 0.5, towns)).toBeNull();
    expect(nearestPlaceName(0, 0.2, towns, 10)).toBeNull();
    expect(nearestPlaceName(10, 10, towns)).toBeNull();
  });
});

describe('pickSuggestion', () => {
  const candidate = (
    strategy: PlaceCandidate['strategy'],
    confidence: number,
    name: string = strategy,
  ): PlaceCandidate => ({
    strategy,
    lat: 1,
    lng: 2,
    name,
    confidence,
    reason: 'test',
  });

  it('prefers track, then companion, then gazetteer, then nominatim, then ai', () => {
    const all = [
      candidate('ai', 0.99),
      candidate('nominatim', 0.95),
      candidate('gazetteer', 0.8),
      candidate('companion', 0.7),
      candidate('track', 0.91),
    ];
    expect(pickSuggestion(all)?.strategy).toBe('track');
    expect(pickSuggestion(all.filter((item) => item.strategy !== 'track'))?.strategy).toBe('companion');
    const withoutTrackOrCompanion = all.filter(
      (item) => item.strategy === 'gazetteer' || item.strategy === 'nominatim' || item.strategy === 'ai',
    );
    expect(pickSuggestion(withoutTrackOrCompanion)?.strategy).toBe('gazetteer');
    const nominatimAndAi = all.filter((item) => item.strategy === 'nominatim' || item.strategy === 'ai');
    expect(pickSuggestion(nominatimAndAi)?.strategy).toBe('nominatim');
    expect(pickSuggestion([candidate('ai', 0.75)])?.strategy).toBe('ai');
  });

  it('ranks a lower-confidence track above a higher-confidence companion', () => {
    expect(pickSuggestion([candidate('companion', 0.94), candidate('track', 0.9)])?.strategy).toBe('track');
  });

  it('picks the highest confidence within one strategy', () => {
    const picked = pickSuggestion([candidate('gazetteer', 0.55, 'Japan'), candidate('gazetteer', 0.8, 'Tokyo')]);
    expect(picked?.name).toBe('Tokyo');
  });

  it('returns null for an empty list', () => {
    expect(pickSuggestion([])).toBeNull();
  });
});
