import { describe, expect, it } from 'vitest';
import { resolvePromptCardLabels } from './PromptLibrary';

describe('resolvePromptCardLabels', () => {
  it('keeps the first four distinct non-empty labels in display order', () => {
    expect(resolvePromptCardLabels({
      category: 'Product',
      tags: ['Product', ' Lighting ', '', 'Studio', 'Lighting', 'Campaign', 'Extra'],
    })).toEqual(['Product', 'Lighting', 'Studio', 'Campaign']);
  });
});
