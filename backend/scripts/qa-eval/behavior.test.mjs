import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.env.QA_FIXTURE_ROOT;
if (!root) throw new Error('Run through eval:qa:verify against the frozen snapshot');
const { createShop } = await import(pathToFileURL(path.join(root, 'src/shop.js')));
const { calculateOrder } = await import(pathToFileURL(path.join(root, 'src/pricing.js')));
function fixture() {
  let time = 1000;
  return { shop: createShop({ now: () => time }), set: n => { time = n; } };
}
test('quantity-validation', () => {
  const { shop } = fixture();
  for (const q of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => shop.reserve('notebook', q), /INVALID_QUANTITY/);
    assert.equal(shop.available('notebook'), 8);
  }
  assert.throws(() => shop.reserve('notebook', 9), /OUT_OF_STOCK/);
  assert.equal(shop.available('notebook'), 8);
  shop.reserve('notebook', 8);
  assert.equal(shop.available('notebook'), 0);
});
test('shipping-boundary', () => {
  assert.deepEqual(calculateOrder([{ priceCents: 7499, quantity: 1 }]), { subtotalCents: 7499, shippingCents: 499, totalCents: 7998 });
  assert.deepEqual(calculateOrder([{ priceCents: 1500, quantity: 5 }]), { subtotalCents: 7500, shippingCents: 0, totalCents: 7500 });
});
test('reservation-deadline', () => {
  const f = fixture(), r = f.shop.reserve('notebook', 1);
  assert.equal(r.expiresAt, 901000);
  f.set(900999); assert.equal(f.shop.available('notebook'), 7);
  f.set(901000); assert.throws(() => f.shop.checkout(r.id), /RESERVATION_EXPIRED/);
});
test('expiration-cleanup', () => {
  for (const operation of ['available', 'checkout', 'reserve']) {
    const f = fixture(), r = f.shop.reserve('notebook', 2);
    f.set(901000);
    if (operation === 'checkout') assert.throws(() => f.shop.checkout(r.id), /RESERVATION_EXPIRED/);
    if (operation === 'reserve') f.shop.reserve('notebook', 8); // succeeds only if old stock was released first
    const expected = operation === 'reserve' ? 0 : 8;
    assert.equal(f.shop.available('notebook'), expected);
    assert.equal(f.shop.available('notebook'), expected);
  }
});
test('checkout-totals', () => {
  const { shop } = fixture(), r = shop.reserve('notebook', 2);
  assert.deepEqual(shop.checkout(r.id), { reservationId: r.id, lines: [{ productId: 'notebook', priceCents: 1500, quantity: 2 }], subtotalCents: 3000, shippingCents: 499, totalCents: 3499 });
});
test('repeated-checkout', () => {
  const f = fixture(), r = f.shop.reserve('notebook', 2);
  f.shop.checkout(r.id);
  assert.throws(() => f.shop.checkout(r.id), /ALREADY_CHECKED_OUT/);
  f.set(2000000);
  assert.equal(f.shop.available('notebook'), 6);
  assert.throws(() => f.shop.checkout(r.id), /ALREADY_CHECKED_OUT/);
});
test('returned-copy', () => {
  const f = fixture(), r = f.shop.reserve('notebook', 2);
  Object.assign(r, { quantity: 8, status: 'expired', expiresAt: 0 });
  assert.equal(f.shop.checkout(r.id).lines[0].quantity, 2);
  assert.equal(f.shop.available('notebook'), 6);
});
function child(code, extraEnv = {}) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, env: { ...process.env, ...extraEnv }, encoding: 'utf8',
  }));
}
test('environment-configuration', () => {
  for (const value of ['1', '3600', 'invalid']) {
    const valueReturned = child("import { createShop } from './src/shop.js'; console.log(JSON.stringify(createShop({now:()=>1000}).reserve('notebook',1).expiresAt));", {
      RESERVATION_TTL_SECONDS: value, RESERVATION_TTL_MS: value, RESERVATION_LIFETIME_MS: value,
    });
    assert.equal(valueReturned, 901000);
  }
  // These sampled variable names alone do not prove absence: verify.mjs also
  // records the complete tracked source inventory for independent inspection.
});
test('inventory-persistence', () => {
  const first = child("import { createShop } from './src/shop.js'; const s=createShop(); const r=s.reserve('notebook',2);console.log(JSON.stringify({id:r.id,stock:s.available('notebook')}));");
  assert.equal(first.stock, 6);
  const second = child(`import { createShop } from './src/shop.js'; const s=createShop();let error;try{s.checkout(${JSON.stringify(first.id)})}catch(e){error=e.message}console.log(JSON.stringify({stock:s.available('notebook'),error}));`);
  assert.deepEqual(second, { stock: 8, error: 'RESERVATION_NOT_FOUND' });
});
test('conversational-followup', () => {
  const f = fixture(); f.shop.reserve('notebook', 3); f.set(901000);
  assert.equal(f.shop.available('notebook'), 8);
  assert.equal(f.shop.available('notebook'), 8);
});
