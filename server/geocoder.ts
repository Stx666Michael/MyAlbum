import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const NOMINATIM_ATTRIBUTION = '© OpenStreetMap contributors';
export const MAX_TOKENS_PER_RUN = 20;

export interface GeocodeHit {
  lat: number;
  lng: number;
  name: string;
  displayName: string;
  importance: number;
  confidence: number;
}

export interface GeocodeSession {
  lookup(token: string): Promise<GeocodeHit | null>;
  readonly warnings: string[];
  readonly lookupCount: number; // network requests made in this session
  readonly halted: boolean;
}

export interface GeocoderOptions {
  baseUrl?: string;
  userAgent?: string;
  cachePath?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxTokensPerRun?: number;
}

interface GeocodeCacheEntry {
  hit: GeocodeHit | null;
  storedAt: string;
}

interface GeocodeCacheStore {
  readonly cachePath: string;
  readonly entries: Map<string, GeocodeCacheEntry>;
  pendingLoadWarning: string | null;
  writeQueue: Promise<void>;
}

interface RequestSpacing {
  lastStartMs: number | null;
  queue: Promise<void>;
}

type RequestOutcome =
  | { kind: 'found'; hit: GeocodeHit | null }
  | { kind: 'skipped'; warning: string }
  | { kind: 'halted'; warning: string };

const DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';
const DEFAULT_USER_AGENT = 'MyAlbum-LocalPhotoApp/1.0 (local-photo-organizer)';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MIN_INTERVAL_MS = 1100;
const MAX_TIMER_MS = 2_147_483_647;
const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;
const CACHE_FILE_NAME = 'geocode-cache.json';
const CACHE_LOAD_WARNING = 'Geocode cache file is unreadable or corrupt; starting with an empty cache';
const CACHE_SAVE_WARNING = 'Could not save the geocode cache file; new results are kept in memory only';

// Shared per cache file, so the file is read once per process and every session writes the same map.
const cacheStores = new Map<string, Promise<GeocodeCacheStore>>();

// Keyed by clock: sessions on the system clock share one limiter, while injected clocks stay isolated.
const requestSpacingByClock = new WeakMap<() => number, RequestSpacing>();

const systemNow = (): number => Date.now();
const systemSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultCachePath(): string {
  const dataDir = process.env.MYALBUM_DATA_DIR?.trim() || path.join(os.homedir(), '.myalbum');
  return path.join(dataDir, CACHE_FILE_NAME);
}

export function createGeocodeSession(options: GeocoderOptions = {}): GeocodeSession {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT;
  const cachePath = path.resolve(options.cachePath?.trim() || defaultCachePath());
  const fetchImpl: typeof fetch =
    options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const sleep = options.sleep ?? systemSleep;
  const now = options.now ?? systemNow;
  const timeoutMs = validOr(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    (value) => value > 0 && value <= MAX_TIMER_MS,
  );
  const minIntervalMs = validOr(
    options.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    (value) => value >= 0 && value <= MAX_TIMER_MS,
  );
  const maxTokens = Math.floor(validOr(options.maxTokensPerRun, MAX_TOKENS_PER_RUN, (value) => value >= 0));

  const warnings: string[] = [];
  const attempts = new Map<string, Promise<GeocodeHit | null>>();
  const timeoutOutcome: RequestOutcome = {
    kind: 'halted',
    warning: `Nominatim did not respond within ${timeoutMs} ms; remaining places were not looked up`,
  };
  const networkOutcome: RequestOutcome = {
    kind: 'halted',
    warning: 'Could not reach Nominatim; remaining places were not looked up',
  };
  const unexpectedOutcome: RequestOutcome = {
    kind: 'skipped',
    warning: 'Nominatim returned an unexpected response for one place; it was skipped',
  };
  let lookupCount = 0;
  let halted = false;
  let limitWarned = false;
  let saveWarned = false;

  function halt(warning: string): void {
    if (!halted) {
      halted = true;
      warnings.push(warning);
    }
  }

  async function requestPlace(query: string): Promise<RequestOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    lookupCount += 1;
    try {
      const response = await fetchImpl(buildSearchUrl(baseUrl, query), {
        headers: { 'User-Agent': userAgent },
        signal: controller.signal,
      });
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined);
        if (response.status === 429) {
          return {
            kind: 'halted',
            warning: 'Nominatim rate limit reached (HTTP 429); remaining places were not looked up',
          };
        }
        if (response.status >= 500) {
          return {
            kind: 'halted',
            warning: `Nominatim service unavailable (HTTP ${response.status}); remaining places were not looked up`,
          };
        }
        return {
          kind: 'skipped',
          warning: `Nominatim returned HTTP ${response.status} for one place; it was skipped`,
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) return timeoutOutcome;
        return error instanceof SyntaxError ? unexpectedOutcome : networkOutcome;
      }
      if (!Array.isArray(payload)) return unexpectedOutcome;
      return { kind: 'found', hit: toGeocodeHit(payload[0], query) };
    } catch {
      return controller.signal.aborted ? timeoutOutcome : networkOutcome;
    } finally {
      clearTimeout(timer);
    }
  }

  async function persist(store: GeocodeCacheStore): Promise<void> {
    try {
      await saveStore(store);
    } catch {
      if (!saveWarned) {
        saveWarned = true;
        warnings.push(CACHE_SAVE_WARNING);
      }
    }
  }

  async function resolveToken(key: string, query: string): Promise<GeocodeHit | null> {
    const store = await openStore(cachePath);
    const loadWarning = takeLoadWarning(store);
    if (loadWarning) warnings.push(loadWarning);

    const cached = store.entries.get(key);
    if (cached && !isExpiredMiss(cached, now())) return cached.hit;

    await acquireRequestSlot(now, sleep, minIntervalMs);
    if (halted) return null;

    const outcome = await requestPlace(query);
    if (outcome.kind === 'halted') {
      halt(outcome.warning);
      return null;
    }
    if (outcome.kind === 'skipped') {
      warnings.push(outcome.warning);
      return null;
    }
    store.entries.set(key, { hit: outcome.hit, storedAt: new Date(now()).toISOString() });
    await persist(store);
    return outcome.hit;
  }

  async function lookup(token: string): Promise<GeocodeHit | null> {
    const query = normaliseQuery(token);
    if (!query || halted) return null;

    const key = query.toLowerCase();
    const attempt = attempts.get(key);
    if (attempt) return attempt;

    if (attempts.size >= maxTokens) {
      if (!limitWarned) {
        limitWarned = true;
        warnings.push(`Nominatim lookup limit reached (${maxTokens} places per run)`);
      }
      return null;
    }

    const pending = resolveToken(key, query);
    attempts.set(key, pending);
    return pending;
  }

  return {
    lookup,
    get warnings() {
      return warnings;
    },
    get lookupCount() {
      return lookupCount;
    },
    get halted() {
      return halted;
    },
  };
}

function validOr(value: number | undefined, fallback: number, isValid: (candidate: number) => boolean): number {
  return value !== undefined && Number.isFinite(value) && isValid(value) ? value : fallback;
}

function resolveBaseUrl(configured: string | undefined): string {
  const value = (configured ?? process.env.NOMINATIM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return value || DEFAULT_BASE_URL;
}

function normaliseQuery(token: unknown): string {
  return typeof token === 'string' ? token.trim().replace(/\s+/g, ' ') : '';
}

function buildSearchUrl(baseUrl: string, query: string): string {
  return `${baseUrl}/search?format=jsonv2&limit=1&accept-language=en&q=${encodeURIComponent(query)}`;
}

function toGeocodeHit(item: unknown, query: string): GeocodeHit | null {
  if (!isRecord(item)) return null;
  const lat = toFiniteNumber(item.lat);
  const lng = toFiniteNumber(item.lon);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const placeName = typeof item.name === 'string' ? item.name.trim() : '';
  const displayName = typeof item.display_name === 'string' ? item.display_name.trim() : '';
  const firstDisplayPart = (displayName.split(',')[0] ?? '').trim();
  const importance = clamp(toFiniteNumber(item.importance) ?? 0, 0, 1);
  return {
    lat,
    lng,
    name: placeName || firstDisplayPart || query,
    displayName,
    importance,
    confidence: clamp(0.5 + 0.3 * importance, 0.5, 0.8),
  };
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isExpiredMiss(entry: GeocodeCacheEntry, nowMs: number): boolean {
  return entry.hit === null && nowMs - Date.parse(entry.storedAt) >= MISS_TTL_MS;
}

function requestSpacingFor(now: () => number): RequestSpacing {
  let spacing = requestSpacingByClock.get(now);
  if (!spacing) {
    spacing = { lastStartMs: null, queue: Promise.resolve() };
    requestSpacingByClock.set(now, spacing);
  }
  return spacing;
}

function acquireRequestSlot(
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  minIntervalMs: number,
): Promise<void> {
  const spacing = requestSpacingFor(now);
  const slot = spacing.queue.then(async () => {
    if (spacing.lastStartMs !== null) {
      const waitMs = spacing.lastStartMs + minIntervalMs - now();
      if (waitMs > 0) await sleep(waitMs);
    }
    spacing.lastStartMs = now();
  });
  spacing.queue = slot.catch(() => undefined);
  return slot;
}

function openStore(cachePath: string): Promise<GeocodeCacheStore> {
  let store = cacheStores.get(cachePath);
  if (!store) {
    store = loadStore(cachePath);
    cacheStores.set(cachePath, store);
  }
  return store;
}

async function loadStore(cachePath: string): Promise<GeocodeCacheStore> {
  let entries = new Map<string, GeocodeCacheEntry>();
  let pendingLoadWarning: string | null = null;
  try {
    const parsed = parseCacheFile(await fs.readFile(cachePath, 'utf8'));
    if (parsed) {
      entries = parsed;
    } else {
      pendingLoadWarning = CACHE_LOAD_WARNING;
    }
  } catch (error) {
    if (!isMissingPathError(error)) pendingLoadWarning = CACHE_LOAD_WARNING;
  }
  return { cachePath, entries, pendingLoadWarning, writeQueue: Promise.resolve() };
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function parseCacheFile(raw: string): Map<string, GeocodeCacheEntry> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.version !== CACHE_VERSION || !isRecord(data.entries)) return null;

  const entries = new Map<string, GeocodeCacheEntry>();
  for (const [key, value] of Object.entries(data.entries)) {
    const entry = parseCacheEntry(value);
    if (!entry) return null;
    entries.set(key, entry);
  }
  return entries;
}

function parseCacheEntry(value: unknown): GeocodeCacheEntry | null {
  if (!isRecord(value) || typeof value.storedAt !== 'string' || Number.isNaN(Date.parse(value.storedAt))) {
    return null;
  }
  if (value.hit === null) return { hit: null, storedAt: value.storedAt };
  const hit = parseStoredHit(value.hit);
  return hit ? { hit, storedAt: value.storedAt } : null;
}

function parseStoredHit(value: unknown): GeocodeHit | null {
  if (!isRecord(value)) return null;
  const { lat, lng, name, displayName, importance, confidence } = value;
  if (
    !isFiniteNumber(lat) ||
    !isFiniteNumber(lng) ||
    !isFiniteNumber(importance) ||
    !isFiniteNumber(confidence) ||
    typeof name !== 'string' ||
    typeof displayName !== 'string'
  ) {
    return null;
  }
  return { lat, lng, name, displayName, importance, confidence };
}

function takeLoadWarning(store: GeocodeCacheStore): string | null {
  const warning = store.pendingLoadWarning;
  store.pendingLoadWarning = null;
  return warning;
}

function saveStore(store: GeocodeCacheStore): Promise<void> {
  const write = store.writeQueue.then(() => writeCacheFile(store));
  store.writeQueue = write.catch(() => undefined);
  return write;
}

async function writeCacheFile(store: GeocodeCacheStore): Promise<void> {
  const payload = { version: CACHE_VERSION, entries: Object.fromEntries(store.entries) };
  const tempPath = `${store.cachePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(store.cachePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tempPath, store.cachePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
