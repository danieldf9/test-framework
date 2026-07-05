import { test } from '@sentinel/core';

test('shopper can add products to the cart', async ({ page, s }) => {
  await s.goto('/products');
  await s.click({
    locator: page.locator('#add-to-cart-1'),
    intent: 'Add to cart button on the first product card (Aurora Desk Lamp)',
  });
  await s.click({
    locator: page.getByTestId('add-to-cart-2'),
    intent: 'Add to cart button on the second product card (Nimbus Lounge Chair)',
  });
  await s.expectText({
    locator: page.getByTestId('cart-count'),
    intent: 'Cart item counter badge in the site header',
    text: '2',
  });
});

test('checkout flow completes with confirmation', async ({ page, s }) => {
  await s.goto('/products');
  await s.click({
    locator: page.locator('#add-to-cart-1'),
    intent: 'Add to cart button on the first product card (Aurora Desk Lamp)',
  });
  await s.click({
    locator: page.getByTestId('go-checkout'),
    intent: 'Checkout navigation link in the site header',
  });
  await s.step('fill contact details and place the order', async () => {
    await s.fill({
      locator: page.getByLabel('Email', { exact: true }),
      intent: 'Email input field in the checkout contact form',
      value: 'test@example.com',
    });
    await s.click({
      locator: page.locator('.btn-order'),
      intent: 'Place order submit button at the bottom of the checkout form',
    });
  });
  await s.expectVisible({
    locator: page.getByText('Order confirmed'),
    intent: 'Order confirmation success message shown after purchase completes',
  });
});
