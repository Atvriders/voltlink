// reset-visual-db.mjs — drops and recreates ONLY voltlink_visual (guide 08
// §11.2, R2-24 rules: never touch any other database on the shared server).
import pg from 'pg';

const adminUrl = process.argv[2];
if (!adminUrl) {
  console.error('usage: node reset-visual-db.mjs <postgres-db admin url>');
  process.exit(1);
}
const client = new pg.Client({ connectionString: adminUrl });
try {
  await client.connect();
  await client.query('DROP DATABASE IF EXISTS voltlink_visual WITH (FORCE)');
  await client.query('CREATE DATABASE voltlink_visual');
  console.log('voltlink_visual recreated');
} finally {
  await client.end().catch(() => undefined);
}
