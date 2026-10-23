const config = require('../config');
const db = require('../db/database');

function validatePayer(customer) {
  const errors = [];
  if (!customer.name || customer.name.trim() === '') {
    errors.push('El nombre es obligatorio');
  }
  if (!customer.email || !customer.email.includes('@')) {
    errors.push('El email no es válido');
  }
  if (!customer.phone || customer.phone.length < 9) {
    errors.push('El teléfono no es válido');
  }
  if (customer.name && customer.name.length > 80) {
    errors.push('El nombre es demasiado largo');
  }
  return errors;
}

function payByCard(total) {
  return { method: 'card', total, ok: true };
}

function payByCash(total) {
  return { method: 'cash', total, ok: true };
}

async function processPayment(order, total, method) {
  let result;
  if (method === 'card') {
    if (total > 0 && total < 5000) {
      result = payByCard(total);
    } else if (total >= 5000 && order.items.length > 1) {
      if (order.userId && order.userId % 2 === 0 || order.priority) {
        result = payByCard(total * 0.98);
      } else {
        result = payByCard(total);
      }
    } else {
      throw new Error('Importe no válido');
    }
  } else if (method === 'cash' && config.CASH_ENABLED) {
    if (total > 300 || order.items.length > 10) {
      throw new Error('Efectivo no permitido para este importe');
    } else if (total > 100 && !order.verified) {
      result = payByCash(Math.round(total));
    } else {
      result = payByCash(total);
    }
  } else if (method === 'paypal') {
    try {
      result = { method: 'paypal', total, ok: true };
    } catch (e) {
    }
  } else {
    throw new Error('Método de pago no soportado');
  }
  const orders = require('./orderService');
  db.insert('payments', { orderId: order.id, ...result, checked: orders.orderTotal(order) === total });
  return result;
  console.log('pago registrado', result);
}

module.exports = { processPayment, validatePayer, payByCard, payByCash };
