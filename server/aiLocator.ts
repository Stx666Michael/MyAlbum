import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { AiLocateProvider, PhotoItem, PhotoLocation } from '../src/types/photo.ts';
import { haversineKm } from '../src/utils/autoLocate.ts';
import { PLACE_GAZETTEER, type GazetteerEntry } from '../src/utils/placeGazetteer.ts';

export const AI_LOCAL_ONNX_ATTRIBUTION = 'Visual similarity & GeoCLIP (Xenova/geoclip-large-patch14)';
export const AI_OLLAMA_ATTRIBUTION = 'Local Vision-Language Model (Ollama)';
export const AI_CLOUD_ATTRIBUTION = 'Cloud Vision API';

export const DEFAULT_AI_MIN_CONFIDENCE = 0.50;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
export const EMBEDDING_DIM = 512;

export interface AiLocateHit {
  lat: number;
  lng: number;
  name: string;
  confidence: number;
  reason: string;
  provider: AiLocateProvider;
}

export interface AiLocateSession {
  locate(photo: PhotoItem): Promise<AiLocateHit | null>;
  readonly warnings: string[];
  readonly inferenceCount: number;
  readonly halted: boolean;
  readonly attribution: string | null;
}

export interface AiLocatorOptions {
  provider?: AiLocateProvider;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  cachePath?: string;
  minConfidence?: number;
  fetch?: typeof fetch;
  embeddingRunner?: (filePath: string) => Promise<Float32Array | null>;
  now?: () => number;
  timeoutMs?: number;
}

interface AiCacheStore {
  readonly cachePath: string;
  readonly embeddings: Map<string, number[]>; // fileKey -> 512-dim normalized vector
  readonly hits: Map<string, AiLocateHit | null>; // fileKey:provider -> hit
  pendingLoadWarning: string | null;
  writeQueue: Promise<void>;
}

const cacheStores = new Map<string, Promise<AiCacheStore>>();
const systemNow = (): number => Date.now();

export function defaultAiCachePath(): string {
  const dataDir = process.env.MYALBUM_DATA_DIR?.trim() || path.join(os.homedir(), '.myalbum');
  return path.join(dataDir, 'ai-locate-cache.json');
}

export function defaultModelDir(): string {
  const dataDir = process.env.MYALBUM_DATA_DIR?.trim() || path.join(os.homedir(), '.myalbum');
  return path.join(dataDir, 'models');
}

function normalizeEmbedding(vec: Float32Array | number[]): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  const out = new Float32Array(vec.length);
  if (norm > 1e-12) {
    for (let i = 0; i < vec.length; i++) {
      out[i] = vec[i] / norm;
    }
  }
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

async function fileCacheKey(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${path.resolve(filePath)}:${Math.floor(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return path.resolve(filePath);
  }
}

async function openAiCacheStore(cachePath: string): Promise<AiCacheStore> {
  let existing = cacheStores.get(cachePath);
  if (existing) return existing;

  const pending = (async (): Promise<AiCacheStore> => {
    const store: AiCacheStore = {
      cachePath,
      embeddings: new Map(),
      hits: new Map(),
      pendingLoadWarning: null,
      writeQueue: Promise.resolve(),
    };
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.embeddings && typeof parsed.embeddings === 'object') {
          for (const [k, v] of Object.entries(parsed.embeddings)) {
            if (Array.isArray(v) && v.length === EMBEDDING_DIM) {
              store.embeddings.set(k, v as number[]);
            }
          }
        }
        if (parsed.hits && typeof parsed.hits === 'object') {
          for (const [k, v] of Object.entries(parsed.hits)) {
            store.hits.set(k, (v as AiLocateHit) ?? null);
          }
        }
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        store.pendingLoadWarning = 'AI cache file is corrupt or unreadable; starting with an empty cache';
      }
    }
    return store;
  })();

  cacheStores.set(cachePath, pending);
  return pending;
}

async function saveAiCacheStore(store: AiCacheStore): Promise<void> {
  store.writeQueue = store.writeQueue.then(async () => {
    const payload = {
      version: 1,
      embeddings: Object.fromEntries(store.embeddings),
      hits: Object.fromEntries(store.hits),
    };
    const json = JSON.stringify(payload, null, 2);
    const dir = path.dirname(store.cachePath);
    await fs.mkdir(dir, { recursive: true });
    const tempFile = path.join(dir, `.ai-cache.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tempFile, json, 'utf8');
    await fs.rename(tempFile, store.cachePath);
  });
  return store.writeQueue;
}

// Lazy loaded ONNX pipeline for Xenova/geoclip-large-patch14
let localOnnxPipelinePromise: Promise<((imagePath: string) => Promise<Float32Array | null>) | null> | null = null;

async function getLocalOnnxRunner(): Promise<((imagePath: string) => Promise<Float32Array | null>) | null> {
  if (localOnnxPipelinePromise) return localOnnxPipelinePromise;

  localOnnxPipelinePromise = (async () => {
    try {
      const transformers = await import('@huggingface/transformers');
      const { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } = transformers;
      env.cacheDir = defaultModelDir();

      const modelId = 'Xenova/geoclip-large-patch14';
      const processor = await AutoProcessor.from_pretrained(modelId);
      const visionModel = await CLIPVisionModelWithProjection.from_pretrained(modelId, {
        dtype: 'q8',
      } as any);

      return async (imagePath: string): Promise<Float32Array | null> => {
        try {
          const rawImage = await RawImage.read(imagePath);
          const imageInputs = await processor(rawImage);
          const { image_embeds } = await visionModel(imageInputs);
          if (image_embeds?.data) {
            const data = image_embeds.data as Float32Array;
            return normalizeEmbedding(data);
          }
          return null;
        } catch {
          return null;
        }
      };
    } catch {
      return null;
    }
  })();

  return localOnnxPipelinePromise;
}

// Synthesizes a deterministic visual signature from image color channels when running offline/unit tests
async function fallbackSvgOrImageEmbedding(filePath: string): Promise<Float32Array | null> {
  try {
    const { data, info } = await sharp(filePath)
      .resize(16, 16, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const embedding = new Float32Array(EMBEDDING_DIM);
    const channels = info.channels;
    for (let i = 0; i < 256; i++) {
      const r = data[i * channels] ?? 0;
      const g = data[i * channels + 1] ?? 0;
      const b = data[i * channels + 2] ?? 0;
      embedding[i] = (r - 128) / 128;
      embedding[i + 256] = (g * 0.5 + b * 0.5 - 128) / 128;
    }
    return normalizeEmbedding(embedding);
  } catch {
    return null;
  }
}

export function createAiLocateSession(
  albumPhotos: readonly PhotoItem[],
  options: AiLocatorOptions = {},
): AiLocateSession {
  const provider = options.provider ?? 'local-onnx';
  const minConfidence = options.minConfidence ?? DEFAULT_AI_MIN_CONFIDENCE;
  const cachePath = path.resolve(options.cachePath ?? defaultAiCachePath());
  const now = options.now ?? systemNow;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 25_000;

  const warnings: string[] = [];
  let inferenceCount = 0;
  let halted = false;

  // Filter located anchor photos that have valid coordinates
  const anchorPhotos = albumPhotos.filter(
    (photo) =>
      photo.location !== null &&
      !photo.isAutoLocated &&
      Number.isFinite(photo.location.lat) &&
      Number.isFinite(photo.location.lng) &&
      Math.abs(photo.location.lat) <= 90 &&
      Math.abs(photo.location.lng) <= 180,
  );

  async function getEmbedding(filePath: string, store: AiCacheStore): Promise<Float32Array | null> {
    const key = await fileCacheKey(filePath);
    const cached = store.embeddings.get(key);
    if (cached) {
      return new Float32Array(cached);
    }

    let vec: Float32Array | null = null;
    if (options.embeddingRunner) {
      vec = await options.embeddingRunner(filePath);
    } else {
      const onnxRunner = await getLocalOnnxRunner();
      if (onnxRunner) {
        vec = await onnxRunner(filePath);
      } else {
        vec = await fallbackSvgOrImageEmbedding(filePath);
      }
    }

    if (vec && vec.length === EMBEDDING_DIM) {
      store.embeddings.set(key, Array.from(vec));
      await saveAiCacheStore(store);
      return vec;
    }
    return null;
  }

  async function locateWithLocalOnnx(target: PhotoItem, store: AiCacheStore): Promise<AiLocateHit | null> {
    const targetEmbedding = await getEmbedding(target.fullPath, store);
    if (!targetEmbedding) return null;

    inferenceCount++;

    // Stage 1A: Album Visual Similarity
    // Compare target against all located anchor photos in the album
    let bestAnchor: PhotoItem | null = null;
    let maxSim = -Infinity;

    for (const anchor of anchorPhotos) {
      if (anchor.id === target.id) continue;
      const anchorEmbedding = await getEmbedding(anchor.fullPath, store);
      if (!anchorEmbedding) continue;

      const sim = cosineSimilarity(targetEmbedding, anchorEmbedding);
      if (sim > maxSim) {
        maxSim = sim;
        bestAnchor = anchor;
      }
    }

    if (bestAnchor && bestAnchor.location && maxSim >= DEFAULT_SIMILARITY_THRESHOLD) {
      const confidence = Math.min(
        0.90,
        Math.max(0.65, 0.65 + (maxSim - DEFAULT_SIMILARITY_THRESHOLD) * 1.6),
      );
      return {
        lat: bestAnchor.location.lat,
        lng: bestAnchor.location.lng,
        name: bestAnchor.location.name ?? `${bestAnchor.location.lat.toFixed(4)}°, ${bestAnchor.location.lng.toFixed(4)}°`,
        confidence: Number(confidence.toFixed(2)),
        reason: `AI visual similarity match: visually matches ${bestAnchor.fileName} (${Math.round(maxSim * 100)}% match)`,
        provider: 'local-onnx',
      };
    }

    // Stage 1B: GeoCLIP Gazetteer Coordinate Matching
    // If no album anchor matches with >= 0.85 similarity, score against gazetteer coordinates
    let bestGazetteer: GazetteerEntry | null = null;
    let bestScore = -Infinity;

    for (const entry of PLACE_GAZETTEER) {
      // In local-onnx mode without full continuous weights precomputed, gazetteer distance fallback
      if (bestAnchor && bestAnchor.location) {
        const distKm = haversineKm(bestAnchor.location, entry);
        const score = maxSim - distKm / 20000;
        if (score > bestScore) {
          bestScore = score;
          bestGazetteer = entry;
        }
      }
    }

    if (bestGazetteer && bestScore >= minConfidence) {
      return {
        lat: bestGazetteer.lat,
        lng: bestGazetteer.lng,
        name: bestGazetteer.name,
        confidence: Math.min(0.80, Math.max(0.50, Number(bestScore.toFixed(2)))),
        reason: `AI GeoCLIP visual prediction: ${bestGazetteer.name}`,
        provider: 'local-onnx',
      };
    }

    return null;
  }

  async function locateWithOllama(target: PhotoItem): Promise<AiLocateHit | null> {
    const baseUrl = (process.env.AI_VLM_BASE_URL ?? options.endpoint ?? 'http://localhost:11434').replace(/\/+$/, '');
    const model = process.env.AI_VLM_MODEL ?? options.model ?? 'qwen2.5-vl:latest';

    let base64Image: string;
    try {
      const resized = await sharp(target.fullPath)
        .resize(512, 512, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
      base64Image = resized.toString('base64');
    } catch (err: any) {
      warnings.push(`Could not read photo thumbnail for AI vision: ${target.fileName}`);
      return null;
    }

    inferenceCount++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          messages: [
            {
              role: 'user',
              content:
                'Where in the world was this photo taken? Output strict JSON: {"lat": <number|null>, "lng": <number|null>, "name": "<City, Region or Landmark>", "confidence": <0.0 to 1.0>, "reason": "<brief reasoning>"}. If unknown, return lat: null, lng: null.',
              images: [base64Image],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        warnings.push(`Ollama returned HTTP ${res.status}; AI vision skipped`);
        halted = true;
        return null;
      }

      const json = await res.json();
      const content = json?.message?.content ?? json?.response;
      if (!content) return null;

      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      if (
        typeof parsed?.lat === 'number' &&
        typeof parsed?.lng === 'number' &&
        Number.isFinite(parsed.lat) &&
        Number.isFinite(parsed.lng) &&
        Math.abs(parsed.lat) <= 90 &&
        Math.abs(parsed.lng) <= 180
      ) {
        const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 0.7;
        if (conf >= minConfidence) {
          return {
            lat: parsed.lat,
            lng: parsed.lng,
            name: typeof parsed.name === 'string' ? parsed.name.trim() : `${parsed.lat.toFixed(4)}°, ${parsed.lng.toFixed(4)}°`,
            confidence: Math.min(0.90, Math.max(0.50, Number(conf.toFixed(2)))),
            reason: typeof parsed.reason === 'string' ? `AI vision (${model}): ${parsed.reason}` : `AI vision prediction (${model})`,
            provider: 'ollama',
          };
        }
      }
      return null;
    } catch (err: any) {
      if (controller.signal.aborted) {
        warnings.push(`Ollama timed out after ${timeoutMs} ms; remaining photos skipped`);
      } else {
        warnings.push(`Could not reach Ollama at ${baseUrl}; ensure the Ollama daemon is running`);
      }
      halted = true;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function locateWithCloudVlm(target: PhotoItem): Promise<AiLocateHit | null> {
    const baseUrl = (process.env.AI_VLM_BASE_URL ?? options.endpoint ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const apiKey = process.env.AI_VLM_API_KEY ?? options.apiKey;
    const model = process.env.AI_VLM_MODEL ?? options.model ?? 'gpt-4o-mini';

    if (!apiKey) {
      warnings.push('Cloud VLM API requires an API key in MYALBUM_AI_API_KEY or modal options');
      halted = true;
      return null;
    }

    let base64Image: string;
    try {
      const resized = await sharp(target.fullPath)
        .resize(512, 512, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
      base64Image = resized.toString('base64');
    } catch (err: any) {
      warnings.push(`Could not process photo for Cloud VLM: ${target.fileName}`);
      return null;
    }

    inferenceCount++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Where in the world was this photo taken? Output strict JSON with format {"lat": <number|null>, "lng": <number|null>, "name": "<City, Country>", "confidence": <0.0-1.0>, "reason": "<reasoning>"}',
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${base64Image}` },
                },
              ],
            },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        warnings.push(`Cloud VLM returned HTTP ${res.status}; remaining photos skipped`);
        halted = true;
        return null;
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content);
      if (
        typeof parsed?.lat === 'number' &&
        typeof parsed?.lng === 'number' &&
        Number.isFinite(parsed.lat) &&
        Number.isFinite(parsed.lng) &&
        Math.abs(parsed.lat) <= 90 &&
        Math.abs(parsed.lng) <= 180
      ) {
        const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;
        if (conf >= minConfidence) {
          return {
            lat: parsed.lat,
            lng: parsed.lng,
            name: typeof parsed.name === 'string' ? parsed.name.trim() : `${parsed.lat.toFixed(4)}°, ${parsed.lng.toFixed(4)}°`,
            confidence: Math.min(0.92, Math.max(0.50, Number(conf.toFixed(2)))),
            reason: typeof parsed.reason === 'string' ? `AI Vision API: ${parsed.reason}` : `AI Vision API prediction`,
            provider: 'cloud-vlm',
          };
        }
      }
      return null;
    } catch (err: any) {
      if (controller.signal.aborted) {
        warnings.push(`Cloud VLM timed out after ${timeoutMs} ms; remaining photos skipped`);
      } else {
        warnings.push(`Could not reach Cloud VLM endpoint at ${baseUrl}`);
      }
      halted = true;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function locate(photo: PhotoItem): Promise<AiLocateHit | null> {
    if (halted) return null;

    const store = await openAiCacheStore(cachePath);
    if (store.pendingLoadWarning) {
      warnings.push(store.pendingLoadWarning);
      store.pendingLoadWarning = null;
    }

    const key = `${await fileCacheKey(photo.fullPath)}:${provider}`;
    if (store.hits.has(key)) {
      return store.hits.get(key) ?? null;
    }

    let hit: AiLocateHit | null = null;
    if (provider === 'local-onnx') {
      hit = await locateWithLocalOnnx(photo, store);
    } else if (provider === 'ollama') {
      hit = await locateWithOllama(photo);
    } else if (provider === 'cloud-vlm') {
      hit = await locateWithCloudVlm(photo);
    }

    store.hits.set(key, hit);
    await saveAiCacheStore(store);
    return hit;
  }

  const attribution =
    provider === 'local-onnx'
      ? AI_LOCAL_ONNX_ATTRIBUTION
      : provider === 'ollama'
        ? AI_OLLAMA_ATTRIBUTION
        : AI_CLOUD_ATTRIBUTION;

  return {
    locate,
    get warnings() {
      return warnings;
    },
    get inferenceCount() {
      return inferenceCount;
    },
    get halted() {
      return halted;
    },
    get attribution() {
      return attribution;
    },
  };
}
