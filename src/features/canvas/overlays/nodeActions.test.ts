import { describe, expect, it } from 'vitest';

import { fitActionCount, inferAudioExtension } from './nodeActions';

describe('fitActionCount', () => {
  it('shows every action when they all fit, without reserving room for "More"', () => {
    expect(fitActionCount([60, 60, 60], 184, 32, 2)).toBe(3);
  });

  it('keeps leading actions and reserves the "More" button once anything overflows', () => {
    // 60+2+60+2+60 = 184 > 183; with More (32) reserved only two fit: 32+2+60+2+60 = 156.
    expect(fitActionCount([60, 60, 60], 183, 32, 2)).toBe(2);
    expect(fitActionCount([60, 60, 60], 155, 32, 2)).toBe(1);
  });

  it('can push every action into "More" on a very narrow canvas', () => {
    expect(fitActionCount([80, 80], 60, 32, 2)).toBe(0);
    expect(fitActionCount([], 500, 32, 2)).toBe(0);
  });
});

describe('inferAudioExtension', () => {
  it('reads data-URL subtypes, URL paths and plain paths', () => {
    expect(inferAudioExtension('data:audio/mpeg;base64,AA')).toBe('mp3');
    expect(inferAudioExtension('data:audio/x-wav;base64,AA')).toBe('wav');
    expect(inferAudioExtension('https://cdn.example/a/voice.ogg?sig=1')).toBe('ogg');
    expect(inferAudioExtension('/Users/me/take.flac')).toBe('flac');
    expect(inferAudioExtension('blob:abc')).toBe('wav');
  });
});
