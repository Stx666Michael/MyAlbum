import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import {
  mapRecordsLocations,
  mapTimelineRawSignals,
  mapTimelineSegments,
  parseGpx,
  sortByUtc,
  type TrackPoint,
} from '../src/utils/autoLocate.ts';

export interface TrackWindow {
  startMs: number;
  endMs: number;
}

export interface TrackReadResult {
  format: 'gpx' | 'records' | 'timeline';
  points: TrackPoint[];
  spanStartMs: number | null;
  spanEndMs: number | null;
}

export class TrackFormatError extends Error {}

const BATCH_SIZE = 2000;

const UNSUPPORTED_JSON_MESSAGE =
  'Supported JSON: Google Takeout Records.json (locations) and on-device Timeline.json (semanticSegments/rawSignals). Legacy monthly Semantic Location History files are not supported.';

interface JsonToken {
  name: string;
  value?: unknown;
}

interface JsonArrayEntry {
  value: unknown;
}

// Returning early from a pipeline consumer can leave upstream streams waiting; throwing tears them all down.
class StopStreaming extends Error {}

// Collects the root object's array-valued keys. Scanning stops at `locations`, which alone decides the format.
async function findRootArrayKeys(filePath: string): Promise<Set<string>> {
  const arrayKeys = new Set<string>();
  let depth = 0;
  // A key's value is the token that follows its keyValue token.
  let pendingKey: string | null = null;
  try {
    await pipeline(
      createReadStream(filePath),
      parser.asStream(),
      async (tokens: AsyncIterable<JsonToken>) => {
        for await (const token of tokens) {
          if (token.name === 'keyValue' && depth === 1) {
            pendingKey = String(token.value);
            continue;
          }
          if (pendingKey !== null && token.name === 'startArray') {
            arrayKeys.add(pendingKey);
            if (pendingKey === 'locations') throw new StopStreaming();
          }
          pendingKey = null;
          if (token.name === 'startObject' || token.name === 'startArray') depth += 1;
          else if (token.name === 'endObject' || token.name === 'endArray') depth -= 1;
        }
      },
    );
  } catch (error) {
    if (!(error instanceof StopStreaming)) throw error;
  }
  return arrayKeys;
}

async function forEachArrayBatch(
  filePath: string,
  key: string,
  onBatch: (items: unknown[]) => void,
): Promise<void> {
  let batch: unknown[] = [];
  await pipeline(
    createReadStream(filePath),
    parser.asStream(),
    pick.asStream({ filter: key }),
    streamArray.asStream(),
    async (entries: AsyncIterable<JsonArrayEntry>) => {
      for await (const entry of entries) {
        batch.push(entry.value);
        if (batch.length === BATCH_SIZE) {
          onBatch(batch);
          batch = [];
        }
      }
      if (batch.length > 0) onBatch(batch);
    },
  );
}

function createTrackCollector(window: TrackWindow | undefined) {
  const points: TrackPoint[] = [];
  let spanStartMs: number | null = null;
  let spanEndMs: number | null = null;
  return {
    add(batch: readonly TrackPoint[]): void {
      for (const point of batch) {
        if (spanStartMs === null || point.utcMs < spanStartMs) spanStartMs = point.utcMs;
        if (spanEndMs === null || point.utcMs > spanEndMs) spanEndMs = point.utcMs;
        if (window === undefined || (point.utcMs >= window.startMs && point.utcMs <= window.endMs)) {
          points.push(point);
        }
      }
    },
    finish(format: TrackReadResult['format']): TrackReadResult {
      return { format, points: sortByUtc(points), spanStartMs, spanEndMs };
    },
  };
}

async function readGpxTrack(filePath: string, window: TrackWindow | undefined): Promise<TrackReadResult> {
  const collector = createTrackCollector(window);
  collector.add(parseGpx(await fs.readFile(filePath, 'utf8')));
  return collector.finish('gpx');
}

async function readJsonTrack(filePath: string, window: TrackWindow | undefined): Promise<TrackReadResult> {
  const arrayKeys = await findRootArrayKeys(filePath);
  const collector = createTrackCollector(window);

  if (arrayKeys.has('locations')) {
    await forEachArrayBatch(filePath, 'locations', (items) => collector.add(mapRecordsLocations(items)));
    return collector.finish('records');
  }
  if (!arrayKeys.has('semanticSegments') && !arrayKeys.has('rawSignals')) {
    throw new TrackFormatError(UNSUPPORTED_JSON_MESSAGE);
  }
  if (arrayKeys.has('semanticSegments')) {
    await forEachArrayBatch(filePath, 'semanticSegments', (items) => collector.add(mapTimelineSegments(items)));
  }
  if (arrayKeys.has('rawSignals')) {
    await forEachArrayBatch(filePath, 'rawSignals', (items) => collector.add(mapTimelineRawSignals(items)));
  }
  return collector.finish('timeline');
}

export async function readTrackFile(filePath: string, window?: TrackWindow): Promise<TrackReadResult> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.gpx') return readGpxTrack(filePath, window);
  if (extension === '.json') return readJsonTrack(filePath, window);
  throw new TrackFormatError('Track file must be .gpx or .json');
}
