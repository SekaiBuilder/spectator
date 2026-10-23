// Simula unos cuantos clientes usando la aplicación, para poder ver el flujo en vivo.
const controller = require('./controllers/orderController');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function simulateCustomer(n) {
  const user = await controller.handleRegister({
    name: 'Cliente ' + n, email: `cliente${n}@correo.com`, phone: '600000000', age: 20 + n, password: 'secreta' + n,
  });
  await wait(500);
  const items = [{ id: 1, price: 12, qty: 2 }, { id: 2, price: 8, qty: 1 }];
  const method = n % 3 === 0 ? 'cash' : 'card';
  const { payment } = await controller.handleBuy(user, items, method);
  console.log(`Cliente ${n}: pagó ${payment.total} con ${payment.method}`);
}

async function main() {
  for (let n = 1; n <= 6; n++) {
    await simulateCustomer(n);
    await wait(700);
  }
  console.log('Fin de la simulación');
}

main();
