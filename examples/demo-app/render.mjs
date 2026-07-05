import { PRODUCTS } from './profiles.mjs';

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #222; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 14px 28px; background: #1d2733; color: #fff; }
  header a { color: #ffd479; margin-left: 16px; text-decoration: none; font-weight: 600; }
  .cart-badge { display: inline-block; min-width: 22px; text-align: center; background: #ffd479; color: #1d2733; border-radius: 11px; padding: 2px 6px; font-weight: 700; margin-left: 6px; }
  main { max-width: 860px; margin: 28px auto; padding: 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { background: #fff; border-radius: 10px; padding: 18px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .card h2 { font-size: 17px; margin: 0 0 4px; }
  .price { color: #667; margin: 0 0 12px; }
  button { cursor: pointer; border: 0; border-radius: 7px; padding: 9px 14px; font-size: 14px; font-weight: 600; }
  .btn-primary, .button-cta { background: #2563eb; color: #fff; }
  .btn-order, .order-btn { background: #16a34a; color: #fff; padding: 11px 20px; }
  form { background: #fff; border-radius: 10px; padding: 22px; max-width: 430px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  .input { width: 100%; padding: 9px; border: 1px solid #ccc; border-radius: 6px; margin-bottom: 14px; box-sizing: border-box; }
  .form-note { color: #667; font-size: 13px; }
  .confirmation { margin-top: 18px; padding: 14px 18px; background: #dcfce7; border: 1px solid #16a34a; border-radius: 8px; font-weight: 600; }
  #consent-banner { position: fixed; bottom: 0; left: 0; right: 0; background: #111; color: #eee; padding: 12px 28px; display: flex; justify-content: space-between; align-items: center; }
  #consent-banner button { background: #ffd479; color: #111; }
`;

function attrs(pairs) {
  return Object.entries(pairs)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
}

function header(profile) {
  const b = profile.cartBadge;
  return `
  <header>
    <div><strong>Sentinel Shop</strong></div>
    <nav>
      <a ${attrs({ href: '/checkout', class: profile.checkoutLink.className, 'data-testid': profile.checkoutLink.testId })}>${profile.checkoutLink.label}</a>
      <span ${attrs({ id: b.id, class: b.className, 'data-testid': b.testId })}>0</span>
    </nav>
  </header>`;
}

const CONSENT = `
  <div id="consent-banner" hidden>
    <span>We use strictly necessary cookies to run this demo shop.</span>
    <button id="consent-accept" data-testid="consent-accept" type="button">Accept necessary cookies</button>
  </div>
  <script>
    (function () {
      var banner = document.getElementById('consent-banner');
      if (!localStorage.getItem('consent')) banner.hidden = false;
      document.getElementById('consent-accept').addEventListener('click', function () {
        localStorage.setItem('consent', '1');
        banner.hidden = true;
      });
    })();
  </script>`;

const CART_JS = `
  <script>
    window.__cart = {
      count: function () { return parseInt(localStorage.getItem('cartCount') || '0', 10); },
      add: function () {
        localStorage.setItem('cartCount', String(this.count() + 1));
        this.render();
      },
      render: function () {
        var badge = document.querySelector('.cart-badge');
        if (badge) badge.textContent = String(this.count());
      }
    };
    window.__cart.render();
  </script>`;

export function renderProducts(profile) {
  const cards = PRODUCTS.map((p) => {
    const btnId = typeof profile.addButton.id === 'function' ? profile.addButton.id(p.n) : null;
    const btnTestId =
      typeof profile.addButton.testId === 'function' ? profile.addButton.testId(p.n) : null;
    const button = `<button ${attrs({
      id: btnId,
      'data-testid': btnTestId,
      class: profile.addButton.className,
      type: 'button',
      onclick: 'window.__cart.add()',
    })}>${profile.addButton.label}</button>`;
    const wrapped =
      profile.addButton.wrapped === 'deep'
        ? `<div class="deal-banner"><div class="cta-slot">${button}</div></div>`
        : profile.addButton.wrapped
          ? `<div class="card-actions">${button}</div>`
          : button;
    return `
      <div ${attrs({ id: profile.productCardId(p.n), class: 'card' })}>
        <h2>${p.name}</h2>
        <p class="price">${p.price}</p>
        ${wrapped}
      </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sentinel Shop — Products</title><style>${STYLE}</style></head>
<body>
  ${header(profile)}
  <main>
    <h1>Products</h1>
    <div class="grid">${cards}</div>
  </main>
  ${CONSENT}
  ${CART_JS}
</body>
</html>`;
}

export function renderCheckout(profile) {
  const e = profile.email;
  const o = profile.orderButton;
  const orderButton = `<button ${attrs({
    'data-testid': o.testId,
    class: o.className,
    type: 'submit',
  })}>${o.label}</button>`;
  const confirmation = profile.confirmation.present
    ? `<div ${attrs({
        id: profile.confirmation.id,
        class: profile.confirmation.className,
        hidden: true,
      })}>${profile.confirmation.text ?? 'Order confirmed'}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sentinel Shop — Checkout</title><style>${STYLE}</style></head>
<body>
  ${header(profile)}
  <main>
    <h1>Checkout</h1>
    <form id="checkout-form">
      <label for="${e.id}">${e.label}</label>
      <input ${attrs({
        id: e.id,
        class: e.className,
        type: 'email',
        name: 'email',
        placeholder: e.placeholder,
        required: 'required',
      })}>
      <p class="form-note">We will email your receipt.</p>
      ${
        o.wrapped === 'deep'
          ? `<div class="action-row"><div class="action-cell">${orderButton}</div></div>`
          : o.wrapped
            ? `<div class="order-actions">${orderButton}</div>`
            : orderButton
      }
    </form>
    ${confirmation}
  </main>
  ${CONSENT}
  ${CART_JS}
  <script>
    document.getElementById('checkout-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var note = document.querySelector('.confirmation');
      if (note) note.hidden = false;
      localStorage.setItem('cartCount', '0');
    });
  </script>
</body>
</html>`;
}
