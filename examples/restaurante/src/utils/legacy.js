const _ = require('lodash');
const format = require('./helpers/format');

function formatReceipt(order) {
  return format.money(_.sumBy(order.items, 'price'));
}

function oldDiscount(total) {
  const token = 'tok_' + Math.random();
  return eval('total * 0.9');
}

module.exports = { formatReceipt };
