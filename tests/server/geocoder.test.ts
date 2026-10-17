import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGeocodeSession,
  defaultCachePath,
  MAX_TOKENS_PER_RUN,
  NOMINATIM_ATTRIBUTION,
  type GeocoderOptions,
} from '../../server/geocoder.ts';
import type * as GeocoderModule from '../../server/geocoder.ts';

const USER_AGENT = 'MyAlbum-LocalPhotoApp/1.0 (local-photo-organizer)';
const TEST_BASE_URL = 'https://nominatim.example.test/';
const START_MS = Date.UTC(2026, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const SCRATCH_ROOT = fileURLToPath(new URL('../../node_modules/.tmp', import.meta.url));
const TOKYO_TOWER = [
  {
    lat: '35.6585805',
    lon: '139.7454329',
    name: 'Tokyo Tower',
    display_name: 'Tokyo Tower, 4-2-8, Shibakoen, Minato, Tokyo, 105-0011, Japan',
    importance: 0.6,
  },
];

interface FakeClock {
  current: number;
  sleeps: number[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface RecordedRequest {
  url: string;
  userAgent: string | null;
  startedAt: number;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  await fs.mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(SCRATCH_ROOT, 'geocode-test-'));
  tempDirs.push(dir);
  return dir;
}

async function createCachePath(): Promise<string> {
  return path.join(await createTempDir(), 'geocode-cache.json');
}

function createFakeClock(): FakeClock {
  const clock: FakeClock = {
    current: START_MS,
    sleeps: [],
    now: () => clock.current,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.current += ms;
    },
  };
  return clock;
}

function createFetchStub(clock: FakeClock, respond: Responder) {
  const requests: RecordedRequest[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: String(input),
      userAgent: new Headers(init?.headers).get('User-Agent'),
      startedAt: clock.now(),
    };
    requests.push(request);
    return respond(request);
  };
  return { fetch: stub as typeof fetch, requests };
}

function createHangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function respondInOrder(bodies: unknown[]): Responder {
  let next = 0;
  return () => {
    const body = bodies[next] ?? [];
    next += 1;
    return jsonResponse(body);
  };
}

function sessionOptions(cachePath: string, clock: FakeClock, fetchFn: typeof fetch): GeocoderOptions {
  return { baseUrl: TEST_BASE_URL, cachePath, fetch: fetchFn, now: clock.now, sleep: clock.sleep };
}

// Re-importing gives a fresh module instance, which simulates a server restart: the next session must read the file.
async function reloadGeocoderModule(): Promise<typeof GeocoderModule> {
  vi.resetModules();
  return import('../../server/geocoder.ts');
}

async function readCacheFile(cachePath: string): Promise<{
  version: number;
  entries: Record<string, { hit: Record<string, unknown> | null; storedAt: string }>;
}> {
  return JSON.parse(await fs.readFile(cachePath, 'utf8'));
}

function applyEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  applyEnv(values);
  try {
    await run();
  } finally {
    applyEnv(previous);
  }
}

describe('Nominatim geocoder', () => {
  describe('requests', () => {
    it('exports the attribution text and the per-run token limit', () => {
      expect(NOMINATIM_ATTRIBUTION).toBe('© OpenStreetMap contributors');
      expect(MAX_TOKENS_PER_RUN).toBe(20);
    });

    it('sends one search request with an encoded query, fixed parameters and the MyAlbum User-Agent', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      await session.lookup('  Tokyo   Tower & Co ');

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].url).toBe(
        'https://nominatim.example.test/search?format=jsonv2&limit=1&accept-language=en&q=Tokyo%20Tower%20%26%20Co',
      );
      expect(stub.requests[0].userAgent).toBe(USER_AGENT);
      expect(session.lookupCount).toBe(1);
    });

    it('sends a custom User-Agent when one is given', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse([]));
      const session = createGeocodeSession({
        ...sessionOptions(await createCachePath(), clock, stub.fetch),
        userAgent: 'Custom-Agent/2.0',
      });

      await session.lookup('Alpha');

      expect(stub.requests[0].userAgent).toBe('Custom-Agent/2.0');
    });

    it('uses NOMINATIM_BASE_URL when no baseUrl is given and trims trailing slashes', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse([]));
      const cachePath = await createCachePath();

      await withEnv({ NOMINATIM_BASE_URL: 'http://127.0.0.1:4010//' }, async () => {
        const session = createGeocodeSession({ cachePath, fetch: stub.fetch, now: clock.now, sleep: clock.sleep });
        await session.lookup('Alpha');
      });

      expect(stub.requests[0].url).toBe(
        'http://127.0.0.1:4010/search?format=jsonv2&limit=1&accept-language=en&q=Alpha',
      );
    });

    it('defaults to the public Nominatim endpoint when NOMINATIM_BASE_URL is unset', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse([]));
      const cachePath = await createCachePath();

      await withEnv({ NOMINATIM_BASE_URL: undefined }, async () => {
        const session = createGeocodeSession({ cachePath, fetch: stub.fetch, now: clock.now, sleep: clock.sleep });
        await session.lookup('Alpha');
      });

      expect(stub.requests[0].url).toBe(
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=Alpha',
      );
    });

    it('returns null without a request for empty or non-string tokens', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      expect(await session.lookup('')).toBeNull();
      expect(await session.lookup('  \t ')).toBeNull();
      expect(await session.lookup(undefined as unknown as string)).toBeNull();

      expect(stub.requests).toHaveLength(0);
      expect(session.lookupCount).toBe(0);
      expect(session.warnings).toEqual([]);
    });
  });

  describe('parsing', () => {
    it('returns a hit with numeric coordinates, the place name and confidence from importance', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      const hit = await session.lookup('Tokyo Tower');

      expect(hit).toMatchObject({
        lat: 35.6585805,
        lng: 139.7454329,
        name: 'Tokyo Tower',
        displayName: 'Tokyo Tower, 4-2-8, Shibakoen, Minato, Tokyo, 105-0011, Japan',
        importance: 0.6,
      });
      expect(hit?.confidence).toBeCloseTo(0.68, 10);
    });

    it('clamps importance to [0, 1] and confidence to [0.5, 0.8]', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(
        clock,
        respondInOrder([
          [{ lat: '1', lon: '2', display_name: 'High, Place', importance: 2 }],
          [{ lat: '1', lon: '2', display_name: 'Unranked, Place' }],
          [{ lat: '1', lon: '2', display_name: 'Negative, Place', importance: -0.4 }],
        ]),
      );
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      expect(await session.lookup('High')).toMatchObject({ importance: 1, confidence: 0.8 });
      expect(await session.lookup('Unranked')).toMatchObject({ importance: 0, confidence: 0.5 });
      expect(await session.lookup('Negative')).toMatchObject({ importance: 0, confidence: 0.5 });
    });

    it('accepts numeric coordinates and uses the query as the name when display_name is missing', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse([{ lat: 51.5, lon: -0.12 }]));
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      expect(await session.lookup('  Riverside   Park ')).toEqual({
        lat: 51.5,
        lng: -0.12,
        name: 'Riverside Park',
        displayName: '',
        importance: 0,
        confidence: 0.5,
      });
    });

    it('falls back to the first display_name part when name is empty', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () =>
        jsonResponse([{ lat: '34.6687', lon: '135.5011', name: '', display_name: 'Dotonbori, Osaka, Japan' }]),
      );
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      expect(await session.lookup('Dotonbori')).toMatchObject({
        name: 'Dotonbori',
        displayName: 'Dotonbori, Osaka, Japan',
      });
    });
  });

  describe('cache', () => {
    it('caches an empty result as a miss so a later session makes no request', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const first = createFetchStub(clock, () => jsonResponse([]));
      expect(await createGeocodeSession(sessionOptions(cachePath, clock, first.fetch)).lookup('Nowhere Land')).toBeNull();
      expect(first.requests).toHaveLength(1);

      const saved = await readCacheFile(cachePath);
      expect(saved.version).toBe(1);
      expect(saved.entries['nowhere land']).toMatchObject({ hit: null });

      const second = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const restarted = await reloadGeocoderModule();
      const session = restarted.createGeocodeSession(sessionOptions(cachePath, clock, second.fetch));
      expect(await session.lookup('nowhere   land')).toBeNull();
      expect(second.requests).toHaveLength(0);
    });

    it('caches results with non-finite or out-of-range coordinates as misses', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const broken = createFetchStub(clock, (request) =>
        jsonResponse(
          request.url.endsWith('q=Broken%20Place')
            ? [{ lat: 'n/a', lon: '139.7', display_name: 'Broken, Place' }]
            : [{ lat: '95', lon: '10', display_name: 'Far, Away' }],
        ),
      );
      const first = createGeocodeSession(sessionOptions(cachePath, clock, broken.fetch));
      expect(await first.lookup('Broken Place')).toBeNull();
      expect(await first.lookup('Far Away')).toBeNull();
      expect(first.warnings).toEqual([]);

      const later = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const restarted = await reloadGeocoderModule();
      const session = restarted.createGeocodeSession(sessionOptions(cachePath, clock, later.fetch));
      expect(await session.lookup('Broken Place')).toBeNull();
      expect(await session.lookup('Far Away')).toBeNull();
      expect(later.requests).toHaveLength(0);
    });

    it('keeps positive hits across sessions and never expires them', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const first = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const hit = await createGeocodeSession(sessionOptions(cachePath, clock, first.fetch)).lookup('Tokyo Tower');
      expect(hit).not.toBeNull();

      clock.current += 400 * DAY_MS;
      const later = createFetchStub(clock, () => jsonResponse([]));
      const restarted = await reloadGeocoderModule();
      const session = restarted.createGeocodeSession(sessionOptions(cachePath, clock, later.fetch));
      expect(await session.lookup('tokyo tower')).toEqual(hit);
      expect(later.requests).toHaveLength(0);
    });

    it('requests a cached miss again once it is 30 days old', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const first = createFetchStub(clock, () => jsonResponse([]));
      await createGeocodeSession(sessionOptions(cachePath, clock, first.fetch)).lookup('Nowhere Land');

      clock.current += 29 * DAY_MS;
      const beforeExpiry = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const restartedBefore = await reloadGeocoderModule();
      const sessionBefore = restartedBefore.createGeocodeSession(sessionOptions(cachePath, clock, beforeExpiry.fetch));
      expect(await sessionBefore.lookup('Nowhere Land')).toBeNull();
      expect(beforeExpiry.requests).toHaveLength(0);

      clock.current += DAY_MS;
      const afterExpiry = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const restartedAfter = await reloadGeocoderModule();
      const sessionAfter = restartedAfter.createGeocodeSession(sessionOptions(cachePath, clock, afterExpiry.fetch));
      expect(await sessionAfter.lookup('Nowhere Land')).not.toBeNull();
      expect(afterExpiry.requests).toHaveLength(1);
      expect(afterExpiry.requests[0].startedAt).toBe(START_MS + 30 * DAY_MS);
    });

    it('writes the cache through a temp file into a missing nested directory', async () => {
      const clock = createFakeClock();
      const cachePath = path.join(await createTempDir(), 'nested', 'deeper', 'geocode-cache.json');
      const stub = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));

      await createGeocodeSession(sessionOptions(cachePath, clock, stub.fetch)).lookup('Tokyo Tower');

      expect(await fs.readdir(path.dirname(cachePath))).toEqual(['geocode-cache.json']);
      const saved = await readCacheFile(cachePath);
      expect(saved.entries['tokyo tower']).toMatchObject({ hit: { lat: 35.6585805 } });
      expect(saved.entries['tokyo tower'].storedAt).toBe(new Date(START_MS).toISOString());
    });
  });

  describe('failures', () => {
    it('halts on HTTP 429 and makes no later requests, not even for cached tokens', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, (request) =>
        request.url.endsWith('q=Alpha') ? new Response('slow down', { status: 429 }) : jsonResponse(TOKYO_TOWER),
      );
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      expect(await session.lookup('Tokyo Tower')).not.toBeNull();
      expect(await session.lookup('Alpha')).toBeNull();
      expect(await session.lookup('Beta')).toBeNull();
      expect(await session.lookup('Tokyo Tower')).toBeNull();

      expect(stub.requests).toHaveLength(2);
      expect(session.lookupCount).toBe(2);
      expect(session.halted).toBe(true);
      expect(session.warnings).toHaveLength(1);
      expect(session.warnings[0]).toMatch(/HTTP 429/);
    });

    it('halts on HTTP 503 and does not cache the failed token', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const stub = createFetchStub(clock, () => new Response('down', { status: 503 }));
      const session = createGeocodeSession(sessionOptions(cachePath, clock, stub.fetch));

      expect(await session.lookup('Alpha')).toBeNull();
      expect(await session.lookup('Beta')).toBeNull();

      expect(stub.requests).toHaveLength(1);
      expect(session.halted).toBe(true);
      expect(session.warnings).toHaveLength(1);
      expect(session.warnings[0]).toMatch(/HTTP 503/);
      await expect(fs.access(cachePath)).rejects.toThrow();
    });

    it('halts when the network request fails', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => {
        throw new TypeError('fetch failed');
      });
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      expect(await session.lookup('Alpha')).toBeNull();
      expect(await session.lookup('Beta')).toBeNull();

      expect(stub.requests).toHaveLength(1);
      expect(session.halted).toBe(true);
      expect(session.warnings).toHaveLength(1);
      expect(session.warnings[0]).toMatch(/Could not reach Nominatim/);
    });

    it('halts on timeout and does not cache the token', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const session = createGeocodeSession({
        ...sessionOptions(cachePath, clock, createHangingFetch()),
        timeoutMs: 20,
      });

      expect(await session.lookup('Slow Place')).toBeNull();
      expect(session.halted).toBe(true);
      expect(session.warnings).toEqual([
        'Nominatim did not respond within 20 ms; remaining places were not looked up',
      ]);

      const retry = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const later = createGeocodeSession(sessionOptions(cachePath, clock, retry.fetch));
      expect(await later.lookup('Slow Place')).not.toBeNull();
      expect(retry.requests).toHaveLength(1);
    });

    it('skips a place on other HTTP errors without halting or caching the failure', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const stub = createFetchStub(clock, (request) =>
        request.url.endsWith('q=Missing%20Place') ? new Response('nope', { status: 404 }) : jsonResponse(TOKYO_TOWER),
      );
      const session = createGeocodeSession(sessionOptions(cachePath, clock, stub.fetch));

      expect(await session.lookup('Missing Place')).toBeNull();
      expect(await session.lookup('Tokyo Tower')).not.toBeNull();

      expect(session.halted).toBe(false);
      expect(session.warnings).toEqual(['Nominatim returned HTTP 404 for one place; it was skipped']);

      const retry = createFetchStub(clock, () => jsonResponse([]));
      const later = createGeocodeSession(sessionOptions(cachePath, clock, retry.fetch));
      expect(await later.lookup('Missing Place')).toBeNull();
      expect(retry.requests).toHaveLength(1);
    });

    it('skips a response that is not a JSON array with one warning', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse({ error: 'Unable to geocode' }));
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      expect(await session.lookup('Alpha')).toBeNull();
      expect(await session.lookup('Alpha')).toBeNull();

      expect(stub.requests).toHaveLength(1);
      expect(session.halted).toBe(false);
      expect(session.warnings).toEqual([
        'Nominatim returned an unexpected response for one place; it was skipped',
      ]);
    });
  });

  describe('pacing and limits', () => {
    it('starts network requests at least 1100 ms apart', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse([]));
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      await session.lookup('Alpha Place');
      await session.lookup('Beta Place');

      expect(stub.requests.map((request) => request.startedAt)).toEqual([START_MS, START_MS + 1100]);
      expect(clock.sleeps).toEqual([1100]);
    });

    it('shares request spacing between sessions that use the same clock', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse([]));
      const cachePath = await createCachePath();
      const first = createGeocodeSession(sessionOptions(cachePath, clock, stub.fetch));
      const second = createGeocodeSession(sessionOptions(cachePath, clock, stub.fetch));

      await Promise.all([first.lookup('Alpha Place'), second.lookup('Beta Place')]);

      expect(stub.requests.map((request) => request.startedAt)).toEqual([START_MS, START_MS + 1100]);
      expect(clock.sleeps).toEqual([1100]);
    });

    it('allows MAX_TOKENS_PER_RUN unique tokens and skips the rest with one warning', async () => {
      const clock = createFakeClock();
      const stub = createFetchStub(clock, () => jsonResponse([]));
      const session = createGeocodeSession(sessionOptions(await createCachePath(), clock, stub.fetch));

      for (let index = 1; index <= MAX_TOKENS_PER_RUN; index += 1) {
        expect(await session.lookup(`Place ${index}`)).toBeNull();
      }
      expect(session.warnings).toEqual([]);

      expect(await session.lookup('Place 21')).toBeNull();
      expect(await session.lookup('Place 22')).toBeNull();
      expect(await session.lookup('place   1')).toBeNull();

      expect(session.warnings).toEqual(['Nominatim lookup limit reached (20 places per run)']);
      expect(stub.requests).toHaveLength(MAX_TOKENS_PER_RUN);
      expect(session.lookupCount).toBe(MAX_TOKENS_PER_RUN);
    });

    it('counts cache hits toward the per-run limit', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      const seed = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      await createGeocodeSession(sessionOptions(cachePath, clock, seed.fetch)).lookup('Tokyo Tower');

      const stub = createFetchStub(clock, () => jsonResponse([]));
      const session = createGeocodeSession({ ...sessionOptions(cachePath, clock, stub.fetch), maxTokensPerRun: 1 });

      expect(await session.lookup('tokyo tower')).not.toBeNull();
      expect(await session.lookup('Shibuya Crossing')).toBeNull();

      expect(stub.requests).toHaveLength(0);
      expect(session.warnings).toHaveLength(1);
      expect(session.warnings[0]).toMatch(/limit reached/);
    });
  });

  describe('cache file errors', () => {
    it('gives one warning for a corrupt cache file, starts empty and repairs the file', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      await fs.writeFile(cachePath, '{ "version": 1, "entries": ');
      const stub = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const session = createGeocodeSession(sessionOptions(cachePath, clock, stub.fetch));

      expect(await session.lookup('Tokyo Tower')).not.toBeNull();
      expect(await session.lookup('Shibuya Crossing')).not.toBeNull();

      expect(stub.requests).toHaveLength(2);
      expect(session.warnings).toEqual([
        'Geocode cache file is unreadable or corrupt; starting with an empty cache',
      ]);
      const saved = await readCacheFile(cachePath);
      expect(Object.keys(saved.entries).sort()).toEqual(['shibuya crossing', 'tokyo tower']);
    });

    it('gives one load warning when the cache path cannot be read as a file', async () => {
      const clock = createFakeClock();
      const cachePath = await createCachePath();
      await fs.mkdir(cachePath);
      const stub = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const session = createGeocodeSession(sessionOptions(cachePath, clock, stub.fetch));

      expect(await session.lookup('Tokyo Tower')).not.toBeNull();
      expect(await session.lookup('Shibuya Crossing')).not.toBeNull();

      expect(stub.requests).toHaveLength(2);
      expect(session.warnings.filter((warning) => warning.includes('unreadable or corrupt'))).toHaveLength(1);
    });

    it('warns once when the cache cannot be saved and keeps working from memory', async () => {
      const clock = createFakeClock();
      const blocker = path.join(await createTempDir(), 'blocker');
      await fs.writeFile(blocker, 'a file where the cache directory should be');
      const stub = createFetchStub(clock, () => jsonResponse(TOKYO_TOWER));
      const session = createGeocodeSession(
        sessionOptions(path.join(blocker, 'geocode-cache.json'), clock, stub.fetch),
      );

      expect(await session.lookup('Tokyo Tower')).not.toBeNull();
      expect(await session.lookup('Shibuya Crossing')).not.toBeNull();
      expect(await session.lookup('Tokyo Tower')).not.toBeNull();

      expect(stub.requests).toHaveLength(2);
      expect(session.halted).toBe(false);
      expect(session.warnings).toEqual([
        'Could not save the geocode cache file; new results are kept in memory only',
      ]);
    });
  });

  describe('defaultCachePath', () => {
    it('uses MYALBUM_DATA_DIR when it is set', async () => {
      const dataDir = await createTempDir();
      await withEnv({ MYALBUM_DATA_DIR: dataDir }, async () => {
        expect(defaultCachePath()).toBe(path.join(dataDir, 'geocode-cache.json'));
      });
    });

    it('falls back to ~/.myalbum when MYALBUM_DATA_DIR is not set', async () => {
      await withEnv({ MYALBUM_DATA_DIR: undefined }, async () => {
        expect(defaultCachePath()).toBe(path.join(os.homedir(), '.myalbum', 'geocode-cache.json'));
      });
    });
  });
});
