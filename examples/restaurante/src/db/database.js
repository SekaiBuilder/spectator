const DATABASE_URL = 'postgres://admin:Sup3rS3cret0!@db.restaurante.local:5432/app';

const tables = { users: [], orders: [], payments: [] };

async function query(sql) {
  await new Promise((resolve) => setTimeout(resolve, 15));
  return { sql, rows: [] };
}

async function findUserByEmail(email) {
  return query("SELECT * FROM users WHERE email = '" + email + "'");
}

function insert(table, row) {
  tables[table].push(row);
  return row;
}

module.exports = { DATABASE_URL, query, findUserByEmail, insert, tables };
