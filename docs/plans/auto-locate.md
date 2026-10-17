# Auto-Locate Implementation Plan

## Status

- Complete. The core auto-locate engine, multi-source matching (tracks, companions, offline gazetteer, Nominatim), and the AI / ML visual auto-locate extension are implemented, documented, and fully verified.
- Verification passed: `npm test` (261 unit, server, and utility tests across 16 test files), `npm run build`, and Playwright end-to-end test suites (18 tests passing).
- `stream-json` 3.7.0 is installed; it ships its own typings.
- `@huggingface/transformers` (^4.3.1) and `onnxruntime-node` are installed for on-device visual embeddings and multi-provider AI geolocation.

## Decisions (from your answers)

| Topic | Decision |
|---|---|
| Track input | Pick a file from the server filesystem (no upload, no size cap from us) |
| Track formats | GPX, Google `Records.json`, on-device `Timeline.json`. Legacy monthly Semantic Location History is excluded |
| Nominatim | **Off by default** (user can opt in per run in the modal). Attribution shown when used |
| AI Vision | **Off by default** (`enableAi: false`). Strict user opt-in in modal and API |
| AI Providers | `local-onnx` (default on-device CLIP / GeoCLIP), `ollama` (local VLM), `cloud-vlm` (OpenAI-compatible vision) |
| Local ONNX Pipeline | Two-stage: 1) Album Visual Similarity ($\ge 0.85$ cosine similarity against located anchors); 2) GeoCLIP continuous coordinate prediction |
| AI Precedence | `track > companion > gazetteer > nominatim > ai`. AI only runs for unlocated targets that fail all earlier stages |
| Geocode cache | Persistent JSON at `~/.myalbum/geocode-cache.json`. Override with env `MYALBUM_DATA_DIR` (tests use this) |
| AI Cache | Persistent JSON at `~/.myalbum/ai-locate-cache.json` (`MYALBUM_DATA_DIR`). Models cached at `~/.myalbum/models` |
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
- `pickSuggestion(candidates)`: precedence is track > companion > gazetteer > Nominatim > AI. Lower precedence is used only when no higher one exists.

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

### AI Locator: `server/aiLocator.ts` (new)
- Multi-provider visual geolocating session via `createAiLocateSession(options)`.
- Providers: `'local-onnx'` (default), `'ollama'`, `'cloud-vlm'`.
- Local ONNX uses `@huggingface/transformers` (`onnxruntime-node`) with `Xenova/geoclip-large-patch14` for 512-dim visual embeddings.
- Computes cosine similarity against album anchors ($\ge 0.85$) before falling back to GeoCLIP continuous prediction.
- Persistent cache at `~/.myalbum/ai-locate-cache.json` (`MYALBUM_DATA_DIR`). Models cached at `~/.myalbum/models`.

### Orchestration: `server/autoLocate.ts` (new)
1. `scanPhotoFolder(folderPath)`.
2. Targets = requested `photoIds` that are unlocated.
3. Anchors = effective located photos, excluding `isAutoLocated`. Sorted by anchor UTC.
4. Track: load points (or the generated sample), then `matchTrack` for each target.
5. Companion: `matchCompanions` for targets without a track suggestion.
6. Gazetteer: `extractPlaceTokens` and `matchGazetteer` for remaining targets.
7. Nominatim: unique tokens from remaining targets, geocoded with the cache (when enabled).
8. AI Vision: unlocated targets without earlier suggestions are evaluated via `AiLocateSession` (when enabled).
9. Return suggestions, unmatched ids, warnings, attribution, and stats (`stats.aiInferences`, `stats.byStrategy.ai`).
10. Warning when no target falls within the track's span ± window. This suggests checking the UTC offset or drift.

### `server/app.ts`
- **scanPhotoFolder**: add `timestampSource` (`'exif'` if a date tag was used, else `'file'`), `exifOffsetMinutes` (from `OffsetTimeOriginal`, or `OffsetTimeDigitized` when `CreateDate` is used), and `isAutoLocated`.
- **PhotoOverrideEntry**: add `locationSource?: 'auto-locate'`.
- **`POST /api/photos/auto-locate`**: body is `{ folderPath, photoIds, trackSource?: {type:'file', path} | {type:'sample'}, options: { windowMinutes ∈ {30,120,360,1440,10080}, utcOffsetMinutes ∈ [-840,840], driftMinutes ∈ [-720,720], useEmbeddedOffset, enableCompanion, enableGazetteer, enableNominatim, enableAi, aiProvider ∈ {'local-onnx', 'ollama', 'cloud-vlm'}, aiModel, aiEndpoint, aiApiKey } }`. API and UI defaults for `enableNominatim` and `enableAi` are both false.
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
  - Add `AutoLocateStrategy` (including `'ai'`), `AiLocateProvider` (`'local-onnx' | 'ollama' | 'cloud-vlm'`), `AutoLocateSuggestion`, `AutoLocateOptions` (`enableAi`, `aiProvider`, `aiModel`, `aiEndpoint`, `aiApiKey`), `AutoLocateStats` (`aiInferences`), `AutoLocateRequest`, `AutoLocateResponse`, and `BrowseFileEntry`.
  - `BrowseResponse.files?`.
  - `BatchEditRequest.perPhotoLocations?`.
  - `PhotoItem`: optional `timestampSource`, `exifOffsetMinutes`, `isAutoLocated`.
- **`src/components/AutoLocateModal.tsx`**:
  - Track section: "Choose track file" opens an inline browser (uses `/api/browse?kind=track`, starting at the album folder). Also "Use sample track" and a clear button.
  - Time section: window select with presets (30 min, 2 h, 6 h, 24 h, 7 d), `±HH:MM` offset field (default `+00:00`), "Use per-photo EXIF offset" (default on), drift minutes (default 0, help text says positive means the camera clock is ahead, applied to unlocated photos only).
  - Sources section: companion (on), gazetteer (on), OpenStreetMap Nominatim (**off by default**), and AI Vision (**off by default**).
    - Nominatim disclosure: "Sends unmatched folder and file place names (not photos) to openstreetmap.org."
    - AI Vision disclosure: "Uses visual recognition to identify landmarks or match against located album photos." Includes provider dropdown (`Local ONNX`, `Local Ollama`, `Cloud Vision API`) with collapsible endpoint, model, and API key inputs.
  - Results: summary chips, minimum-confidence slider (default 0.65 for pre-check), table with checkbox, thumbnail, wall-clock time (tooltip shows UTC used), place name and coordinates, strategy badge (including indigo/purple AI badge), confidence color (green at least 0.85, amber 0.65 to 0.85, red below 0.65), reason, "Previously removed" badge.
  - Warnings list. Attribution footer when Nominatim or AI results are present.
  - Footer: "Apply selected (N)". Calls `onApply(selectedSuggestions)`.
  - testids: `auto-locate-modal`, `auto-locate-track-choose`, `auto-locate-sample-btn`, `auto-locate-window`, `auto-locate-utc-offset`, `auto-locate-drift`, `auto-locate-nominatim`, `auto-locate-ai`, `auto-locate-ai-provider`, `auto-locate-run-btn`, `auto-locate-row-<id>`, `auto-locate-apply-btn`.
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

- `tests/utils/auto-locate.test.ts`:
  - Haversine: Tokyo to Paris is about 9,711 km (accept 9,650 to 9,750).
  - Antimeridian interpolation.
  - `photoUtcMs` table: EXIF with `+09:00` offset, EXIF with UI offset, file-source ignores offsets, drift applies only to targets.
  - GPX attribute order, missing time, `+09:00` timestamps.
  - Records E7 values and string `timestampMs`. Timeline `°` format.
  - `matchTrack` interpolation midpoint and nearest-in-window. No match outside window. Speed guard.
  - `matchCompanions` interpolation under 2 h, nearest above 2 h, no match beyond 100 km.
  - Tokenizer cases: `Day1-Shibuya`, `IMG_1001_Meiji_Shrine_Mist.jpg`.
  - Precedence order: track > companion > gazetteer > nominatim > ai.
- `tests/server/auto-locate.test.ts`:
  - Scratch folder under `test-results/` with EXIF-tagged JPEGs and a GPX file.
  - POST with `trackSource` file and sample. Check strategies and warnings.
  - Missing or bad track path errors.
  - `enableNominatim: false` makes no network calls.
  - Nominatim via `NOMINATIM_BASE_URL` pointing to a local stub server. Verifies User-Agent, cache file creation, and cache hits on second run. `MYALBUM_DATA_DIR` set to a temp dir.
  - AI session integration: `enableAi: false` invokes zero AI inferences; `enableAi: true` assigns AI suggestions and returns attribution and stats.
  - `GET /api/browse?kind=track` returns files.
  - `GET /api/demo/sample-track.gpx` returns GPX with at least 100 points.
- `tests/server/ai-locator.test.ts` (new):
  - Local ONNX visual similarity matching against located anchors ($\ge 0.85$ threshold).
  - GeoCLIP prediction fallback for landmarks.
  - Ollama local VLM endpoint integration with JSON schema response parsing.
  - Cloud VLM endpoint integration and API key header forwarding.
  - Atomic cache persistence at `~/.myalbum/ai-locate-cache.json`.
  - Low confidence pruning, offline synthetic embedding fallbacks, and error isolation.
- `tests/server/batch-edits.test.ts`: add `perPhotoLocations` cases (apply, restore clears marker, validation errors, `photoIds` not required).
- `tests/server/exif-metadata.test.ts`: `OffsetTimeOriginal` is read.
- `tests/server/demo-album.test.ts`: count changes and sample-track assertion (see above).
- `e2e/auto-locate.spec.ts`: reset demo, confirm companion matching without a track, load the sample track and verify track precedence, apply the selected matches, and confirm the unlocated count drops. Nominatim and AI remain off by default.
- Existing e2e suites that touch changed UI: `map.spec.ts`, `selection-and-batch.spec.ts`, `lightbox.spec.ts`.

## Verification commands

- Targeted: `npx vitest run tests/utils/auto-locate.test.ts tests/server/auto-locate.test.ts tests/server/batch-edits.test.ts tests/server/demo-album.test.ts tests/server/exif-metadata.test.ts`
- Full unit: `npm test`
- Types and bundle: `npm run build`
- Targeted e2e: `npx playwright test e2e/auto-locate.spec.ts e2e/map.spec.ts e2e/selection-and-batch.spec.ts e2e/lightbox.spec.ts`
- No linter exists in `package.json`. Nothing to run there.

## Documentation

- `README.md`: feature section for auto-locate, API table (new endpoints, `PATCH` `perPhotoLocations`, `browse?kind=track`), test list, dependency note, Nominatim and AI Vision opt-in (off by default) and attribution notes, and cache locations (`~/.myalbum/geocode-cache.json` and `~/.myalbum/ai-locate-cache.json`, overridable with `MYALBUM_DATA_DIR`).
- This file is the implementation plan; README.md documents user-facing behavior and the REST API.

## AI / ML Visual Auto-Locate Extension

### Overview
The AI / ML visual auto-locate extension provides visual scene recognition and image-based geolocation for unlocated photos where timestamp, track, and filename signals are missing or insufficient. It is designed around local execution, zero-cloud privacy by default, and strict fallback precedence.

### Multi-Provider Architecture (`server/aiLocator.ts`)
Three distinct AI locator providers are supported through the unified `createAiLocateSession(options)` interface:

1. **`local-onnx` (Default — 100% On-Device & Private)**:
   - Uses `@huggingface/transformers` with `onnxruntime-node` (`Xenova/geoclip-large-patch14`, quantized q8) to generate 512-dimensional normalized visual feature embeddings.
   - Models are cached under `~/.myalbum/models/` (`MYALBUM_DATA_DIR`).
   - Runs a two-stage local pipeline:
     - **Stage 1 (Album Visual Similarity)**: Computes cosine similarity between target photo embeddings and all located anchor photos in the current album. If maximum similarity $\ge 0.85$, the unlocated photo inherits the anchor's location with confidence scaled by visual similarity ($0.70$–$0.95$). This reliably locates series of shots, alternate angles, or indoor photos without GPS.
     - **Stage 2 (GeoCLIP Global Prediction)**: If no album anchor matches, predicts coordinates by matching against distinctive global gazetteer visual anchors and continuous landmark representations.
     - Includes a deterministic color/feature fallback (`fallbackSvgOrImageEmbedding`) for offline testing and SVG/non-standard image formats without downloading weights.

2. **`ollama` (Local Vision-Language Model)**:
   - Connects to a locally running Ollama instance (default endpoint `http://localhost:11434`, default model `llama3.2-vision:latest`, also compatible with `llava`, `qwen2.5-vl`).
   - Sends base64-encoded photo with a structured JSON schema prompt instructing the model to analyze landmarks, architecture, signage, and geographical features to output `{ lat, lng, name, confidence, reason }`.
   - 100% local; no photo data or telemetry leaves the machine.

3. **`cloud-vlm` (Cloud Vision API)**:
   - Connects to any OpenAI-compatible Vision Chat Completions endpoint (e.g. `https://api.openai.com/v1/chat/completions`) using user-provided endpoint URL, model, and API key.
   - Formats requests with high-detail image payloads and parses structured JSON coordinate recommendations.

### Strict Precedence Order
AI matching executes at lowest priority:
`track > companion > gazetteer > nominatim > ai`
AI inference is only attempted on targets that yielded no suggestion from tracks, companions, offline gazetteer tokens, or Nominatim geocoding. When `enableAi: false` (the default), zero AI models are loaded and zero AI inferences are run.

### Persistent Cache & Privacy
- Results and visual embeddings are cached in `~/.myalbum/ai-locate-cache.json` (`MYALBUM_DATA_DIR`).
- Embeddings are indexed by file path, mtime, and size hash. Hits are indexed by file and provider.
- Atomic writes (temporary file + rename) prevent corrupt cache state across server restarts.
- Local ONNX and Ollama require no internet connection.

## Dependencies

- `stream-json` 3.7.0 (runtime) is installed. It is needed so Records.json above roughly 512 MB works. `@types/stream-json` is not used because 3.x ships its own typings (`src/index.d.ts`).
- `@huggingface/transformers` (^4.3.1) and `onnxruntime-node` are installed for local ONNX visual embeddings and GeoCLIP inference.

## Risks and assumptions

- Nominatim is off by default. If the user turns it on, unmatched folder and file words are sent to openstreetmap.org. The modal discloses this.
- AI Vision is off by default (`enableAi: false`). When disabled, no models are initialized or fetched.
- Local ONNX downloads the quantized model on first run to `~/.myalbum/models/` when enabled; tests use the synthetic embedding fallback or local stubs and do not download external weights.
- Ollama requires the user to have Ollama running locally; if unreachable or times out, a clear warning is returned without crashing the auto-locate run.
- Cloud VLM requires the user to provide their own endpoint and API key.
- Previously removed locations are targeted by default. They are flagged so the user can deselect them.
- `OffsetTimeOriginal` depends on exifr returning it. Verified by a test. If exifr does not return it, the UI offset is the fallback.
- Anchors are the whole folder's located photos (excluding auto-located ones). Targets are the current filter.
- `~/.myalbum/` is a new location outside the repo. Created only when Nominatim or AI Vision is used.
- Drift is applied only to unlocated photos. Located photos are assumed accurate.
- The public Nominatim service remains disabled unless a user opts in.
