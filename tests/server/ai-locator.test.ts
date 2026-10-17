import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  createAiLocateSession,
  DEFAULT_SIMILARITY_THRESHOLD,
  EMBEDDING_DIM,
} from '../../server/aiLocator.ts';
import type { PhotoItem } from '../../src/types/photo.ts';

const SCRATCH_ROOT = fileURLToPath(new URL('../../test-results/', import.meta.url));

function makePhoto(partial: Partial<PhotoItem> & { id: string; fileName: string; fullPath: string }): PhotoItem {
  return {
    relativePath: partial.fileName,
    subfolder: '',
    url: `/photos/${partial.fileName}`,
    fileSize: 1024,
    timestamp: '2025-05-01T12:00:00.000Z',
    originalTimestamp: '2025-05-01T12:00:00.000Z',
    location: null,
    originalLocation: null,
    exif: {},
    ...partial,
  };
}

describe('aiLocator', () => {
  let scratchDir: string;
  let sampleJpegPath: string;

  beforeAll(async () => {
    await fs.mkdir(SCRATCH_ROOT, { recursive: true });
    scratchDir = await fs.mkdtemp(path.join(SCRATCH_ROOT, 'ai-locator-test-'));

    // Create a dummy JPEG image for sharp operations
    sampleJpegPath = path.join(scratchDir, 'sample.jpg');
    await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer()
      .then((buf) => fs.writeFile(sampleJpegPath, buf));
  });

  afterAll(async () => {
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true });
    }
  });

  describe('cosineSimilarity', () => {
    it('calculates cosine similarity correctly', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, 0, 0]);
      const c = new Float32Array([0, 1, 0]);
      const d = new Float32Array([-1, 0, 0]);

      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
      expect(cosineSimilarity(a, c)).toBeCloseTo(0.0);
      expect(cosineSimilarity(a, d)).toBeCloseTo(-1.0);
      expect(cosineSimilarity(a, new Float32Array([1, 0]))).toBe(0);
    });
  });

  describe('local-onnx (visual similarity & fallback)', () => {
    it('matches target photo to anchor photo when visual embeddings have high similarity', async () => {
      const anchorPhoto = makePhoto({
        id: 'anchor-1',
        fileName: 'tokyo-tower.jpg',
        fullPath: sampleJpegPath,
        subfolder: 'Tokyo',
        timestamp: '2025-05-01T12:00:00.000Z',
        location: { lat: 35.6586, lng: 139.7454, name: 'Tokyo Tower, Tokyo' },
      });

      const targetPhoto = makePhoto({
        id: 'target-1',
        fileName: 'mystery.jpg',
        fullPath: sampleJpegPath,
        timestamp: '2025-05-01T12:05:00.000Z',
      });

      // Mock embeddings: normalized vectors with cosine similarity > 0.85
      const mockVecAnchor = new Float32Array(EMBEDDING_DIM);
      mockVecAnchor[0] = 1.0;

      const mockVecTarget = new Float32Array(EMBEDDING_DIM);
      mockVecTarget[0] = 0.95;
      mockVecTarget[1] = Math.sqrt(1 - 0.95 * 0.95);

      const cacheFile = path.join(scratchDir, 'test-cache-1.json');
      const session = createAiLocateSession([anchorPhoto, targetPhoto], {
        provider: 'local-onnx',
        cachePath: cacheFile,
        embeddingRunner: async (filePath) => {
          if (filePath.includes('tokyo')) return mockVecAnchor;
          return mockVecTarget;
        },
      });

      const hit = await session.locate(targetPhoto);
      expect(hit).not.toBeNull();
      expect(hit?.lat).toBeCloseTo(35.6586);
      expect(hit?.lng).toBeCloseTo(139.7454);
      expect(hit?.name).toBe('Tokyo Tower, Tokyo');
      expect(hit?.provider).toBe('local-onnx');
      expect(hit?.confidence).toBeGreaterThanOrEqual(0.65);
      expect(hit?.reason).toContain('AI visual similarity match');
      expect(session.inferenceCount).toBe(1);

      // Verify hit was persisted in cache file
      const cacheRaw = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      expect(Object.keys(cacheRaw.hits)).toHaveLength(1);

      // Second session with same cache should return cached hit without re-running embeddingRunner
      let calledRunner = false;
      const cachedSession = createAiLocateSession([anchorPhoto, targetPhoto], {
        provider: 'local-onnx',
        cachePath: cacheFile,
        embeddingRunner: async () => {
          calledRunner = true;
          return mockVecTarget;
        },
      });
      const cachedHit = await cachedSession.locate(targetPhoto);
      expect(cachedHit).toEqual(hit);
      expect(calledRunner).toBe(false);
    });
  });

  describe('ollama provider', () => {
    it('queries Ollama endpoint and parses structured location response', async () => {
      const targetPhoto = makePhoto({
        id: 'target-ollama',
        fileName: 'unknown.jpg',
        fullPath: sampleJpegPath,
      });

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain('/api/chat');
        const body = JSON.parse(init?.body as string);
        expect(body.model).toBe('qwen2.5-vl:latest');
        expect(body.format).toBe('json');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              content: JSON.stringify({
                lat: 48.8584,
                lng: 2.2945,
                name: 'Eiffel Tower, Paris',
                confidence: 0.88,
                reason: 'Eiffel Tower is clearly visible in the center',
              }),
            },
          }),
        } as Response;
      };

      const cacheFile = path.join(scratchDir, 'test-cache-ollama.json');
      const session = createAiLocateSession([targetPhoto], {
        provider: 'ollama',
        cachePath: cacheFile,
        fetch: mockFetch as any,
      });

      const hit = await session.locate(targetPhoto);
      expect(hit).not.toBeNull();
      expect(hit?.lat).toBeCloseTo(48.8584);
      expect(hit?.lng).toBeCloseTo(2.2945);
      expect(hit?.name).toBe('Eiffel Tower, Paris');
      expect(hit?.provider).toBe('ollama');
      expect(hit?.confidence).toBe(0.88);
      expect(hit?.reason).toContain('Eiffel Tower is clearly visible');
    });

    it('halts and warns gracefully when Ollama cannot be reached', async () => {
      const targetPhoto = makePhoto({
        id: 'target-ollama-err',
        fileName: 'unknown2.jpg',
        fullPath: sampleJpegPath,
      });

      const mockFetch = async () => {
        throw new Error('Connection refused');
      };

      const cacheFile = path.join(scratchDir, 'test-cache-ollama-err.json');
      const session = createAiLocateSession([targetPhoto], {
        provider: 'ollama',
        cachePath: cacheFile,
        fetch: mockFetch as any,
      });

      const hit = await session.locate(targetPhoto);
      expect(hit).toBeNull();
      expect(session.halted).toBe(true);
      expect(session.warnings).toHaveLength(1);
      expect(session.warnings[0]).toContain('Could not reach Ollama');
    });
  });

  describe('cloud-vlm provider', () => {
    it('warns and halts if API key is missing', async () => {
      const targetPhoto = makePhoto({
        id: 'target-cloud-no-key',
        fileName: 'unknown3.jpg',
        fullPath: sampleJpegPath,
      });

      const session = createAiLocateSession([targetPhoto], {
        provider: 'cloud-vlm',
        apiKey: '',
      });

      const hit = await session.locate(targetPhoto);
      expect(hit).toBeNull();
      expect(session.halted).toBe(true);
      expect(session.warnings[0]).toContain('requires an API key');
    });

    it('queries Cloud VLM endpoint with Bearer auth and parses response', async () => {
      const targetPhoto = makePhoto({
        id: 'target-cloud',
        fileName: 'unknown4.jpg',
        fullPath: sampleJpegPath,
      });

      let authHeader = '';
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        authHeader = (init?.headers as any)?.Authorization ?? '';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    lat: 40.7128,
                    lng: -74.006,
                    name: 'New York, NY, USA',
                    confidence: 0.91,
                    reason: 'Manhattan skyline',
                  }),
                },
              },
            ],
          }),
        } as Response;
      };

      const cacheFile = path.join(scratchDir, 'test-cache-cloud.json');
      const session = createAiLocateSession([targetPhoto], {
        provider: 'cloud-vlm',
        apiKey: 'test-secret-key-123',
        cachePath: cacheFile,
        fetch: mockFetch as any,
      });

      const hit = await session.locate(targetPhoto);
      expect(authHeader).toBe('Bearer test-secret-key-123');
      expect(hit).not.toBeNull();
      expect(hit?.lat).toBeCloseTo(40.7128);
      expect(hit?.lng).toBeCloseTo(-74.006);
      expect(hit?.provider).toBe('cloud-vlm');
      expect(hit?.name).toBe('New York, NY, USA');
    });
  });
});
