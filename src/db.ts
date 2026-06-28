import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "leads.db");
export const db = new Database(dbPath);

// Tabla leads existente
db.prepare(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// Nueva tabla reservas
db.prepare(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    room_name TEXT NOT NULL,
    guest_name TEXT NOT NULL,
    guest_email TEXT,
    guest_phone TEXT,
    guest_nationality TEXT,
    num_persons INTEGER NOT NULL DEFAULT 1,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    price_total REAL,
    price_paid REAL DEFAULT 0,
    payment_status TEXT DEFAULT 'pending',
    channel TEXT DEFAULT 'whatsapp',
    notes TEXT,
    payment_method TEXT DEFAULT 'Efectivo',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

console.log("✅ SQLite database initialized");