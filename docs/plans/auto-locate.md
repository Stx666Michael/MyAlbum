# Auto-Locate Implementation Plan

## Status

- Complete. The feature, documentation, API tests, and Playwright flow are implemented.
- Verification passed: `npm test` (253 tests), `npm run build`, and the targeted auto-locate/map/batch/lightbox Playwright specs (8 tests).
- `stream-json` 3.7.0 is installed; it ships its own typings.

## Decisions (from your answers)

| Topic | Decision |
|---|---|
| Track input | Pick a file from the server filesystem (no upload, no size cap from us) |
| Track formats | GPX, Google `Records.json`, on-device `Timeline.json`. Legacy monthly Semantic Location History is excluded |
| Nominatim | **Off by default** (user can opt in per run in the modal). Attribution shown when used |
| Geocode cache | Persistent JSON at `~/.myalbum/geocode-cache.json`. Override with env `MYALBUM_DATA_DIR` (tests use this) |
| EXIF offset | Use per-photo `OffsetTimeOriginal` when present. Otherwise use the UTC offset set in the modal |
| Scope | Targets = unlocated photos in the current subfolder filter |
| Removed locations | Included as targets, flagged "Previously removed" in the review table |
| Companion interpolation | Only across bracket gaps of 2 h or less. Larger gaps fall back to nearest photo |
| Demo | Add 6 unlocated shots inside existing trip windows. Sample GPX built in UTC from demo specs, served by GET endpoint |

## Time model (core correctness)

Existing behavior: `photo.timestamp` for EXIF photos is wall-clock labelled as UTC (`normalizeExifTimestamp`). For file-time fallbacks it is a true instant.

`photoUtcMs(photo, opts, role)`:
- `timestampSource === 'file'`: return the instant as-is. No offset, no drift.
- `timestampSource === 'exif'`:
  - `offsetMin = useEmbeddedOffset && exifOffsetMinutes != null ? exifOffsetMinutes : utcOffsetMinutes`
  - `utc = wallClock - offsetMin`
  - if `role === 'target'`: `utc -= driftMinutes` (camera-ahead positive). Located photos are assumed to have accurate clocks.
- Track points are already UTC.

Drift is applied to unlocated targets only. Assumption, stated in the modal help text.

## Engine (pure, isomorphic): `src/utils/autoLocate.ts`

Exports:
- `haversineKm(a, b)`, `interpolateLatLng(a, b, alpha)` (handles antimeridian), `jitter(photoId)` (deterministic, ±0.0003°)
- `parseGpx(text) -> TrackPoint[]`: `trkpt`, `rtept`, `wpt` with `lat`/`lon` attributes in any order. Points without `<time>` are skipped.
- `mapRecordsLocations(items, keep?)`: `latitudeE7`/`longitudeE7` divided by 1e7. Timestamps from `timestamp` (ISO) or `timestampMs` (string or number).
- `mapTimelineSegments(items, keep?)`: `semanticSegments[].timelinePath[]` with `point: "lat°, lng°"` plus `durationMinutesOffsetFromStartTime`. Also `visit.topCandidate.placeLocation.latLng` at start and end.
- `mapTimelineRawSignals(items, keep?)`: `rawSignals[].position.LatLng` and `timestamp`.
- `photoUtcMs(photo, opts, role)`, as above.
- `matchTrack(sortedPoints, utcMs, windowMs)`:
  - Interpolate if both neighbours are within `windowMs` and the bracket gap is at most `windowMs`.
  - Otherwise use nearest point within `windowMs`.
  - Skip interpolation when implied speed exceeds 1000 km/h.
  - Confidence: interpolation `clamp(0.98 - 0.08*gap/window, 0.90, 0.98)`. Nearest `clamp(0.94 - 0.04*delta/window, 0.90, 0.94)`.
- `matchCompanions(sortedAnchors, utcMs, windowMs, companionGapMs=2h)`:
  - Binary search for prev and next anchors.
  - Interpolate when both neighbours are within `windowMs`, the bracket gap is at most 2 h, haversine distance is at most 100 km, and implied speed is at most 1000 km/h. Confidence `clamp(0.94 - 0.25*gap/2h, 0.65, 0.94)`.
  - Otherwise nearest anchor within `windowMs`. Confidence `clamp(0.80 - 0.15*delta/window, 0.65, 0.80)`.
- `extractPlaceTokens(subfolder, fileName)`:
  - Split on separators. Drop dates, pure numbers, camera codes (IMG, DSC, DCIM, P…, DJI…), `Day\d*`, and generic or indoor words (Spring, Session, Portrait, Studio, Trip, Copy, Edit, etc.).
  - Drop tokens shorter than 3 characters. Keep filename tokens before folder tokens.
- `matchGazetteer(tokens, gazetteer)`: longest n-gram match first (n = 3 to 1). Confidence 0.80 for city or landmark, 0.55 for region or country.
- `pickSuggestion(candidates)`: precedence is track > companion > gazetteer > Nominatim. Lower precedence is used only when no higher one exists.

Data module `src/utils/placeGazetteer.ts`: a curated list of about 150 to 200 entries (cities, landmarks, regions, countries) with aliases, seeded from `WORLD_PRESETS` in `BatchEditModal.tsx` and the demo trip destinations.

## Server

### Track reading: `server/trackReader.ts` (new)
- GPX: `readFile` then `parseGpx`. Fine for typical sizes.
- JSON: `stream-json` (`parser` + `pick({ filter: key })` + `streamArray()`), one pass per top-level array key: `locations` for Records, or `semanticSegments` and `rawSignals` for Timeline. Items are mapped and filtered to `[minTargetUtc - window, maxTargetUtc + window]` during streaming to bound memory.
- Format is sniffed from extension and root keys. Unknown JSON returns a clear 400 error that names the supported formats.
- Returns `{ format, points, spanStartMs, spanEndMs }`, retaining the full track span when points are window-filtered.

### Geocoder: `server/geocoder.ts` (new)
- Nominatim `GET {NOMINATIM_BASE_URL ?? https://nominatim.openstreetmap.org}/search?format=jsonv2&limit=1&accept-language=en&q=<token>`.
- Headers: `User-Agent: MyAlbum-LocalPhotoApp/1.0 (local-photo-organizer)`.
- Timeout 3000 ms. Global spacing of at least 1100 ms between request starts.
- Persistent cache with atomic write (temp file + rename). Positive hits are kept indefinitely. Misses expire after 30 days.
- Any 429, 5xx, or network error stops further lookups in the run and adds a warning.
- Injectable `fetch`, `sleep`, and clock for tests.
- Attribution string: `© OpenStreetMap contributors`. Confidence `clamp(0.5 + 0.3*importance, 0.5, 0.8)`.
- At most 20 unique tokens per run. The rest are skipped with a warning.

### Orchestration: `server/autoLocate.ts` (new)
1. `scanPhotoFolder(folderPath)`.
2. Targets = requested `photoIds` that are unlocated.
3. Anchors = effective located photos, excluding `isAutoLocated`. Sorted by anchor UTC.
4. Track: load points (or the generated sample), then `matchTrack` for each target.
5. Companion: `matchCompanions` for targets without a track suggestion.
6. Gazetteer: `extractPlaceTokens` and `matchGazetteer` for remaining targets.
7. Nominatim: unique tokens from remaining targets, geocoded with the cache.
8. Return suggestions, unmatched ids, warnings, attribution, and stats.
9. Warning when no target falls within the track's span ± window. This suggests checking the UTC offset or drift.

### `server/app.ts`
- **scanPhotoFolder**: add `timestampSource` (`'exif'` if a date tag was used, else `'file'`), `exifOffsetMinutes` (from `OffsetTimeOriginal`, or `OffsetTimeDigitized` when `CreateDate` is used), and `isAutoLocated`.
- **PhotoOverrideEntry**: add `locationSource?: 'auto-locate'`.
- **`POST /api/photos/auto-locate`**: body is `{ folderPath, photoIds, trackSource?: {type:'file', path} | {type:'sample'}, options: { windowMinutes ∈ {30,120,360,1440,10080}, utcOffsetMinutes ∈ [-840,840], driftMinutes ∈ [-720,720], useEmbeddedOffset, enableCompanion, enableGazetteer, enableNominatim } }`. API and UI defaults for `enableNominatim` are both false.
  - File track: must be an existing `.gpx` or `.json` file (404 if missing, 400 for bad extension).
  - Returns only derived suggestions, never raw track contents.
- **`GET /api/demo/sample-track.gpx`**: serves the generated sample GPX with content type `application/gpx+xml`.
- **`GET /api/browse?dir=…&kind=track`**: also returns `files: {name, path, size}[]` for `.gpx` and `.json`.
- **handleBatchEdit**:
  - New `perPhotoLocations?: {photoId, location}[]` branch. Today the endpoint rejects an empty `photoIds`, so this branch must skip that check.
  - Rejects combination with `timeEdit` or `locationEdit`, duplicate ids, and unknown ids (400).
  - Clamps coordinates and sets `entry.location` plus `entry.locationSource = 'auto-locate'`.
  - `set`, `remove`, and `restore` modes clear `locationSource`.
  - Applies atomically: validation first, then one write.
- Route: `app.patch` and `app.post` keep their existing wiring.

## Frontend

- **`src/types/photo.ts`**:
  - Add `AutoLocateStrategy`, `AutoLocateSuggestion`, `AutoLocateOptions`, `AutoLocateRequest`, `AutoLocateResponse`, and `BrowseFileEntry`.
  - `BrowseResponse.files?`.
  - `BatchEditRequest.perPhotoLocations?`.
  - `PhotoItem`: optional `timestampSource`, `exifOffsetMinutes`, `isAutoLocated`.
- **`src/components/AutoLocateModal.tsx` (new)**:
  - Track section: "Choose track file" opens an inline browser (uses `/api/browse?kind=track`, starting at the album folder). Also "Use sample track" and a clear button.
  - Time section: window select with presets (30 min, 2 h, 6 h, 24 h, 7 d), `±HH:MM` offset field (default `+00:00`), "Use per-photo EXIF offset" (default on), drift minutes (default 0, help text says positive means the camera clock is ahead, applied to unlocated photos only).
  - Sources section: companion (on), gazetteer (on), OpenStreetMap Nominatim (**off by default**). Nominatim has disclosure text: "Sends unmatched folder and file place names (not photos) to openstreetmap.org."
  - Results: summary chips, minimum-confidence slider (default 0.65 for pre-check), table with checkbox, thumbnail, wall-clock time (tooltip shows UTC used), place name and coordinates, strategy badge, confidence color (green at least 0.85, amber 0.65 to 0.85, red below 0.65), reason, "Previously removed" badge.
  - Warnings list. Attribution footer when Nominatim results are present.
  - Footer: "Apply selected (N)". Calls `onApply(selectedSuggestions)`.
  - testids: `auto-locate-modal`, `auto-locate-track-choose`, `auto-locate-sample-btn`, `auto-locate-window`, `auto-locate-utc-offset`, `auto-locate-drift`, `auto-locate-nominatim`, `auto-locate-run-btn`, `auto-locate-row-<id>`, `auto-locate-apply-btn`.
- **`src/components/MapView.tsx`**: "Auto-Locate" button in the unlocated drawer action row (near "Place on Map", testid `auto-locate-unlocated-btn`). New prop `onOpenAutoLocate`.
- **`src/components/BatchEditModal.tsx`**: "Auto-locate unlocated…" button in the Location tab (testid `open-auto-locate-btn`). It closes the batch modal and opens auto-locate. New prop `onOpenAutoLocate`.
- **`src/components/PhotoLightbox.tsx`**: small "Auto-located" pill next to the location when `photo.isAutoLocated`.
- **`src/App.tsx`**:
  - State `isAutoLocateOpen`. Targets are unlocated photos in `filteredPhotos`.
  - Renders `AutoLocateModal`.
  - `applyBatchEditRequest` options gain `perPhotoLocations`. Its `photoIds` come from the suggestions.
  - Toast reuses "Updated locations for N photos" with an "auto-located" wording.

## Demo album: `server/demoGenerator.ts`

- Add 6 unlocated specs inside existing trip windows, with folder and file tokens for gazetteer. Mix of cases:
  - Two shots inside located-photo brackets of 2 h or less (companion interpolation).
  - One shot within 30 min of a located photo (nearest companion when no track is selected; the sample track may take precedence when it covers the timestamp).
  - Two shots that get track matches when the sample track is loaded.
  - One shot with no usable signal, which stays unmatched.
- `DEMO_GENERATOR_VERSION` 2 to 3, which forces regeneration. Spec count changes automatically.
- `buildDemoSampleTrackGpx()` and `demoRoutePointAt(utcMs)`: 5-minute samples, linearly interpolated between consecutive located photos in the same trip. Segments longer than 6 h are skipped.
- Demo `dateIso` values are UTC, and EXIF wall-clock equals UTC, so the default offset of +00:00 is correct for demo data.
- Studio shots stay as they are and remain unmatched.

## Test-file change for demo

`tests/server/demo-album.test.ts`: totals change from 52 / 48 to 58 / 48 (6 unlocated shots added, located count unchanged). Add an assertion that the sample track places the trip shots within 50 m of `demoRoutePointAt`. It runs at engine level (`parseGpx` + `matchTrack`), so this todo does not depend on the endpoint. The endpoint-level check lives in `tests/server/auto-locate.test.ts`.

## Tests

There is no `tests/myalbum.test.ts`. Vitest runs `tests/**/*.test.ts`, so the new files below are picked up automatically.

- `tests/utils/auto-locate.test.ts` (new):
  - Haversine: Tokyo to Paris is about 9,711 km (accept 9,650 to 9,750).
  - Antimeridian interpolation.
  - `photoUtcMs` table: EXIF with `+09:00` offset, EXIF with UI offset, file-source ignores offsets, drift applies only to targets.
  - GPX attribute order, missing time, `+09:00` timestamps.
  - Records E7 values and string `timestampMs`. Timeline `°` format.
  - `matchTrack` interpolation midpoint and nearest-in-window. No match outside window. Speed guard.
  - `matchCompanions` interpolation under 2 h, nearest above 2 h, no match beyond 100 km.
  - Tokenizer cases: `Day1-Shibuya`, `IMG_1001_Meiji_Shrine_Mist.jpg`.
  - Precedence order.
- `tests/server/auto-locate.test.ts` (new):
  - Scratch folder under `test-results/` with EXIF-tagged JPEGs and a GPX file.
  - POST with `trackSource` file and sample. Check strategies and warnings.
  - Missing or bad track path errors.
  - `enableNominatim: false` makes no network calls.
  - Nominatim via `NOMINATIM_BASE_URL` pointing to a local stub server. Verifies User-Agent, cache file creation, and cache hits on second run. `MYALBUM_DATA_DIR` set to a temp dir.
  - `GET /api/browse?kind=track` returns files.
  - `GET /api/demo/sample-track.gpx` returns GPX with at least 100 points.
- `tests/server/batch-edits.test.ts`: add `perPhotoLocations` cases (apply, restore clears marker, validation errors, `photoIds` not required).
- `tests/server/exif-metadata.test.ts`: `OffsetTimeOriginal` is read.
- `tests/server/demo-album.test.ts`: count changes and sample-track assertion (see above).
- `e2e/auto-locate.spec.ts` (new): reset demo, confirm companion matching without a track, load the sample track and verify track precedence, apply the selected matches, and confirm the unlocated count drops. Nominatim remains off by default.
- Existing e2e suites that touch changed UI: `map.spec.ts`, `selection-and-batch.spec.ts`, `lightbox.spec.ts`.

## Verification commands

- Targeted: `npx vitest run tests/utils/auto-locate.test.ts tests/server/auto-locate.test.ts tests/server/batch-edits.test.ts tests/server/demo-album.test.ts tests/server/exif-metadata.test.ts`
- Full unit: `npm test`
- Types and bundle: `npm run build`
- Targeted e2e: `npx playwright test e2e/auto-locate.spec.ts e2e/map.spec.ts e2e/selection-and-batch.spec.ts e2e/lightbox.spec.ts`
- No linter exists in `package.json`. Nothing to run there.

## Documentation

- `README.md`: feature section for auto-locate, API table (new endpoints, `PATCH` `perPhotoLocations`, `browse?kind=track`), test list, dependency note, Nominatim opt-in (off by default) and attribution note, and the geocode cache location (`~/.myalbum/geocode-cache.json`, overridable with `MYALBUM_DATA_DIR`).
- This file is the implementation plan; README.md documents user-facing behavior and the REST API.

## Dependencies

- `stream-json` 3.7.0 (runtime) is installed. It is needed so Records.json above roughly 512 MB works. `@types/stream-json` is not used because 3.x ships its own typings (`src/index.d.ts`).

## Risks and assumptions

- Nominatim is off by default. If the user turns it on, unmatched folder and file words are sent to openstreetmap.org. The modal discloses this.
- Previously removed locations are targeted by default. They are flagged so the user can deselect them.
- `OffsetTimeOriginal` depends on exifr returning it. Verified by a test. If exifr does not return it, the UI offset is the fallback.
- Anchors are the whole folder's located photos (excluding auto-located ones). Targets are the current filter.
- `~/.myalbum/` is a new location outside the repo. Created only when Nominatim is used.
- Drift is applied only to unlocated photos. Located photos are assumed accurate.
- The public Nominatim service remains disabled unless a user opts in.
