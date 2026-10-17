import express, { type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import { buildDemoSampleTrackGpx, ensureDemoPhotosGenerated } from './demoGenerator.ts';
import { autoLocatePhotos, autoLocateTargetTimes } from './autoLocate.ts';
import { createGeocodeSession } from './geocoder.ts';
import { readTrackFile, TrackFormatError } from './trackReader.ts';
import { parseGpx, sortByUtc } from '../src/utils/autoLocate.ts';
import type {
  AutoLocateOptions,
  AutoLocateRequest,
  AutoLocateTrackSource,
  AutoLocateWindowMinutes,
  BatchEditRequest,
  BrowseFileEntry,
  BrowseResponse,
  DirectoryEntry,
  PhotoExif,
  PhotoItem,
  PhotoLocation,
  ScanResponse,
} from '../src/types/photo.ts';

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.gif',
  '.heic',
  '.bmp',
  '.tiff',
  '.tif',
  '.svg',
]);

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
};

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.vite',
  'dist',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

interface PhotoOverrideEntry {
  timestamp?: string;
  location?: PhotoLocation | null;
  // Set when auto-locate wrote `location`. Manual location edits clear it.
  locationSource?: 'auto-locate';
}

type OverridesMap = Record<string, PhotoOverrideEntry>;

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAutoLocateWindowMinutes(value: unknown): value is AutoLocateWindowMinutes {
  return typeof value === 'number' && [30, 120, 360, 1440, 10080].includes(value);
}

function parseAutoLocateRequest(value: unknown): AutoLocateRequest {
  if (!isRecord(value)) {
    throw new ApiRequestError('Request body must be an object', 400);
  }
  if (typeof value.folderPath !== 'string' || value.folderPath.trim() === '') {
    throw new ApiRequestError('folderPath is required', 400);
  }
  if (
    !Array.isArray(value.photoIds) ||
    value.photoIds.length === 0 ||
    !value.photoIds.every((photoId) => typeof photoId === 'string' && photoId.length > 0)
  ) {
    throw new ApiRequestError('photoIds must be a non-empty array of strings', 400);
  }
  if (new Set(value.photoIds).size !== value.photoIds.length) {
    throw new ApiRequestError('photoIds must not contain duplicates', 400);
  }
  if (!isRecord(value.options)) {
    throw new ApiRequestError('options is required', 400);
  }

  const rawOptions = value.options;
  if (!isAutoLocateWindowMinutes(rawOptions.windowMinutes)) {
    throw new ApiRequestError('options.windowMinutes must be 30, 120, 360, 1440 or 10080', 400);
  }
  if (
    typeof rawOptions.utcOffsetMinutes !== 'number' ||
    !Number.isInteger(rawOptions.utcOffsetMinutes) ||
    rawOptions.utcOffsetMinutes < -840 ||
    rawOptions.utcOffsetMinutes > 840
  ) {
    throw new ApiRequestError('options.utcOffsetMinutes must be an integer from -840 to 840', 400);
  }
  if (
    typeof rawOptions.driftMinutes !== 'number' ||
    !Number.isInteger(rawOptions.driftMinutes) ||
    rawOptions.driftMinutes < -720 ||
    rawOptions.driftMinutes > 720
  ) {
    throw new ApiRequestError('options.driftMinutes must be an integer from -720 to 720', 400);
  }
  if (typeof rawOptions.useEmbeddedOffset !== 'boolean') {
    throw new ApiRequestError('options.useEmbeddedOffset must be a boolean', 400);
  }
  if (typeof rawOptions.enableCompanion !== 'boolean') {
    throw new ApiRequestError('options.enableCompanion must be a boolean', 400);
  }
  if (typeof rawOptions.enableGazetteer !== 'boolean') {
    throw new ApiRequestError('options.enableGazetteer must be a boolean', 400);
  }
  if (rawOptions.enableNominatim !== undefined && typeof rawOptions.enableNominatim !== 'boolean') {
    throw new ApiRequestError('options.enableNominatim must be a boolean', 400);
  }

  let trackSource: AutoLocateTrackSource | undefined;
  if (value.trackSource !== undefined) {
    if (!isRecord(value.trackSource)) {
      throw new ApiRequestError('trackSource must be an object', 400);
    }
    if (value.trackSource.type === 'sample') {
      trackSource = { type: 'sample' };
    } else if (value.trackSource.type === 'file') {
      if (typeof value.trackSource.path !== 'string' || value.trackSource.path.trim() === '') {
        throw new ApiRequestError('trackSource.path is required for a file track', 400);
      }
      trackSource = { type: 'file', path: value.trackSource.path };
    } else {
      throw new ApiRequestError('trackSource.type must be "file" or "sample"', 400);
    }
  }

  const options: AutoLocateOptions = {
    windowMinutes: rawOptions.windowMinutes,
    utcOffsetMinutes: rawOptions.utcOffsetMinutes,
    driftMinutes: rawOptions.driftMinutes,
    useEmbeddedOffset: rawOptions.useEmbeddedOffset,
    enableCompanion: rawOptions.enableCompanion,
    enableGazetteer: rawOptions.enableGazetteer,
    enableNominatim: rawOptions.enableNominatim === true,
  };
  return {
    folderPath: value.folderPath,
    photoIds: value.photoIds,
    ...(trackSource ? { trackSource } : {}),
    options,
  };
}

const KNOWN_CITIES: Array<{ name: string; lat: number; lng: number }> = [
  { name: 'Tokyo, Japan', lat: 35.6762, lng: 139.6503 },
  { name: 'Paris, France', lat: 48.8566, lng: 2.3522 },
  { name: 'Reykjavik, Iceland', lat: 64.1466, lng: -21.9426 },
  { name: 'Vik, South Coast, Iceland', lat: 63.4186, lng: -19.0060 },
  { name: 'Snæfellsnes, Iceland', lat: 64.87, lng: -23.35 },
  { name: 'New York, NY, USA', lat: 40.7128, lng: -74.0060 },
  { name: 'Cairo, Egypt', lat: 30.0444, lng: 31.2357 },
  { name: 'Sydney, Australia', lat: -33.8688, lng: 151.2093 },
  { name: 'London, United Kingdom', lat: 51.5072, lng: -0.1276 },
  { name: 'San Francisco, CA, USA', lat: 37.7749, lng: -122.4194 },
  { name: 'Rome, Italy', lat: 41.9028, lng: 12.4964 },
  { name: 'Rio de Janeiro, Brazil', lat: -22.9068, lng: -43.1729 },
  { name: 'Cape Town, South Africa', lat: -33.9249, lng: 18.4241 },
  { name: 'Singapore', lat: 1.3521, lng: 103.8198 },
];

function inferLocationName(lat: number, lng: number, hint?: string): string {
  if (hint) return hint;
  let bestCity: string | null = null;
  let bestDistSq = Infinity;
  for (const city of KNOWN_CITIES) {
    const dLat = lat - city.lat;
    const dLng = lng - city.lng;
    const distSq = dLat * dLat + dLng * dLng;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestCity = city.name;
    }
  }
  if (bestCity && bestDistSq <= 2.25) {
    return bestCity;
  }
  const latStr = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`;
  const lngStr = `${Math.abs(lng).toFixed(3)}°${lng >= 0 ? 'E' : 'W'}`;
  return `${latStr}, ${lngStr}`;
}

function formatExposureTime(val: unknown): string | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return undefined;
  if (val >= 1) {
    return `${Number(val.toFixed(1))}s`;
  }
  const denom = Math.round(1 / val);
  return `1/${denom}s`;
}

function normalizeExifTimestamp(rawDate: unknown, fallbackMs: number): string {
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    const utcMs = Date.UTC(
      rawDate.getFullYear(),
      rawDate.getMonth(),
      rawDate.getDate(),
      rawDate.getHours(),
      rawDate.getMinutes(),
      rawDate.getSeconds()
    );
    return new Date(utcMs).toISOString();
  }
  if (typeof rawDate === 'string') {
    const m = rawDate.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
    }
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(fallbackMs).toISOString();
}

// Date tags in fallback order, each paired with the offset tag that describes its timezone
const EXIF_DATE_SOURCES: Array<{ dateTag: string; offsetTag: string | null }> = [
  { dateTag: 'DateTimeOriginal', offsetTag: 'OffsetTimeOriginal' },
  { dateTag: 'CreateDate', offsetTag: 'OffsetTimeDigitized' },
  { dateTag: 'ModifyDate', offsetTag: null },
];

function parseUtcOffsetMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^([+-])(0\d|1[0-4]):([0-5]\d)$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' && minutes > 0 ? -minutes : minutes;
}

async function readOverrides(folderPath: string): Promise<OverridesMap> {
  const filePath = path.join(folderPath, '.myalbum-overrides.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as OverridesMap) : {};
  } catch {
    return {};
  }
}

async function writeOverrides(folderPath: string, overrides: OverridesMap): Promise<void> {
  const filePath = path.join(folderPath, '.myalbum-overrides.json');
  await fs.writeFile(filePath, JSON.stringify(overrides, null, 2), 'utf8');
}

async function readLocationHints(folderPath: string): Promise<Record<string, string>> {
  const markerPath = path.join(folderPath, '.myalbum-demo-ready.json');
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.locationHints ?? {};
  } catch {
    return {};
  }
}

async function walkPhotoFiles(rootDir: string, currentDir: string, results: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walkPhotoFiles(rootDir, fullPath, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export async function scanPhotoFolder(folderPath: string): Promise<ScanResponse> {
  const resolvedRoot = path.resolve(folderPath);
  const stat = await fs.stat(resolvedRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedRoot}`);
  }

  const [filePaths, overrides, locationHints] = await Promise.all([
    walkPhotoFiles(resolvedRoot, resolvedRoot),
    readOverrides(resolvedRoot),
    readLocationHints(resolvedRoot),
  ]);

  const subfoldersSet = new Set<string>();

  const photos: PhotoItem[] = await Promise.all(
    filePaths.map(async (fullPath) => {
      const fileStat = await fs.stat(fullPath);
      const relNative = path.relative(resolvedRoot, fullPath);
      const relativePath = relNative.split(path.sep).join('/');
      const dirname = path.posix.dirname(relativePath);
      const subfolder = dirname === '.' ? '' : dirname;
      if (subfolder) {
        subfoldersSet.add(subfolder);
      }

      let rawExif: Record<string, any> | null = null;
      try {
        rawExif = await exifr.parse(fullPath, {
          tiff: true,
          exif: true,
          gps: true,
        });
      } catch {
        rawExif = null;
      }

      const fallbackMs = fileStat.mtimeMs || fileStat.birthtimeMs || Date.now();
      const exifDateSource = EXIF_DATE_SOURCES.find(({ dateTag }) => rawExif?.[dateTag] != null);
      const rawDate = exifDateSource ? rawExif?.[exifDateSource.dateTag] : undefined;
      const originalTimestamp = normalizeExifTimestamp(rawDate, fallbackMs);
      // Only file time depends on fallbackMs, so a 1 ms shift reveals whether the EXIF date was used.
      const timestampFromExif = normalizeExifTimestamp(rawDate, fallbackMs + 1) === originalTimestamp;
      const timestampSource = timestampFromExif ? 'exif' : 'file';
      const exifOffsetMinutes =
        timestampFromExif && exifDateSource?.offsetTag
          ? parseUtcOffsetMinutes(rawExif?.[exifDateSource.offsetTag])
          : null;

      let originalLocation: PhotoLocation | null = null;
      if (
        rawExif &&
        typeof rawExif.latitude === 'number' &&
        typeof rawExif.longitude === 'number' &&
        Number.isFinite(rawExif.latitude) &&
        Number.isFinite(rawExif.longitude)
      ) {
        const lat = Number(rawExif.latitude.toFixed(6));
        const lng = Number(rawExif.longitude.toFixed(6));
        originalLocation = {
          lat,
          lng,
          name: inferLocationName(lat, lng, locationHints[relativePath]),
        };
      }

      const exif: PhotoExif = {
        make: typeof rawExif?.Make === 'string' ? rawExif.Make.replace(/\0/g, '').trim() : undefined,
        model: typeof rawExif?.Model === 'string' ? rawExif.Model.replace(/\0/g, '').trim() : undefined,
        lensModel: typeof rawExif?.LensModel === 'string' ? rawExif.LensModel.replace(/\0/g, '').trim() : undefined,
        focalLength: typeof rawExif?.FocalLength === 'number' ? Number(rawExif.FocalLength.toFixed(1)) : undefined,
        fNumber: typeof rawExif?.FNumber === 'number' ? Number(rawExif.FNumber.toFixed(1)) : undefined,
        exposureTime: formatExposureTime(rawExif?.ExposureTime),
        iso: typeof rawExif?.ISO === 'number' ? rawExif.ISO : undefined,
        width:
          typeof rawExif?.ExifImageWidth === 'number'
            ? rawExif.ExifImageWidth
            : typeof rawExif?.ImageWidth === 'number'
              ? rawExif.ImageWidth
              : undefined,
        height:
          typeof rawExif?.ExifImageHeight === 'number'
            ? rawExif.ExifImageHeight
            : typeof rawExif?.ImageHeight === 'number'
              ? rawExif.ImageHeight
              : undefined,
      };

      const override = overrides[relativePath];
      const isTimeEdited = Boolean(override && typeof override.timestamp === 'string');
      const isLocationEdited = Boolean(override && 'location' in override);

      const effectiveTimestamp = isTimeEdited && override.timestamp ? override.timestamp : originalTimestamp;
      let effectiveLocation: PhotoLocation | null = originalLocation;
      if (isLocationEdited) {
        effectiveLocation = override.location ?? null;
      }

      const isAutoLocated = override?.locationSource === 'auto-locate' && effectiveLocation !== null;

      return {
        id: relativePath,
        fileName: path.basename(fullPath),
        relativePath,
        subfolder,
        fullPath,
        url: `/api/photo?path=${encodeURIComponent(fullPath)}`,
        fileSize: fileStat.size,
        timestamp: effectiveTimestamp,
        originalTimestamp,
        location: effectiveLocation,
        originalLocation,
        exif,
        isTimeEdited,
        isLocationEdited,
        isEdited: isTimeEdited || isLocationEdited,
        timestampSource,
        exifOffsetMinutes,
        isAutoLocated,
      };
    })
  );

  photos.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const subfolders = Array.from(subfoldersSet).sort();
  const locatedCount = photos.filter((p) => p.location !== null).length;

  return {
    folderPath: resolvedRoot,
    folderName: path.basename(resolvedRoot) || resolvedRoot,
    photos,
    subfolders,
    totalCount: photos.length,
    locatedCount,
  };
}

async function detectDrives(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return ['/'];
  }
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const drives: string[] = [];
  for (const letter of letters) {
    const drivePath = `${letter}:\\`;
    try {
      await fs.access(drivePath);
      drives.push(drivePath);
    } catch {
      // ignore missing drives
    }
  }
  return drives.length > 0 ? drives : ['C:\\'];
}

// Validates every entry before any override is touched, so a rejected batch leaves the sidecar unchanged.
function resolvePerPhotoLocations(body: BatchEditRequest, photoMap: Map<string, PhotoItem>) {
  if (body.timeEdit != null || body.locationEdit != null) {
    throw new Error('perPhotoLocations cannot be combined with timeEdit or locationEdit');
  }
  if (!Array.isArray(body.perPhotoLocations) || body.perPhotoLocations.length === 0) {
    throw new Error('perPhotoLocations must be a non-empty array');
  }
  if (body.photoIds != null && !Array.isArray(body.photoIds)) {
    throw new Error('photoIds must be an array');
  }

  const seenIds = new Set<string>();
  const targets = body.perPhotoLocations.map((item) => {
    if (!item || typeof item.photoId !== 'string') {
      throw new Error('Each perPhotoLocations entry needs a string photoId');
    }
    if (seenIds.has(item.photoId)) {
      throw new Error(`Duplicate photoId in perPhotoLocations: ${item.photoId}`);
    }
    if (!photoMap.has(item.photoId)) {
      throw new Error(`Photo not found for photoId: ${item.photoId}`);
    }
    const location = item.location;
    if (
      !location ||
      typeof location.lat !== 'number' ||
      typeof location.lng !== 'number' ||
      !Number.isFinite(location.lat) ||
      !Number.isFinite(location.lng)
    ) {
      throw new Error(`Invalid location coordinates for photoId: ${item.photoId}`);
    }
    if (typeof location.name !== 'string') {
      throw new Error(`Location name must be a string for photoId: ${item.photoId}`);
    }
    seenIds.add(item.photoId);
    return {
      photoId: item.photoId,
      location: {
        lat: Math.max(-90, Math.min(90, Number(location.lat.toFixed(6)))),
        lng: Math.max(-180, Math.min(180, Number(location.lng.toFixed(6)))),
        name: location.name.trim(),
      },
    };
  });

  if (Array.isArray(body.photoIds) && body.photoIds.length > 0) {
    const requestedIds = new Set(body.photoIds);
    if (requestedIds.size !== seenIds.size || body.photoIds.some((id) => !seenIds.has(id))) {
      throw new Error('photoIds must match the photoIds in perPhotoLocations exactly');
    }
  }

  return targets;
}

export function createApiApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/browse', async (req: Request, res: Response) => {
    try {
      const requestedDir = typeof req.query.dir === 'string' && req.query.dir.trim() ? req.query.dir.trim() : process.cwd();
      const currentPath = path.resolve(requestedDir);
      const drives = await detectDrives();

      const parentCandidate = path.dirname(currentPath);
      const parentPath = parentCandidate !== currentPath ? parentCandidate : null;

      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      let imageCountInCurrent = 0;
      const directories: DirectoryEntry[] = [];
      const includeTrackFiles = req.query.kind === 'track';
      const files: BrowseFileEntry[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        const entryFullPath = path.join(currentPath, entry.name);
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (IMAGE_EXTENSIONS.has(ext)) {
            imageCountInCurrent++;
          }
          if (includeTrackFiles && (ext === '.gpx' || ext === '.json')) {
            const stat = await fs.stat(entryFullPath);
            files.push({ name: entry.name, path: entryFullPath, size: stat.size });
          }
        } else if (entry.isDirectory()) {
          let hasSubfolders = false;
          let imageCount = 0;
          try {
            const subEntries = await fs.readdir(entryFullPath, { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.name.startsWith('.')) continue;
              if (sub.isDirectory() && !IGNORED_DIRS.has(sub.name)) {
                hasSubfolders = true;
              } else if (sub.isFile() && IMAGE_EXTENSIONS.has(path.extname(sub.name).toLowerCase())) {
                imageCount++;
              }
            }
          } catch {
            // Permission denied on child folder; skip child count
          }
          directories.push({
            name: entry.name,
            path: entryFullPath,
            hasSubfolders,
            imageCount,
          });
        }
      }

      directories.sort((a, b) => a.name.localeCompare(b.name));

      const response: BrowseResponse = {
        currentPath,
        parentPath,
        drives,
        directories,
        imageCountInCurrent,
        ...(includeTrackFiles ? { files: files.sort((a, b) => a.name.localeCompare(b.name)) } : {}),
      };
      res.json(response);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Unable to browse directory' });
    }
  });

  app.get('/api/demo/sample-track.gpx', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/gpx+xml');
    res.send(buildDemoSampleTrackGpx());
  });

  app.post('/api/photos/auto-locate', async (req: Request, res: Response) => {
    try {
      const request = parseAutoLocateRequest(req.body);
      const scanResult = await scanPhotoFolder(request.folderPath);
      const photosById = new Map(scanResult.photos.map((photo) => [photo.id, photo]));
      const missingIds = request.photoIds.filter((photoId) => !photosById.has(photoId));
      if (missingIds.length > 0) {
        throw new ApiRequestError(`Photo IDs not found: ${missingIds.join(', ')}`, 400);
      }

      let track = null;
      if (request.trackSource?.type === 'file') {
        const trackPath = path.resolve(request.trackSource.path);
        const extension = path.extname(trackPath).toLowerCase();
        if (extension !== '.gpx' && extension !== '.json') {
          throw new ApiRequestError('Track file must be .gpx or .json', 400);
        }
        let trackStat;
        try {
          trackStat = await fs.stat(trackPath);
        } catch (error) {
          if (isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            throw new ApiRequestError('Track file not found', 404);
          }
          throw error;
        }
        if (!trackStat.isFile()) {
          throw new ApiRequestError('Track file not found', 404);
        }

        const targetTimes = autoLocateTargetTimes(scanResult.photos, request.photoIds, request.options);
        const windowMs = request.options.windowMinutes * 60_000;
        const trackWindow =
          targetTimes.length > 0
            ? {
                startMs: targetTimes.reduce((min, utcMs) => Math.min(min, utcMs), Number.POSITIVE_INFINITY) -
                  windowMs,
                endMs: targetTimes.reduce((max, utcMs) => Math.max(max, utcMs), Number.NEGATIVE_INFINITY) +
                  windowMs,
              }
            : undefined;
        try {
          track = await readTrackFile(trackPath, trackWindow);
        } catch (error) {
          if (error instanceof TrackFormatError) {
            throw new ApiRequestError(error.message, 400);
          }
          throw error;
        }
      } else if (request.trackSource?.type === 'sample') {
        const points = sortByUtc(parseGpx(buildDemoSampleTrackGpx()));
        track = {
          points,
          spanStartMs: points[0]?.utcMs ?? null,
          spanEndMs: points.at(-1)?.utcMs ?? null,
        };
      }

      const geocoder = request.options.enableNominatim ? createGeocodeSession() : undefined;
      const result = await autoLocatePhotos(
        scanResult.photos,
        request.photoIds,
        request.options,
        track,
        geocoder,
      );
      res.json(result);
    } catch (error: unknown) {
      const status =
        error instanceof ApiRequestError
          ? error.status
          : isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
            ? 404
            : 400;
      res.status(status).json({
        error: error instanceof Error ? error.message : 'Auto-locate failed',
      });
    }
  });

  app.post('/api/demo', async (req: Request, res: Response) => {
    try {
      const sampleRoot = path.resolve(process.cwd(), 'sample-photos');
      if (req.body?.reset) {
        const overridesFile = path.join(sampleRoot, '.myalbum-overrides.json');
        await fs.rm(overridesFile, { force: true });
      }
      await ensureDemoPhotosGenerated(sampleRoot);
      const scanResult = await scanPhotoFolder(sampleRoot);
      res.json(scanResult);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to generate or scan demo album' });
    }
  });

  app.post('/api/scan', async (req: Request, res: Response) => {
    try {
      const folderPath = req.body?.folderPath;
      if (!folderPath || typeof folderPath !== 'string') {
        res.status(400).json({ error: 'folderPath is required' });
        return;
      }
      const scanResult = await scanPhotoFolder(folderPath);
      res.json(scanResult);
    } catch (err: any) {
      const status = err?.code === 'ENOENT' ? 404 : 400;
      res.status(status).json({ error: err?.message || 'Failed to scan folder' });
    }
  });

  app.get('/api/photo', async (req: Request, res: Response) => {
    try {
      const filePath = req.query.path;
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing path query parameter' });
        return;
      }
      const resolved = path.resolve(filePath);
      const ext = path.extname(resolved).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        res.status(403).json({ error: 'Unsupported file type' });
        return;
      }
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const stream = fsSync.createReadStream(resolved);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
      stream.pipe(res);
    } catch {
      res.status(404).json({ error: 'Photo not found' });
    }
  });

  const handleBatchEdit = async (req: Request, res: Response) => {
    try {
      const body = req.body as BatchEditRequest;
      if (!body?.folderPath || typeof body.folderPath !== 'string') {
        res.status(400).json({ error: 'folderPath is required' });
        return;
      }
      const hasPerPhotoLocations = body.perPhotoLocations != null;
      if (!hasPerPhotoLocations && (!Array.isArray(body.photoIds) || body.photoIds.length === 0)) {
        res.status(400).json({ error: 'photoIds must be a non-empty array' });
        return;
      }

      const resolvedRoot = path.resolve(body.folderPath);
      const currentScan = await scanPhotoFolder(resolvedRoot);
      const photoMap = new Map<string, PhotoItem>(currentScan.photos.map((p) => [p.id, p]));
      const overrides = await readOverrides(resolvedRoot);

      if (hasPerPhotoLocations) {
        const targets = resolvePerPhotoLocations(body, photoMap);
        targets.forEach(({ photoId, location }) => {
          const entry: PhotoOverrideEntry = { ...(overrides[photoId] || {}) };
          entry.location = location;
          entry.locationSource = 'auto-locate';
          overrides[photoId] = entry;
        });
        await writeOverrides(resolvedRoot, overrides);
        const updatedScan = await scanPhotoFolder(resolvedRoot);
        res.json(updatedScan);
        return;
      }

      // Sort selected photos chronologically so sequential stepMinutes preserves order
      const selectedPhotos = body.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is PhotoItem => Boolean(p))
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      if (selectedPhotos.length === 0) {
        res.status(404).json({ error: 'No matching photos found for provided photoIds' });
        return;
      }

      selectedPhotos.forEach((photo, index) => {
        const entry: PhotoOverrideEntry = { ...(overrides[photo.id] || {}) };

        if (body.timeEdit) {
          if (body.timeEdit.mode === 'restore') {
            delete entry.timestamp;
          } else if (body.timeEdit.mode === 'exact') {
            const baseMs = new Date(body.timeEdit.timestamp).getTime();
            if (Number.isNaN(baseMs)) {
              throw new Error(`Invalid timestamp: ${body.timeEdit.timestamp}`);
            }
            const stepMs = (body.timeEdit.stepMinutes ?? 0) * 60 * 1000;
            entry.timestamp = new Date(baseMs + index * stepMs).toISOString();
          } else if (body.timeEdit.mode === 'offset') {
            const currentMs = new Date(photo.timestamp).getTime();
            const offsetMs = Number(body.timeEdit.offsetMs) || 0;
            entry.timestamp = new Date(currentMs + offsetMs).toISOString();
          }
        }

        if (body.locationEdit) {
          if (body.locationEdit.mode === 'restore') {
            delete entry.location;
            delete entry.locationSource;
          } else if (body.locationEdit.mode === 'remove') {
            entry.location = null;
            delete entry.locationSource;
          } else if (body.locationEdit.mode === 'set') {
            const { lat, lng, name } = body.locationEdit.location;
            if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
              throw new Error('Invalid location coordinates');
            }
            const clampedLat = Math.max(-90, Math.min(90, Number(lat.toFixed(6))));
            const clampedLng = Math.max(-180, Math.min(180, Number(lng.toFixed(6))));
            entry.location = {
              lat: clampedLat,
              lng: clampedLng,
              name: name?.trim() || inferLocationName(clampedLat, clampedLng),
            };
            delete entry.locationSource;
          }
        }

        if (Object.keys(entry).length === 0) {
          delete overrides[photo.id];
        } else {
          overrides[photo.id] = entry;
        }
      });

      await writeOverrides(resolvedRoot, overrides);
      const updatedScan = await scanPhotoFolder(resolvedRoot);
      res.json(updatedScan);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Batch update failed' });
    }
  };

  app.patch('/api/photos/batch', handleBatchEdit);
  app.post('/api/photos/batch', handleBatchEdit);

  return app;
}
