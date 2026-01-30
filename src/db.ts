import Database from "better-sqlite3";
import path from "path";

// Ruta absoluta compatible con Render
const dbPath = path.join(process.cwd(), "leads.db");

// Crear / abrir base de datos
export const db = new Database(dbPath);

// Crear tabla si no existe
db.prepare(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

console.log("✅ SQLite database initialized");
