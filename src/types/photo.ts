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

export interface BatchEditRequest {
  folderPath: string;
  photoIds: string[];
  timeEdit?: BatchTimeEdit;
  locationEdit?: BatchLocationEdit;
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

export interface BrowseResponse {
  currentPath: string;
  parentPath: string | null;
  drives: string[];
  directories: DirectoryEntry[];
  imageCountInCurrent: number;
}
