import { describe, expect, it } from 'vitest';

import { linkLinesEnabled, setLinkLinesEnabled } from '../src/office/linkLines.js';

describe('link lines preference', () => {
  it('is on by default and can be turned off and on again', () => {
    // No localStorage in the node test environment: the default applies and
    // the choice lasts for the page.
    expect(linkLinesEnabled()).toBe(true);
    setLinkLinesEnabled(false);
    expect(linkLinesEnabled()).toBe(false);
    setLinkLinesEnabled(true);
    expect(linkLinesEnabled()).toBe(true);
  });
});
