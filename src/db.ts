import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres.dmmimgmkmxvltimjfhoa:bcnrooms2024@aws-1-eu-north-1.pooler.supabase.com:6543/postgres';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL,
      room_name TEXT NOT NULL,
      guest_name TEXT NOT NULL,
      guest_email TEXT,
      guest_phone TEXT,
      guest_nationality TEXT,
      num_persons INTEGER NOT NULL DEFAULT 1,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      price_total NUMERIC,
      price_paid NUMERIC DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      payment_method TEXT DEFAULT 'Efectivo',
      channel TEXT DEFAULT 'whatsapp',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Añadir columna price_per_night si no existe
  await pool.query(`
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS price_per_night NUMERIC
  `);

  console.log('✅ PostgreSQL database initialized');
}