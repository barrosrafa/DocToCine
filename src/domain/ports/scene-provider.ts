import type { StoryboardScene } from '../schemas/video.schema.js';

export interface SceneAssetProvider {
  create(scene: StoryboardScene, path: string, backgroundBuffer?: Buffer): Promise<string>;
}
