import type { ElementFingerprint } from '../src/types.js';

export function makeFp(partial: Partial<ElementFingerprint>): ElementFingerprint {
  return {
    tag: 'button',
    role: 'button',
    name: '',
    text: '',
    id: null,
    testId: null,
    classes: [],
    attributes: {},
    nearbyText: '',
    labelText: '',
    cssPath: 'body > main:nth-of-type(1) > button:nth-of-type(1)',
    ...partial,
  };
}
