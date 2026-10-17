export interface PhotoExif {
  make?: string;
  model?: string;
  lensModel?: string;
  focalLength?: number;
  fNumber?: number;
  exposureTime?: string;
  iso?: number;
  width?: number;
  height?: number;
}

export interface PhotoLocation {
  lat: number;
  lng: number;
  name?: string;
}

export interface PhotoItem {
  id: string;
  fileName: string;
  relativePath: string;
  subfolder: string;
  fullPath: string;
  url: string;
  fileSize: number;
  timestamp: string;          // Effective ISO timestamp (after any batch edit)
  originalTimestamp: string;  // Original EXIF / file creation time
  location: PhotoLocation | null;
  originalLocation: PhotoLocation | null;
  exif: PhotoExif;
  isTimeEdited?: boolean;
  isLocationEdited?: boolean;
  isEdited?: boolean;
  // 'exif': `timestamp` is EXIF wall-clock labelled as UTC. 'file': `timestamp` is a true instant.
  timestampSource?: 'exif' | 'file';
  // Minutes east of UTC (+09:00 = 540) from the EXIF offset tag; null when the photo has none.
  exifOffsetMinutes?: number | null;
  isAutoLocated?: boolean;
}

export type BatchTimeEdit =
  | {
      mode: 'exact';
      timestamp: string; // ISO string
      stepMinutes?: number;
    }
  | {
      mode: 'offset';
      offsetMs: number;
    }
  | {
      mode: 'restore';
    };

export type BatchLocationEdit =
  | {
      mode: 'set';
      location: PhotoLocation;
    }
  | {
      mode: 'remove';
    }
  | {
      mode: 'restore';
    };

export interface BatchPerPhotoLocation {
  photoId: string;
  location: PhotoLocation;
}

export interface BatchEditRequest {
  folderPath: string;
  photoIds: string[];
  timeEdit?: BatchTimeEdit;
  locationEdit?: BatchLocationEdit;
  // Used by auto-locate. Cannot be combined with timeEdit or locationEdit.
  perPhotoLocations?: BatchPerPhotoLocation[];
}

export interface ScanResponse {
  folderPath: string;
  folderName: string;
  photos: PhotoItem[];
  subfolders: string[];
  totalCount: number;
  locatedCount: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hasSubfolders: boolean;
  imageCount: number;
}

export interface BrowseFileEntry {
  name: string;
  path: string;
  size: number;
}

export interface BrowseResponse {
  currentPath: string;
  parentPath: string | null;
  drives: string[];
  directories: DirectoryEntry[];
  imageCountInCurrent: number;
  files?: BrowseFileEntry[];
}

export type AutoLocateStrategy = 'track' | 'companion' | 'gazetteer' | 'nominatim' | 'ai';
export type AiLocateProvider = 'local-onnx' | 'ollama' | 'cloud-vlm';
export type AutoLocateWindowMinutes = 30 | 120 | 360 | 1440 | 10080;
export type AutoLocateTrackSource = { type: 'file'; path: string } | { type: 'sample' };
export interface AutoLocateOptions {
  windowMinutes: AutoLocateWindowMinutes;
  utcOffsetMinutes: number;  // Minutes east of UTC (+09:00 = 540). Used when no per-photo EXIF offset applies
  driftMinutes: number;      // Positive when the camera clock is ahead. Applied to unlocated photos only
  useEmbeddedOffset: boolean;
  enableCompanion: boolean;
  enableGazetteer: boolean;
  enableNominatim: boolean;
  enableAi?: boolean;
  aiProvider?: AiLocateProvider;
  aiModel?: string;
  aiEndpoint?: string;
  aiApiKey?: string;
}
export interface AutoLocateRequest {
  folderPath: string;
  photoIds: string[];
  trackSource?: AutoLocateTrackSource;
  options: AutoLocateOptions;
}
export interface AutoLocateSuggestion {
  photoId: string;
  location: PhotoLocation & { name: string };
  strategy: AutoLocateStrategy;
  confidence: number;        // 0..1
  reason: string;
  utcIso: string | null;     // the instant used for matching
  previouslyRemoved: boolean;
}
export interface AutoLocateStats {
  targets: number;
  matched: number;
  byStrategy: Partial<Record<AutoLocateStrategy, number>>;
  trackPoints: number;
  geocodeLookups: number;
  aiInferences?: number;
}
export interface AutoLocateResponse {
  suggestions: AutoLocateSuggestion[];
  unmatchedPhotoIds: string[];
  warnings: string[];
  attribution: string | null;
  stats: AutoLocateStats;
}
