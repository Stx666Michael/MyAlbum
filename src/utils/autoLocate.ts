import type { AutoLocateOptions, AutoLocateStrategy, PhotoItem } from '../types/photo.ts';
import type { GazetteerEntry } from './placeGazetteer.ts';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TrackPoint extends LatLng {
  utcMs: number;
}

export type AnchorPoint = TrackPoint;

export interface GeoMatch extends LatLng {
  confidence: number;
  reason: string;
}

export interface GazetteerMatch {
  entry: GazetteerEntry;
  matchedText: string;
  confidence: number;
  reason: string;
}

export interface PlaceCandidate extends LatLng {
  strategy: AutoLocateStrategy;
  name: string;
  confidence: number;
  reason: string;
}

export type TimeOptions = Pick<AutoLocateOptions, 'utcOffsetMinutes' | 'driftMinutes' | 'useEmbeddedOffset'>;

export const COMPANION_MAX_GAP_MS = 2 * 60 * 60 * 1000;
export const COMPANION_MAX_DISTANCE_KM = 100;
export const TRACK_MAX_SPEED_KMH = 1000;

const EARTH_RADIUS_KM = 6371.0088;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const E7_SCALE = 1e7;
const JITTER_DEG = 0.0003;
const MIN_TOKEN_LENGTH = 3;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const STRATEGY_PRECEDENCE: readonly AutoLocateStrategy[] = ['track', 'companion', 'gazetteer', 'nominatim', 'ai'];

const GPX_POINT_RE = /<(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
const GPX_ATTRIBUTE_RE = /\b(lat|lon)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const GPX_TIME_RE = /<time\b[^>]*>([^<]*)<\/time\s*>/i;
const LAT_LNG_RE = /^\s*(?:geo:)?\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*\u00b0?\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*\u00b0?\s*(?:;.*)?$/i;

const TOKEN_SEPARATOR_RE = /[\s_\-.,()[\]\/\\]+/;
const CAMERA_CODE_RE = /^(?:(?:IMG|IMGP|DSC|DCIM|PXL|DJI|MVI|GOPR|GX|SAM|VID|MG)\d*|P\d+)$/i;
const DAY_LABEL_RE = /^day\d*$/i;
const COMPACT_DATE_RE = /\d{6}/;
const MONTH_NAME = '(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)';
const FULL_MONTH_RE = /^(?:january|february|march|april|june|july|august|september|october|november|december)$/i;
const MONTH_DATE_RE = new RegExp(`^(?:\\d{1,4}${MONTH_NAME}\\d{0,4}|${MONTH_NAME}\\d{2,4})$`, 'i');
const GENERIC_TOKENS = new Set([
  'session', 'portrait', 'studio', 'trip', 'copy', 'edit', 'edited', 'final', 'export', 'photos', 'photo',
  'album', 'shots', 'misc', 'other', 'family', 'friends', 'vacation', 'holiday', 'travel', 'week',
  'weekend', 'morning', 'evening', 'night', 'spring', 'summer', 'autumn', 'fall', 'winter',
]);

type JsonObject = Record<string, unknown>;

interface GazetteerIndex {
  entries: Map<string, GazetteerEntry>;
  maxWords: number;
}

const gazetteerIndexes = new WeakMap<readonly GazetteerEntry[], GazetteerIndex>();

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}

export function interpolateLatLng(a: LatLng, b: LatLng, alpha: number): LatLng {
  let bLng = b.lng;
  if (bLng - a.lng > 180) bLng -= 360;
  else if (bLng - a.lng < -180) bLng += 360;
  return {
    lat: a.lat + (b.lat - a.lat) * alpha,
    lng: normalizeLng(a.lng + (bLng - a.lng) * alpha),
  };
}

function normalizeLng(lng: number): number {
  if (lng > 180) return lng - 360 * Math.ceil((lng - 180) / 360);
  if (lng < -180) return lng + 360 * Math.ceil((-180 - lng) / 360);
  return lng;
}

function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export function jitter(photoId: string): { dLat: number; dLng: number } {
  const toOffset = (hash: number): number => ((hash / 0xffffffff) * 2 - 1) * JITTER_DEG;
  return {
    dLat: toOffset(fnv1a(photoId)),
    dLng: toOffset(fnv1a(`lng:${photoId}`)),
  };
}

export function parseGpx(text: string): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (const element of text.matchAll(GPX_POINT_RE)) {
    const attributes = new Map<string, string>();
    for (const attribute of element[2].matchAll(GPX_ATTRIBUTE_RE)) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? '');
    }
    const time = GPX_TIME_RE.exec(element[3] ?? '');
    collect(
      points,
      parseIsoMs(time?.[1]),
      toLatLng(finiteNumber(attributes.get('lat')), finiteNumber(attributes.get('lon'))),
    );
  }
  return sortByUtc(points);
}

export function mapRecordsLocations(items: readonly unknown[], keep?: (utcMs: number) => boolean): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (const item of items) {
    const record = asObject(item);
    if (!record) continue;
    collect(
      points,
      parseIsoMs(record.timestamp) ?? finiteNumber(record.timestampMs),
      toLatLng(finiteNumber(record.latitudeE7), finiteNumber(record.longitudeE7), E7_SCALE),
      keep,
    );
  }
  return points;
}

export function mapTimelineSegments(items: readonly unknown[], keep?: (utcMs: number) => boolean): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (const item of items) {
    const segment = asObject(item);
    if (!segment) continue;
    const startMs = parseIsoMs(segment.startTime);
    const endMs = parseIsoMs(segment.endTime);
    if (startMs !== null && Array.isArray(segment.timelinePath)) {
      for (const step of segment.timelinePath) {
        const stepObject = asObject(step);
        const offsetMinutes = finiteNumber(stepObject?.durationMinutesOffsetFromStartTime);
        collect(
          points,
          offsetMinutes === null ? null : startMs + offsetMinutes * MS_PER_MINUTE,
          parseLatLng(stepObject?.point),
          keep,
        );
      }
    }
    const placeLocation = asObject(asObject(asObject(segment.visit)?.topCandidate)?.placeLocation);
    const visitCoords = parseLatLng(placeLocation?.latLng);
    collect(points, startMs, visitCoords, keep);
    collect(points, endMs, visitCoords, keep);
  }
  return points;
}

export function mapTimelineRawSignals(items: readonly unknown[], keep?: (utcMs: number) => boolean): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (const item of items) {
    const signal = asObject(item);
    if (!signal) continue;
    const position = asObject(signal.position);
    collect(
      points,
      parseIsoMs(signal.timestamp) ?? parseIsoMs(position?.timestamp),
      parseLatLng(position?.LatLng),
      keep,
    );
  }
  return points;
}

export function sortByUtc<T extends { utcMs: number }>(items: T[]): T[] {
  return items.sort((a, b) => a.utcMs - b.utcMs);
}

export function photoUtcMs(
  photo: Pick<PhotoItem, 'timestamp' | 'timestampSource' | 'exifOffsetMinutes'>,
  options: TimeOptions,
  role: 'target' | 'anchor',
): number | null {
  const wallMs = Date.parse(photo.timestamp);
  if (!Number.isFinite(wallMs)) return null;
  if (photo.timestampSource === 'file') return wallMs;

  const embeddedOffset = photo.exifOffsetMinutes;
  const offsetMinutes =
    options.useEmbeddedOffset && embeddedOffset != null && Number.isFinite(embeddedOffset)
      ? embeddedOffset
      : options.utcOffsetMinutes;
  const utcMs = wallMs - offsetMinutes * MS_PER_MINUTE;
  return role === 'target' ? utcMs - options.driftMinutes * MS_PER_MINUTE : utcMs;
}

export function matchTrack(points: readonly TrackPoint[], utcMs: number, windowMs: number): GeoMatch | null {
  const { prev, next } = bracket(points, utcMs);
  if (prev && next && next.utcMs > utcMs) {
    const gapMs = next.utcMs - prev.utcMs;
    const interpolable =
      utcMs - prev.utcMs <= windowMs &&
      next.utcMs - utcMs <= windowMs &&
      gapMs <= windowMs &&
      impliedSpeedKmh(prev, next) <= TRACK_MAX_SPEED_KMH;
    if (interpolable) {
      const position = interpolateLatLng(prev, next, (utcMs - prev.utcMs) / gapMs);
      return {
        lat: position.lat,
        lng: position.lng,
        confidence: clamp(0.98 - (0.08 * gapMs) / windowMs, 0.9, 0.98),
        reason: `Track position interpolated (${toMinutes(gapMs)} min between track points)`,
      };
    }
  }

  // An exact hit falls through to here so the track point's own coordinates are used.
  const nearest = nearestOf(prev, next, utcMs);
  if (!nearest || nearest.deltaMs > windowMs) return null;
  return {
    lat: nearest.point.lat,
    lng: nearest.point.lng,
    confidence: clamp(0.94 - 0.04 * ratio(nearest.deltaMs, windowMs), 0.9, 0.94),
    reason: `Nearest track point ${toMinutes(nearest.deltaMs)} min away`,
  };
}

export function matchCompanions(
  anchors: readonly AnchorPoint[],
  utcMs: number,
  windowMs: number,
  companionGapMs = COMPANION_MAX_GAP_MS,
): GeoMatch | null {
  const { prev, next } = bracket(anchors, utcMs);
  if (prev && next && next.utcMs > utcMs) {
    const gapMs = next.utcMs - prev.utcMs;
    const interpolable =
      utcMs - prev.utcMs <= windowMs &&
      next.utcMs - utcMs <= windowMs &&
      gapMs <= companionGapMs &&
      haversineKm(prev, next) <= COMPANION_MAX_DISTANCE_KM &&
      impliedSpeedKmh(prev, next) <= TRACK_MAX_SPEED_KMH;
    if (interpolable) {
      const position = interpolateLatLng(prev, next, (utcMs - prev.utcMs) / gapMs);
      return {
        lat: position.lat,
        lng: position.lng,
        confidence: clamp(0.94 - (0.25 * gapMs) / companionGapMs, 0.65, 0.94),
        reason: `Between located photos ${toMinutes(gapMs)} min apart`,
      };
    }
  }

  const nearest = nearestOf(prev, next, utcMs);
  if (!nearest || nearest.deltaMs > windowMs) return null;
  return {
    lat: nearest.point.lat,
    lng: nearest.point.lng,
    confidence: clamp(0.8 - 0.15 * ratio(nearest.deltaMs, windowMs), 0.65, 0.8),
    reason: `Nearest located photo ${toMinutes(nearest.deltaMs)} min away`,
  };
}

export function extractPlaceTokens(subfolder: string, fileName: string): string[] {
  const baseName = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const folders = subfolder
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .reverse();
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const text of [baseName, ...folders]) {
    for (const token of text.split(TOKEN_SEPARATOR_RE)) {
      const key = token.toLowerCase();
      if (!isPlaceToken(token) || seen.has(key)) continue;
      seen.add(key);
      tokens.push(token);
    }
  }
  return tokens;
}

export function matchGazetteer(tokens: readonly string[], gazetteer: readonly GazetteerEntry[]): GazetteerMatch | null {
  const { entries, maxWords } = indexGazetteer(gazetteer);
  for (let size = Math.min(maxWords, tokens.length); size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      const matchedText = tokens.slice(start, start + size).join(' ');
      const entry = entries.get(phraseKey(splitWords(matchedText)));
      if (entry) {
        return {
          entry,
          matchedText,
          confidence: entry.kind === 'city' || entry.kind === 'landmark' ? 0.8 : 0.55,
          reason: `Name "${matchedText}" matches ${entry.name}`,
        };
      }
    }
  }
  return null;
}

export function nearestPlaceName(
  lat: number,
  lng: number,
  gazetteer: readonly GazetteerEntry[],
  maxKm = 50,
): string | null {
  let nearest: GazetteerEntry | null = null;
  let nearestKm = Number.POSITIVE_INFINITY;
  for (const entry of gazetteer) {
    const km = haversineKm({ lat, lng }, entry);
    if (km < nearestKm) {
      nearest = entry;
      nearestKm = km;
    }
  }
  return nearest && nearestKm <= maxKm ? `Near ${nearest.name}` : null;
}

export function pickSuggestion(candidates: readonly PlaceCandidate[]): PlaceCandidate | null {
  let best: PlaceCandidate | null = null;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }
    const rank = STRATEGY_PRECEDENCE.indexOf(candidate.strategy);
    const bestRank = STRATEGY_PRECEDENCE.indexOf(best.strategy);
    if (rank < bestRank || (rank === bestRank && candidate.confidence > best.confidence)) {
      best = candidate;
    }
  }
  return best;
}

function collect(
  points: TrackPoint[],
  utcMs: number | null,
  coords: LatLng | null,
  keep?: (utcMs: number) => boolean,
): void {
  if (utcMs === null || coords === null || (keep && !keep(utcMs))) return;
  points.push({ utcMs, lat: coords.lat, lng: coords.lng });
}

function toLatLng(lat: number | null, lng: number | null, scale = 1): LatLng | null {
  if (lat === null || lng === null) return null;
  const point = { lat: lat / scale, lng: lng / scale };
  return Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180 ? point : null;
}

function parseLatLng(value: unknown): LatLng | null {
  const match = typeof value === 'string' ? LAT_LNG_RE.exec(value) : null;
  return match ? toLatLng(Number(match[1]), Number(match[2])) : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

function bracket<T extends { utcMs: number }>(
  items: readonly T[],
  utcMs: number,
): { prev: T | undefined; next: T | undefined } {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].utcMs < utcMs) lo = mid + 1;
    else hi = mid;
  }
  return {
    prev: lo > 0 ? items[lo - 1] : undefined,
    next: lo < items.length ? items[lo] : undefined,
  };
}

function nearestOf<T extends { utcMs: number }>(
  prev: T | undefined,
  next: T | undefined,
  utcMs: number,
): { point: T; deltaMs: number } | null {
  const before = prev ? { point: prev, deltaMs: utcMs - prev.utcMs } : null;
  const after = next ? { point: next, deltaMs: next.utcMs - utcMs } : null;
  if (before && after) return before.deltaMs <= after.deltaMs ? before : after;
  return before ?? after;
}

function impliedSpeedKmh(a: TrackPoint, b: TrackPoint): number {
  return haversineKm(a, b) / ((b.utcMs - a.utcMs) / MS_PER_HOUR);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function toMinutes(ms: number): number {
  return Math.round(ms / MS_PER_MINUTE);
}

function isPlaceToken(token: string): boolean {
  return (
    token.length >= MIN_TOKEN_LENGTH &&
    !/^\d+$/.test(token) &&
    !COMPACT_DATE_RE.test(token) &&
    !MONTH_DATE_RE.test(token) &&
    !FULL_MONTH_RE.test(token) &&
    !CAMERA_CODE_RE.test(token) &&
    !DAY_LABEL_RE.test(token) &&
    !GENERIC_TOKENS.has(token.toLowerCase())
  );
}

function splitWords(text: string): string[] {
  return text.split(TOKEN_SEPARATOR_RE).filter((word) => word.length > 0);
}

function foldWord(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function phraseKey(words: readonly string[]): string {
  return words.map(foldWord).join(' ');
}

function indexGazetteer(gazetteer: readonly GazetteerEntry[]): GazetteerIndex {
  const cached = gazetteerIndexes.get(gazetteer);
  if (cached) return cached;

  const entries = new Map<string, GazetteerEntry>();
  const fallbackEntries = new Map<string, GazetteerEntry>();
  let maxWords = 1;
  for (const entry of gazetteer) {
    for (const label of [entry.name, ...(entry.aliases ?? [])]) {
      const words = splitWords(label);
      if (words.length === 0) continue;
      maxWords = Math.max(maxWords, words.length);
      const key = phraseKey(words);
      if (!entries.has(key)) entries.set(key, entry);

      // Tokens drop words under 3 characters ("de", "of"), so also index the label without them.
      const contentWords = words.filter((word) => word.length >= MIN_TOKEN_LENGTH);
      if (contentWords.length >= 2 && contentWords.length < words.length) {
        const fallbackKey = phraseKey(contentWords);
        if (!fallbackEntries.has(fallbackKey)) fallbackEntries.set(fallbackKey, entry);
      }
    }
  }
  for (const [key, entry] of fallbackEntries) {
    if (!entries.has(key)) entries.set(key, entry);
  }

  const index: GazetteerIndex = { entries, maxWords };
  gazetteerIndexes.set(gazetteer, index);
  return index;
}
