import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { sentinelDomAgent } from '../src/domAgent.js';
import type { ElementFingerprint } from '../src/types.js';

const PAGE = `<!doctype html><html><body>
  <main>
    <div id="product-1" class="card">
      <h2>Aurora Desk Lamp</h2>
      <p class="price">$49</p>
      <button id="add-to-cart-1" data-testid="add-to-cart-1" class="btn btn-primary" type="button">Add to cart</button>
    </div>
    <form>
      <label for="email">Email</label>
      <input id="email" class="input" type="email" name="email" placeholder="you@example.com" value="typed@secret.com">
      <input id="cc" name="card-number" type="text" value="4111111111111111">
      <input id="pw" type="password" name="password" placeholder="Your password">
      <button type="submit">Place order</button>
    </form>
    <div class="pii">Customer: Jane Doe</div>
    <span id="msg">Order confirmed</span>
    <script>var secret = 'nope';</script>
  </main>
</body></html>`;

function dom() {
  return new JSDOM(PAGE).window.document;
}

const baseOpts = { testIdAttribute: 'data-testid', assumeVisible: true };

describe('sentinelDomAgent fingerprint', () => {
  it('captures identity, role, accessible name and label association', () => {
    const doc = dom();
    const btn = doc.getElementById('add-to-cart-1')!;
    const fp = sentinelDomAgent(btn, { cmd: 'fingerprint', ...baseOpts }) as ElementFingerprint;
    expect(fp.tag).toBe('button');
    expect(fp.role).toBe('button');
    expect(fp.name).toBe('Add to cart');
    expect(fp.testId).toBe('add-to-cart-1');
    expect(fp.classes).toEqual(['btn', 'btn-primary']);
    expect(fp.nearbyText).toContain('Aurora Desk Lamp');
    expect(fp.cssPath).toContain('button:nth-of-type');

    const email = doc.getElementById('email')!;
    const efp = sentinelDomAgent(email, { cmd: 'fingerprint', ...baseOpts }) as ElementFingerprint;
    expect(efp.role).toBe('textbox');
    expect(efp.labelText).toBe('Email');
    expect(efp.name).toBe('Email');
    expect(efp.attributes.placeholder).toBe('you@example.com');
  });
});

describe('sentinelDomAgent collect', () => {
  it('collects interactive elements and text leaves, never scripts', () => {
    const doc = dom();
    const list = sentinelDomAgent(doc.body, {
      cmd: 'collect',
      ...baseOpts,
    }) as ElementFingerprint[];
    const names = list.map((f) => f.name);
    expect(names).toContain('Add to cart');
    expect(names).toContain('Email');
    expect(list.some((f) => f.text === 'Order confirmed')).toBe(true);
    expect(list.every((f) => f.tag !== 'script')).toBe(true);
  });

  it('respects the element budget', () => {
    const doc = dom();
    const list = sentinelDomAgent(doc.body, {
      cmd: 'collect',
      ...baseOpts,
      maxElements: 3,
    }) as ElementFingerprint[];
    expect(list.length).toBeLessThanOrEqual(3);
  });

  it('treats display:contents wrappers as visible despite their zero-size box', () => {
    // jsdom has no layout, so every rect is 0x0 — exactly the condition a real
    // display:contents element hits in the browser. Without assumeVisible, only
    // the display:contents wrapper may survive the visibility check.
    const doc = new JSDOM(`<!doctype html><html><body>
      <div data-testid="wrapper" style="display: contents"><button>Go</button></div>
      <div data-testid="hidden-wrapper" style="display: contents; visibility: hidden"><button>No</button></div>
      <div data-testid="plain">zero-size box</div>
    </body></html>`).window.document;
    const list = sentinelDomAgent(doc.body, {
      cmd: 'collect',
      testIdAttribute: 'data-testid',
    }) as ElementFingerprint[];
    const ids = list.map((f) => f.testId);
    expect(ids).toContain('wrapper');
    expect(ids).not.toContain('hidden-wrapper');
    expect(ids).not.toContain('plain');
  });
});

describe('sentinelDomAgent sanitize (spec §10)', () => {
  const opts = {
    cmd: 'sanitize' as const,
    ...baseOpts,
    maskPatterns: ['pass(word)?', 'card', 'token'],
    redactSelectors: ['.pii'],
  };

  it('strips input values', () => {
    const html = sentinelDomAgent(dom().body, opts) as string;
    expect(html).not.toContain('typed@secret.com');
    expect(html).not.toContain('4111111111111111');
  });

  it('masks password/card-pattern fields', () => {
    const html = sentinelDomAgent(dom().body, opts) as string;
    expect(html).not.toContain('Your password');
    const doc = new JSDOM(html).window.document;
    expect(doc.getElementById('pw')!.getAttribute('data-sentinel-redacted')).toBe('true');
    expect(doc.getElementById('cc')!.getAttribute('data-sentinel-redacted')).toBe('true');
  });

  it('applies configurable redaction selectors', () => {
    const html = sentinelDomAgent(dom().body, opts) as string;
    expect(html).not.toContain('Jane Doe');
    expect(html).toContain('[REDACTED]');
  });

  it('drops scripts entirely', () => {
    const html = sentinelDomAgent(dom().body, opts) as string;
    expect(html).not.toContain('var secret');
  });
});
