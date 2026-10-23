const test = require('node:test');
const assert = require('node:assert');
const { checkAge, checkPassword } = require('../src/services/userService');

test('acepta mayores de edad', () => {
  assert.strictEqual(checkAge({ age: 30 }), true);
});

test('rechaza contraseñas cortas', () => {
  assert.strictEqual(checkPassword('abc'), false);
});
