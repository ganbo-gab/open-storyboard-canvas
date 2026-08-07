import { describe, expect, it } from 'vitest';
import type { ProjectRecord } from '@/commands/projectState';
import { collectProjectMediaSources } from './projectMedia';

describe('project media inventory', () => {
  it('collects scoped Director Studio reference URLs and audio/video fields', () => {
    const record: ProjectRecord = {
      id: 'project',
      name: 'Media',
      createdAt: 1,
      updatedAt: 1,
      nodeCount: 1,
      nodesJson: JSON.stringify([{
        id: 'node',
        data: {
          referenceImages: [{ url: 'data:image/png;base64,AA==' }],
          documentation: { url: 'https://example.com/docs' },
          localVideoUrl: '/tmp/video.mp4',
          localAudioUrl: '/tmp/audio.wav',
          backgroundPanoramaUrl: '/tmp/panorama.jpg',
        },
      }]),
      edgesJson: '[]',
      viewportJson: '{}',
      historyJson: '{}',
      imagePoolJson: '[]',
    };
    const sources = collectProjectMediaSources(record).map((item) => item.source);
    expect(sources).toContain('data:image/png;base64,AA==');
    expect(sources).toContain('/tmp/video.mp4');
    expect(sources).toContain('/tmp/audio.wav');
    expect(sources).toContain('/tmp/panorama.jpg');
    expect(sources).not.toContain('https://example.com/docs');
  });
});
