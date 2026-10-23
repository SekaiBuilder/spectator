const test = require('node:test');
const { orderTotal } = require('../src/services/orderService');

test('calcula el total', () => {
  const total = orderTotal({ items: [{ price: 10, qty: 2 }] });
  console.log(total);
});
