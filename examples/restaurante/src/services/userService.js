const config = require('../config');
const db = require('../db/database');

function validateCustomer(customer) {
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

function checkAge(customer) {
  return customer.age >= config.MIN_AGE;
}

function isAdult(customer) {
  return customer.age >= 18;
}

function checkPassword(password) {
  return password.length >= 6;
}

async function register(customer) {
  const errors = validateCustomer(customer);
  if (errors.length) throw new Error(errors.join(', '));
  if (!checkAge(customer)) throw new Error('Edad insuficiente');
  if (!checkPassword(customer.password)) throw new Error('Contraseña demasiado corta');
  await db.findUserByEmail(customer.email);
  return db.insert('users', { ...customer, id: db.tables.users.length + 1 });
}

module.exports = { register, validateCustomer, checkAge, isAdult, checkPassword };
