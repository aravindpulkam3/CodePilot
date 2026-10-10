// Private behavioral oracle, executed against frozen snapshots; never indexed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.BENCHMARK_REPO;
assert.ok(root, 'BENCHMARK_REPO is required');
const load = file => import(pathToFileURL(path.join(root, 'src', file)).href);
const { createShop } = await load('shop.js');
const { createInventory } = await load('inventory.js');
const { calculateOrder } = await load('pricing.js');

test('delivery amounts across the threshold', () => {
  for (const amount of [0, 1, 7499, 7500, 7501, 15000]) {
    const fee = amount < 7500 ? 499 : 0;
    assert.deepEqual(calculateOrder([{ priceCents: amount, quantity: 1 }]),
      { subtotalCents: amount, shippingCents: fee, totalCents: amount + fee });
  }
});
test('line amounts across multiple products', () => {
  assert.equal(calculateOrder([{ priceCents: 1500, quantity: 2 }, { priceCents: 900, quantity: 3 }]).subtotalCents, 5700);
});
test('availability after reservation cleanup', () => {
  let time = 10000;
  const shop = createShop({ now: () => time });
  const held = shop.reserve('notebook', 2);
  assert.equal(shop.available('notebook'), 6);
  time = 910000;
  assert.equal(shop.available('notebook'), 8);
  assert.equal(shop.available('notebook'), 8);
  assert.throws(() => shop.checkout(held.id), /RESERVATION_EXPIRED/);
});
test('shop factory uses its supplied clock', () => {
  let time = 10000;
  const shop = createShop({ now: () => time });
  const held = shop.reserve('pen-set', 1);
  assert.equal(held.expiresAt, 910000);
  time = held.expiresAt - 1;
  assert.equal(shop.available('pen-set'), 11);
  time += 1;
  assert.equal(shop.available('pen-set'), 12);
});
test('checkout transports the reserved quantity', () => {
  const shop = createShop({ now: () => 0 });
  const order = shop.checkout(shop.reserve('pen-set', 3).id);
  assert.equal(order.lines[0].quantity, 3);
  assert.equal(order.subtotalCents, 2700);
  assert.equal(order.totalCents, 3199);
  assert.ok(Number.isFinite(order.totalCents));
  assert.equal(shop.available('pen-set'), 9);
});
test('checkout retains catalog monetary units', () => {
  const rows = [['notebook', 1500, 8], ['pen-set', 900, 12], ['desk-pad', 3200, 5]];
  for (const [id, price, stock] of rows) for (let quantity = 1; quantity <= stock; quantity++) {
    const shop = createShop({ now: () => 0 });
    const order = shop.checkout(shop.reserve(id, quantity).id);
    assert.equal(order.lines[0].priceCents, price);
    assert.deepEqual(order.lines, [{ productId: id, priceCents: price, quantity }]);
    const subtotal = price * quantity;
    assert.equal(order.subtotalCents, subtotal);
    assert.equal(order.shippingCents, subtotal < 7500 ? 499 : 0);
    assert.equal(order.totalCents, subtotal + (subtotal < 7500 ? 499 : 0));
  }
});
test('inventory movements preserve balances', () => {
  assert.throws(() => createInventory([]).available('missing'), /PRODUCT_NOT_FOUND/);
  const products = [{ id: 'x', stock: 2 }, { id: 'x', stock: 8 }];
  const inventory = createInventory(products);
  const other = createInventory(products);
  assert.equal(inventory.available('x'), 8);
  inventory.allocate('x', 3);
  inventory.release('x', 2);
  assert.equal(inventory.available('x'), 7);
  assert.equal(other.available('x'), 8);
  assert.equal(products[1].stock, 8);
});
test('reservation lifecycle preserves consumption and snapshots', () => {
  let time = 10000;
  const shop = createShop({ now: () => time });
  const held = shop.reserve('notebook', 2);
  held.quantity = 999;
  held.status = 'expired';
  shop.checkout(held.id);
  time = 1000000;
  assert.equal(shop.available('notebook'), 6);
  assert.throws(() => shop.checkout(held.id), /ALREADY_CHECKED_OUT/);
});
test('order totals across generated baskets', () => {
  for (const a of [0, 900, 1500, 7500]) for (const b of [0, 499, 3200]) for (const q of [1, 2, 3]) {
    const lines = [{ priceCents: a, quantity: q }, { priceCents: b, quantity: 2 }];
    const original = structuredClone(lines);
    const subtotalCents = a * q + b * 2;
    const shippingCents = subtotalCents < 7500 ? 499 : 0;
    assert.deepEqual(calculateOrder(lines), { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents });
    assert.deepEqual(lines, original);
  }
  assert.deepEqual(calculateOrder([]), { subtotalCents: 0, shippingCents: 499, totalCents: 499 });
});
