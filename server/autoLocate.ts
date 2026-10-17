import type {
  AutoLocateOptions,
  AutoLocateResponse,
  AutoLocateStrategy,
  PhotoItem,
} from '../src/types/photo.ts';
import {
  extractPlaceTokens,
  matchCompanions,
  matchGazetteer,
  matchTrack,
  nearestPlaceName,
  photoUtcMs,
  pickSuggestion,
  sortByUtc,
  type AnchorPoint,
  type PlaceCandidate,
  type TrackPoint,
} from '../src/utils/autoLocate.ts';
import { PLACE_GAZETTEER } from '../src/utils/placeGazetteer.ts';
import {
  NOMINATIM_ATTRIBUTION,
  type GeocodeSession,
} from './geocoder.ts';
import type { AiLocateSession } from './aiLocator.ts';

export interface AutoLocateTrack {
  points: readonly TrackPoint[];
  spanStartMs: number | null;
  spanEndMs: number | null;
}

function requestedUnlocatedPhotos(photos: readonly PhotoItem[], photoIds: readonly string[]): PhotoItem[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  return photoIds
    .map((photoId) => byId.get(photoId))
    .filter((photo): photo is PhotoItem => photo !== undefined && photo.location === null);
}

export function autoLocateTargetTimes(
  photos: readonly PhotoItem[],
  photoIds: readonly string[],
  options: AutoLocateOptions,
): number[] {
  return requestedUnlocatedPhotos(photos, photoIds)
    .map((photo) => photoUtcMs(photo, options, 'target'))
    .filter((utcMs): utcMs is number => utcMs !== null);
}

function candidateName(lat: number, lng: number): string {
  return nearestPlaceName(lat, lng, PLACE_GAZETTEER) ?? `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
}

function hasCandidate(candidates: readonly PlaceCandidate[] | undefined): boolean {
  return pickSuggestion(candidates ?? []) !== null;
}

function addCandidate(
  candidatesByPhoto: Map<string, PlaceCandidate[]>,
  photoId: string,
  candidate: PlaceCandidate,
): void {
  const candidates = candidatesByPhoto.get(photoId) ?? [];
  candidates.push(candidate);
  candidatesByPhoto.set(photoId, candidates);
}

function locationCandidate(
  strategy: AutoLocateStrategy,
  lat: number,
  lng: number,
  name: string,
  confidence: number,
  reason: string,
): PlaceCandidate {
  return { strategy, lat, lng, name, confidence, reason };
}

export async function autoLocatePhotos(
  photos: readonly PhotoItem[],
  photoIds: readonly string[],
  options: AutoLocateOptions,
  track: AutoLocateTrack | null,
  geocoder?: GeocodeSession,
  aiSession?: AiLocateSession,
): Promise<AutoLocateResponse> {
  const targets = requestedUnlocatedPhotos(photos, photoIds);
  const windowMs = options.windowMinutes * 60_000;
  const candidatesByPhoto = new Map<string, PlaceCandidate[]>();
  const targetTimes = new Map(
    targets.map((photo) => [photo.id, photoUtcMs(photo, options, 'target')]),
  );
  const anchors: AnchorPoint[] = [];

  for (const photo of photos) {
    if (!photo.location || photo.isAutoLocated) continue;
    if (
      !Number.isFinite(photo.location.lat) ||
      !Number.isFinite(photo.location.lng) ||
      Math.abs(photo.location.lat) > 90 ||
      Math.abs(photo.location.lng) > 180
    ) {
      continue;
    }
    const utcMs = photoUtcMs(photo, options, 'anchor');
    if (utcMs !== null) {
      anchors.push({ utcMs, lat: photo.location.lat, lng: photo.location.lng });
    }
  }
  sortByUtc(anchors);

  const sortedTrackPoints = track ? sortByUtc([...track.points]) : [];
  const warnings: string[] = [];

  if (track && targets.length > 0) {
    const spanStartMs = track.spanStartMs ?? sortedTrackPoints[0]?.utcMs ?? null;
    const spanEndMs = track.spanEndMs ?? sortedTrackPoints.at(-1)?.utcMs ?? null;
    const anyTargetInSpan =
      spanStartMs !== null &&
      spanEndMs !== null &&
      targets.some((photo) => {
        const utcMs = targetTimes.get(photo.id);
        return utcMs !== null && utcMs !== undefined &&
          utcMs >= spanStartMs - windowMs &&
          utcMs <= spanEndMs + windowMs;
      });
    if (spanStartMs === null || spanEndMs === null) {
      warnings.push('The selected track contains no usable time-stamped locations.');
    } else if (!anyTargetInSpan) {
      warnings.push('No target photo times overlap the selected track. Check the UTC offset or camera clock drift.');
    }
  }

  if (track) {
    for (const photo of targets) {
      const utcMs = targetTimes.get(photo.id);
      if (utcMs === null || utcMs === undefined) continue;
      const match = matchTrack(sortedTrackPoints, utcMs, windowMs);
      if (!match) continue;
      addCandidate(
        candidatesByPhoto,
        photo.id,
        locationCandidate('track', match.lat, match.lng, candidateName(match.lat, match.lng), match.confidence, match.reason),
      );
    }
  }

  if (options.enableCompanion) {
    for (const photo of targets) {
      if (hasCandidate(candidatesByPhoto.get(photo.id))) continue;
      const utcMs = targetTimes.get(photo.id);
      if (utcMs === null || utcMs === undefined) continue;
      const match = matchCompanions(anchors, utcMs, windowMs);
      if (!match) continue;
      addCandidate(
        candidatesByPhoto,
        photo.id,
        locationCandidate(
          'companion',
          match.lat,
          match.lng,
          candidateName(match.lat, match.lng),
          match.confidence,
          match.reason,
        ),
      );
    }
  }

  const placeTokens = new Map<string, string[]>();
  if (options.enableGazetteer) {
    for (const photo of targets) {
      if (hasCandidate(candidatesByPhoto.get(photo.id))) continue;
      const tokens = extractPlaceTokens(photo.subfolder, photo.fileName);
      placeTokens.set(photo.id, tokens);
      const match = matchGazetteer(tokens, PLACE_GAZETTEER);
      if (!match) continue;
      addCandidate(
        candidatesByPhoto,
        photo.id,
        locationCandidate(
          'gazetteer',
          match.entry.lat,
          match.entry.lng,
          match.entry.name,
          match.confidence,
          match.reason,
        ),
      );
    }
  }

  if (options.enableNominatim) {
    if (!geocoder) {
      throw new Error('Nominatim is enabled but no geocoder session is available');
    }
    for (const photo of targets) {
      if (hasCandidate(candidatesByPhoto.get(photo.id))) continue;
      const tokens = placeTokens.get(photo.id) ?? extractPlaceTokens(photo.subfolder, photo.fileName);
      for (const token of tokens) {
        const hit = await geocoder.lookup(token);
        if (hit) {
          addCandidate(
            candidatesByPhoto,
            photo.id,
            locationCandidate(
              'nominatim',
              hit.lat,
              hit.lng,
              hit.name,
              hit.confidence,
              hit.displayName ? `OpenStreetMap match: ${hit.displayName}` : `OpenStreetMap match: ${hit.name}`,
            ),
          );
          break;
        }
        if (geocoder.halted) break;
      }
    }
    warnings.push(...geocoder.warnings);
  }

  if (options.enableAi) {
    if (!aiSession) {
      throw new Error('AI locate is enabled but no AI locate session is available');
    }
    for (const photo of targets) {
      if (hasCandidate(candidatesByPhoto.get(photo.id))) continue;
      const hit = await aiSession.locate(photo);
      if (hit) {
        addCandidate(
          candidatesByPhoto,
          photo.id,
          locationCandidate(
            'ai',
            hit.lat,
            hit.lng,
            hit.name,
            hit.confidence,
            hit.reason,
          ),
        );
      }
      if (aiSession.halted) break;
    }
    warnings.push(...aiSession.warnings);
  }

  const strategies: AutoLocateStrategy[] = ['track', 'companion', 'gazetteer', 'nominatim', 'ai'];
  const byStrategy: Partial<Record<AutoLocateStrategy, number>> = Object.fromEntries(
    strategies.map((strategy) => [strategy, 0]),
  );
  const suggestions: AutoLocateResponse['suggestions'] = [];
  const unmatchedPhotoIds: string[] = [];

  for (const photo of targets) {
    const candidate = pickSuggestion(candidatesByPhoto.get(photo.id) ?? []);
    if (!candidate) {
      unmatchedPhotoIds.push(photo.id);
      continue;
    }
    byStrategy[candidate.strategy] = (byStrategy[candidate.strategy] ?? 0) + 1;
    const utcMs = targetTimes.get(photo.id);
    suggestions.push({
      photoId: photo.id,
      location: { lat: candidate.lat, lng: candidate.lng, name: candidate.name },
      strategy: candidate.strategy,
      confidence: candidate.confidence,
      reason: candidate.reason,
      utcIso: utcMs === null || utcMs === undefined ? null : new Date(utcMs).toISOString(),
      previouslyRemoved: photo.isLocationEdited === true && photo.location === null,
    });
  }

  const hasNominatimSuggestion = suggestions.some((suggestion) => suggestion.strategy === 'nominatim');
  const hasAiSuggestion = suggestions.some((suggestion) => suggestion.strategy === 'ai');
  const attributions: string[] = [];
  if (hasNominatimSuggestion) {
    attributions.push(NOMINATIM_ATTRIBUTION);
  }
  if (hasAiSuggestion && aiSession?.attribution) {
    attributions.push(aiSession.attribution);
  }
  const attribution = attributions.length > 0 ? attributions.join(' | ') : null;

  return {
    suggestions,
    unmatchedPhotoIds,
    warnings,
    attribution,
    stats: {
      targets: targets.length,
      matched: suggestions.length,
      byStrategy,
      trackPoints: sortedTrackPoints.length,
      geocodeLookups: geocoder?.lookupCount ?? 0,
      aiInferences: aiSession?.inferenceCount ?? 0,
    },
  };
}
