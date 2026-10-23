const users = require('../services/userService');
const orders = require('../services/orderService');
const db = require('../db/database');

async function handleRegister(body) {
  return users.register(body);
}

async function handleBuy(user, items, method) {
  const order = await orders.createOrder(user, items);
  const payment = await orders.checkout(order, method);
  return { order, payment, totalOrders: db.tables.orders.length };
}

function canRegister(body) {
  return body.age >= 16;
}

module.exports = { handleRegister, handleBuy, canRegister };
