import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { planVideoShots } from '../../src/application/services/scene-planner.js';
import { SceneCache, stableAssetHash } from '../../src/infra/storage/scene-cache.js';
import { ShotCompositor } from '../../src/infra/media/shot-compositor.js';
import { OpenRouterSceneProvider } from '../../src/infra/media/openrouter-scene-provider.js';
import { VideoScriptSchema, ensureScriptSegments } from '../../src/domain/schemas/script.schema.js';
import { StoryboardSceneSchema } from '../../src/domain/schemas/video.schema.js';

describe('ScenePlanner, SceneCache, ShotCompositor & SSRF Guard (Fase 6 / Sprint F)', () => {
  it('planeja cortes de 6-10s nos limites da fala respeitando MAX_GENERATED_IMAGES_PER_VIDEO e diversificando cameraMove/ShotKind', () => {
    const rawScript = VideoScriptSchema.parse({
      title: 'Capítulo 1: O Observatório',
      durationMinutes: 1,
      hook: 'No alto da montanha, a cúpula de bronze guarda segredos seculares.',
      beats: ['A subida na neblina', 'O mecanismo celeste', 'A carta do astrônomo'],
      narration:
        'No alto da montanha, a cúpula de bronze guarda segredos seculares. Os pesquisadores sobem pela trilha estreita enquanto a neblina encobre o vale profundo.\n\nDentro do observatório, engrenagens de latão giram lentamente alinhando a luneta principal com a constelação austral. Cada anotação no caderno revela uma medição feita há cem anos.\n\nPor fim, a gaveta secreta se abre e entrega a carta original do astrônomo, mudando tudo o que sabiam sobre aquela noite.',
      bRollAndVisuals: [
        'Cúpula de bronze no topo de montanha sob neblina',
        'Engrenagens de latão de telescópio antigo',
        'Carta antiga com selo de cera sobre mesa astronômica',
      ],
      sourcePages: [1, 2, 3],
    });
    const script = ensureScriptSegments(rawScript, [1, 2, 3]);

    const timedSegments = [
      {
        segmentId: 'seg_0001',
        text: script.segments[0]!.text,
        startSeconds: 0,
        endSeconds: 18,
      },
      {
        segmentId: 'seg_0002',
        text: script.segments[1]!.text,
        startSeconds: 18,
        endSeconds: 38,
      },
      {
        segmentId: 'seg_0003',
        text: script.segments[2]!.text,
        startSeconds: 38,
        endSeconds: 56,
      },
    ];

    const plan = planVideoShots(script, timedSegments, {
      targetShotSeconds: 7,
      aiImageMinIntervalSeconds: 16,
      maxGeneratedImagesPerVideo: 2,
      visualMode: 'dynamic',
    });

    // 56s de vídeo com ~7s por shot deve gerar mais cortes que os 3 parágrafos originais
    expect(plan.shots.length).toBeGreaterThanOrEqual(6);
    // Somente até 2 shots marcados como generatedByAi=true (respeitando maxGeneratedImagesPerVideo=2)
    const aiGeneratedCount = plan.shots.filter((s) => s.generatedByAi).length;
    expect(aiGeneratedCount).toBeLessThanOrEqual(2);
    expect(aiGeneratedCount).toBeGreaterThanOrEqual(1);

    // Continuidade: início do primeiro = 0, fim do último = 56, monotônico
    expect(plan.shots[0]?.startSeconds).toBe(0);
    expect(plan.shots.at(-1)?.endSeconds).toBeCloseTo(56, 2);
    for (let i = 0; i < plan.shots.length; i++) {
      const s = plan.shots[i]!;
      expect(s.endSeconds).toBeGreaterThan(s.startSeconds);
      if (i > 0) {
        expect(s.startSeconds).toBeCloseTo(plan.shots[i - 1]!.endSeconds, 3);
      }
    }
  });

  it('calcula stableAssetHash recursivo canônico sem perder propriedades aninhadas e reutiliza SceneCache', async () => {
    const h1 = stableAssetHash({
      b: 1,
      a: { y: 'dois', x: 'um' },
    });
    const h2 = stableAssetHash({
      a: { x: 'um', y: 'dois' },
      b: 1,
    });
    const h3 = stableAssetHash({
      a: { x: 'ALTERADO', y: 'dois' },
      b: 1,
    });

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);

    const dir = await mkdtemp(join(tmpdir(), 'doctocine-scenecache-'));
    try {
      const cache = new SceneCache(dir);
      const samplePng = await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 10, g: 30, b: 60 } },
      })
        .png()
        .toBuffer();

      await cache.put(h1, samplePng, {
        model: 'google/gemini-3.1-flash-lite-image',
        width: 320,
        height: 180,
      });

      const hit = await cache.get(h1);
      expect(hit).toBeDefined();
      expect(hit?.metadata.model).toBe('google/gemini-3.1-flash-lite-image');

      const outVariant = join(dir, 'shot_variant.png');
      const compositor = new ShotCompositor(320, 180);
      await compositor.composeShot(
        {
          shotId: 'shot_001',
          sourceSegmentIds: ['seg_0001'],
          startSeconds: 0,
          endSeconds: 6,
          visualPrompt: 'Observatório na neblina',
          onScreenText: 'O Observatório',
          kind: 'establishing',
          cameraMove: 'pan-right',
          generatedByAi: false,
          variantIndex: 0,
          sourcePages: [1],
        },
        outVariant,
        samplePng,
        1,
      );

      const st = await stat(outVariant);
      expect(st.size).toBeGreaterThan(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bloqueia URLs remotas inseguras (SSRF / HTTP / localhost) no OpenRouterSceneProvider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-ssrf-'));
    try {
      let secondaryUrlCalled = false;
      const ssrfFetch: typeof fetch = async (input) => {
        const u = String(input);
        if (u.includes('/chat/completions')) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    images: [{ image_url: { url: 'http://169.254.169.254/latest/meta-data/' } }],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        secondaryUrlCalled = true;
        return new Response('secret', { status: 200 });
      };

      const provider = new OpenRouterSceneProvider({
        apiKey: 'sk-or-v1-test1234567890abcdef',
        width: 320,
        height: 180,
        fetchImpl: ssrfFetch,
      });

      const scene = StoryboardSceneSchema.parse({
        sceneId: 'scene_001',
        segmentIds: ['seg_0001'],
        visualPrompt: 'Teste SSRF',
        onScreenText: 'Segurança',
        durationSeconds: 5,
      });

      const res = await provider.createWithProvenance(scene, join(dir, 'scene.png'));
      expect(secondaryUrlCalled).toBe(false);
      expect(res.provenance).toBe('sharp-fallback');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
