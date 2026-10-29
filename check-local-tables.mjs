import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

const tables = [
  'companies',
  'branches',
  'employees',
  'devices',
  'attendance_events',
  'sync_jobs',
  'device_user_staging',
  'hr_employee_staging',
  'api_integrations'
];

try {
  const info = await pool.query(
    "SELECT current_database() AS database, current_schema() AS schema"
  );

  console.log('Database:', info.rows[0].database);
  console.log('Schema:', info.rows[0].schema);

  for (const table of tables) {
    const result = await pool.query(
      'SELECT to_regclass($1) AS table_name',
      ['public.' + table]
    );

    console.log(
      table.padEnd(24),
      result.rows[0].table_name ? 'OK' : 'MISSING'
    );
  }
} catch (error) {
  console.error('Error code:', error.code);
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
