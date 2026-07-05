/**
 * Mutation profiles for the chaos harness.
 *
 * - baseline:    canonical markup; first run populates the locator cache.
 * - chaos-drift: pure LOCATOR DRIFT — ids/classes renamed, data-testids removed,
 *                labels reworded, buttons moved into wrapper divs. Every element
 *                still exists and behaves identically; a healthy healer should
 *                recover 100% of these at Tiers 0-1.
 * - regression:  genuine PRODUCT REGRESSION — markup identical to baseline but
 *                the order-confirmation message never appears. This must NOT be
 *                healed; it must fail loudly and be escalated.
 */
export const PROFILES = {
  baseline: {
    name: 'baseline',
    productCardId: (n) => `product-${n}`,
    addButton: {
      id: (n) => `add-to-cart-${n}`,
      testId: (n) => `add-to-cart-${n}`,
      className: 'btn btn-primary',
      label: 'Add to cart',
      wrapped: false,
    },
    cartBadge: { id: 'cart-count', testId: 'cart-count', className: 'cart-badge' },
    checkoutLink: { testId: 'go-checkout', className: 'checkout-link', label: 'Checkout' },
    email: {
      id: 'email',
      label: 'Email',
      placeholder: 'you@example.com',
      className: 'input',
    },
    orderButton: {
      testId: 'place-order',
      className: 'btn btn-order',
      label: 'Place order',
      wrapped: false,
    },
    confirmation: { present: true, id: 'order-confirmation', className: 'confirmation' },
  },

  'chaos-drift': {
    name: 'chaos-drift',
    productCardId: (n) => `prod-item-${n}`,
    addButton: {
      id: () => null,
      testId: () => null,
      className: 'button-cta',
      label: 'Add to cart',
      wrapped: true, // moved into a new .card-actions wrapper div
    },
    cartBadge: { id: 'basket-count', testId: null, className: 'cart-badge' },
    checkoutLink: { testId: null, className: 'checkout-link', label: 'Checkout' },
    email: {
      id: 'contact-email',
      label: 'Email address', // reworded label
      placeholder: 'you@example.com',
      className: 'input',
    },
    orderButton: {
      testId: null,
      className: 'btn order-btn', // class renamed
      label: 'Place your order', // reworded
      wrapped: true, // moved into a new .order-actions wrapper div
    },
    confirmation: { present: true, id: 'confirm-note', className: 'confirmation' },
  },

  /**
   * Deep drift: the two mutated widgets lose ALL deterministic anchors —
   * labels reworded past the Tier 1 threshold, classes renamed, testids/ids
   * removed, structure re-nested. Fingerprint similarity lands in the
   * 0.5–0.85 band: clearly LOCATOR_DRIFT, but only Tier 2 (LLM) can resolve
   * it. Everything else stays baseline.
   */
  'chaos-deep': {
    name: 'chaos-deep',
    productCardId: (n) => `product-${n}`,
    addButton: {
      id: () => null,
      testId: () => null,
      className: 'shop-action',
      label: 'Add to bag',
      wrapped: 'deep', // two new nested wrapper divs
    },
    cartBadge: { id: 'cart-count', testId: 'cart-count', className: 'cart-badge' },
    checkoutLink: { testId: 'go-checkout', className: 'checkout-link', label: 'Checkout' },
    email: {
      id: 'email',
      label: 'Email',
      placeholder: 'you@example.com',
      className: 'input',
    },
    orderButton: {
      testId: null,
      className: 'btn checkout-submit',
      label: 'Submit order',
      wrapped: 'deep',
    },
    confirmation: { present: true, id: 'order-confirmation', className: 'confirmation' },
  },

  /**
   * The AMBIGUOUS case for the LLM classifier: the confirmation element keeps
   * its id/class/position (drift-level structural similarity) but its text now
   * MEANS failure. Deterministic heuristics see contradictory signals; the
   * classifier must call it PRODUCT_REGRESSION and never heal the assertion.
   */
  'ambiguous-regression': {
    name: 'ambiguous-regression',
    productCardId: (n) => `product-${n}`,
    addButton: {
      id: (n) => `add-to-cart-${n}`,
      testId: (n) => `add-to-cart-${n}`,
      className: 'btn btn-primary',
      label: 'Add to cart',
      wrapped: false,
    },
    cartBadge: { id: 'cart-count', testId: 'cart-count', className: 'cart-badge' },
    checkoutLink: { testId: 'go-checkout', className: 'checkout-link', label: 'Checkout' },
    email: {
      id: 'email',
      label: 'Email',
      placeholder: 'you@example.com',
      className: 'input',
    },
    orderButton: {
      testId: 'place-order',
      className: 'btn btn-order',
      label: 'Place order',
      wrapped: false,
    },
    confirmation: {
      present: true,
      id: 'order-confirmation',
      className: 'confirmation',
      text: 'Order could not be confirmed',
    },
  },

  regression: {
    name: 'regression',
    productCardId: (n) => `product-${n}`,
    addButton: {
      id: (n) => `add-to-cart-${n}`,
      testId: (n) => `add-to-cart-${n}`,
      className: 'btn btn-primary',
      label: 'Add to cart',
      wrapped: false,
    },
    cartBadge: { id: 'cart-count', testId: 'cart-count', className: 'cart-badge' },
    checkoutLink: { testId: 'go-checkout', className: 'checkout-link', label: 'Checkout' },
    email: {
      id: 'email',
      label: 'Email',
      placeholder: 'you@example.com',
      className: 'input',
    },
    orderButton: {
      testId: 'place-order',
      className: 'btn btn-order',
      label: 'Place order',
      wrapped: false,
    },
    // The injected regression: the success message never appears.
    confirmation: { present: false },
  },
};

export const PRODUCTS = [
  { n: 1, name: 'Aurora Desk Lamp', price: '$49' },
  { n: 2, name: 'Nimbus Lounge Chair', price: '$129' },
  { n: 3, name: 'Terra Ceramic Vase', price: '$32' },
];
