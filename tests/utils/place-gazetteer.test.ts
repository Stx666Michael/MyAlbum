import { describe, expect, it } from 'vitest';
import {
  PLACE_GAZETTEER,
  type GazetteerEntry,
  type GazetteerKind,
} from '../../src/utils/placeGazetteer.ts';

const KINDS: readonly GazetteerKind[] = ['city', 'landmark', 'region', 'country'];

const GENERIC_WORDS = new Set([
  'airport', 'autumn', 'bay', 'beach', 'coast', 'copy', 'day', 'desert', 'edit', 'harbor',
  'harbour', 'highlands', 'hotel', 'lake', 'market', 'museum', 'park', 'portrait', 'session',
  'spring', 'station', 'studio', 'temple', 'tower', 'trip',
]);

const DEMO_PLACES = [
  'Tokyo',
  'Paris',
  'Iceland',
  'Iceland Highlands',
  'Iceland South Coast',
  'Snaefellsnes',
  'New York',
  'Cairo',
  'Sydney',
  'Shibuya',
  'Asakusa',
  'Grundarfjordur',
  'Seltjarnarnes',
  'Brooklyn',
  'Champ de Mars',
];

// [query, lat, lng]: WORLD_PRESETS in src/components/BatchEditModal.tsx and
// locations named in server/demoGenerator.ts, with their seeded coordinates.
const SEEDED_SPOTS: Array<[string, number, number]> = [
  ['Shibuya Crossing', 35.6595, 139.7004],
  ['Tour Eiffel', 48.8584, 2.2945],
  ['Reykjavik', 64.1466, -21.9426],
  ['Manhattan', 40.758, -73.9855],
  ['Giza Pyramids', 29.9792, 31.1342],
  ['Sydney Opera House', -33.8568, 151.2153],
  ['Westminster', 51.5007, -0.1246],
  ['Golden Gate', 37.8199, -122.4783],
  ['Meiji Jingu', 35.6764, 139.6993],
  ['Cat Street', 35.6654, 139.7058],
  ['Shibuya Sky', 35.6585, 139.7022],
  ['Shibuya Scramble Crossing', 35.6595, 139.7004],
  ['Omoide Yokocho', 35.693, 139.6995],
  ['Kabukicho', 35.6946, 139.7034],
  ['Senso-ji Temple', 35.7148, 139.7967],
  ['Sumida Park', 35.7122, 139.8012],
  ['Tsukiji Outer Market', 35.6655, 139.7707],
  ['Ueno Onshi Park', 35.7156, 139.7741],
  ['Tokyo Tower', 35.6586, 139.7454],
  ['Odaiba Marine Park', 35.6308, 139.7762],
  ['Place du Trocadero', 48.8616, 2.2893],
  ['Musee du Louvre', 48.8606, 2.3376],
  ['Jardin du Luxembourg', 48.8462, 2.3372],
  ['Sacre-Coeur', 48.8867, 2.3431],
  ['Pont Alexandre III', 48.8639, 2.3135],
  ['Seljalandsfoss', 63.6156, -19.9886],
  ['Skogafoss Waterfall', 63.5321, -19.5114],
  ['Dyrholaey Peninsula', 63.4017, -19.1269],
  ['Reynisfjara Beach', 63.4042, -19.045],
  ['Vik i Myrdal', 63.4194, -19.0046],
  ['Jokulsarlon Glacier Lagoon', 64.0484, -16.1794],
  ['Kirkjufell', 64.9261, -23.3122],
  ['Arnarstapi', 64.7691, -23.6219],
  ['Budir', 64.8217, -23.3844],
  ['Hallgrimskirkja', 64.1417, -21.9266],
  ['Sun Voyager', 64.1476, -21.9223],
  ['Grotta Lighthouse', 64.1647, -22.0222],
  ['Brooklyn Bridge', 40.7061, -73.9969],
  ['DUMBO', 40.7033, -73.9896],
  ['Bow Bridge', 40.7757, -73.9717],
  ['Grand Central Terminal', 40.7527, -73.9772],
  ['Rockefeller Center', 40.7591, -73.9794],
  ['Times Square', 40.758, -73.9855],
  ['Giza Necropolis', 29.9792, 31.1342],
  ['Great Sphinx of Giza', 29.9753, 31.1376],
  ['Cairo Citadel', 30.0287, 31.2599],
  ['Khan el-Khalili', 30.0477, 31.2623],
  ['Nile Corniche', 30.0444, 31.229],
  ['Cairo Tower', 30.0459, 31.2243],
  ['Bondi Icebergs', -33.8952, 151.2743],
  ['Tamarama Coastal Walk', -33.9036, 151.2689],
  ['Bennelong Point', -33.8568, 151.2153],
  ['Royal Botanic Garden', -33.8599, 151.2225],
  ['Sydney Harbour Bridge', -33.8523, 151.2108],
  ['Circular Quay', -33.8615, 151.2106],
];

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const labelsOf = (entry: GazetteerEntry): string[] => [entry.name, ...(entry.aliases ?? [])];

const findPlace = (query: string): GazetteerEntry | undefined => {
  const target = fold(query);
  return PLACE_GAZETTEER.find((entry) => labelsOf(entry).some((label) => fold(label) === target));
};

const distanceKm = (a: GazetteerEntry, b: { lat: number; lng: number }): number => {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

describe('PLACE_GAZETTEER', () => {
  it('holds between 150 and 200 entries', () => {
    expect(PLACE_GAZETTEER.length).toBeGreaterThanOrEqual(150);
    expect(PLACE_GAZETTEER.length).toBeLessThanOrEqual(200);
  });

  it('has finite coordinates within latitude and longitude bounds', () => {
    for (const entry of PLACE_GAZETTEER) {
      expect(Number.isFinite(entry.lat), entry.name).toBe(true);
      expect(Number.isFinite(entry.lng), entry.name).toBe(true);
      expect(entry.lat, entry.name).toBeGreaterThanOrEqual(-90);
      expect(entry.lat, entry.name).toBeLessThanOrEqual(90);
      expect(entry.lng, entry.name).toBeGreaterThanOrEqual(-180);
      expect(entry.lng, entry.name).toBeLessThanOrEqual(180);
    }
  });

  it('uses only the four known kinds', () => {
    for (const entry of PLACE_GAZETTEER) {
      expect(KINDS, entry.name).toContain(entry.kind);
    }
  });

  it('keeps names and aliases trimmed and non-empty', () => {
    for (const entry of PLACE_GAZETTEER) {
      for (const label of labelsOf(entry)) {
        expect(label, entry.name).toBe(label.trim());
        expect(label.length, entry.name).toBeGreaterThan(0);
      }
    }
  });

  it('has unique names, ignoring case', () => {
    const names = PLACE_GAZETTEER.map((entry) => entry.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('never uses another entry name as an alias, ignoring case', () => {
    const names = new Set(PLACE_GAZETTEER.map((entry) => entry.name.toLowerCase()));
    for (const entry of PLACE_GAZETTEER) {
      for (const alias of entry.aliases ?? []) {
        const isOwnName = alias.toLowerCase() === entry.name.toLowerCase();
        expect(isOwnName || !names.has(alias.toLowerCase()), `${alias} on ${entry.name}`).toBe(true);
      }
    }
  });

  it('maps every folded name or alias to a single entry', () => {
    const owners = new Map<string, string>();
    for (const entry of PLACE_GAZETTEER) {
      for (const label of new Set(labelsOf(entry).map(fold))) {
        const owner = owners.get(label);
        expect(owner === undefined || owner === entry.name, `${label}: ${owner} vs ${entry.name}`).toBe(true);
        owners.set(label, entry.name);
      }
    }
  });

  it('avoids generic words as names or aliases', () => {
    for (const entry of PLACE_GAZETTEER) {
      for (const label of labelsOf(entry)) {
        expect(GENERIC_WORDS.has(fold(label)), `${label} on ${entry.name}`).toBe(false);
      }
    }
  });

  it.each(DEMO_PLACES)('includes %s', (place) => {
    expect(findPlace(place), place).toBeDefined();
  });

  it.each(SEEDED_SPOTS)('resolves %s within 5 km of its seeded coordinates', (query, lat, lng) => {
    const entry = findPlace(query);
    expect(entry, query).toBeDefined();
    expect(entry ? distanceKm(entry, { lat, lng }) : Infinity, query).toBeLessThanOrEqual(5);
  });
});
