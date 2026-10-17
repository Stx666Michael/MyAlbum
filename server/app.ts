import express, { type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import { ensureDemoPhotosGenerated } from './demoGenerator.ts';
import type {
  BatchEditRequest,
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
}

type OverridesMap = Record<string, PhotoOverrideEntry>;

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
      const rawDate = rawExif?.DateTimeOriginal ?? rawExif?.CreateDate ?? rawExif?.ModifyDate;
      const originalTimestamp = normalizeExifTimestamp(rawDate, fallbackMs);

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

      for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        const entryFullPath = path.join(currentPath, entry.name);
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (IMAGE_EXTENSIONS.has(ext)) {
            imageCountInCurrent++;
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
      };
      res.json(response);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Unable to browse directory' });
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
      if (!Array.isArray(body.photoIds) || body.photoIds.length === 0) {
        res.status(400).json({ error: 'photoIds must be a non-empty array' });
        return;
      }

      const resolvedRoot = path.resolve(body.folderPath);
      const currentScan = await scanPhotoFolder(resolvedRoot);
      const photoMap = new Map<string, PhotoItem>(currentScan.photos.map((p) => [p.id, p]));
      const overrides = await readOverrides(resolvedRoot);

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
          } else if (body.locationEdit.mode === 'remove') {
            entry.location = null;
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
