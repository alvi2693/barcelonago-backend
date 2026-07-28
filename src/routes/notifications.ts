import { Router, Request, Response } from "express";
import webpush from "web-push";
import { pool } from "../db";

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bcnrooms2024";
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "BA5DaRGffeauWh_Cn1tvUERV6x0I5OBfmAOv9V2m2AS5lSekyDz-g5CztBbgy_DGIFrTTZ1zRR_jsOqgiE2DrIM";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "uGTdJODRhd4r9iCLOHofl2OZAclas2LHur0RrRrd1jU";
// Secreto para el endpoint de cron. Ponlo también en cron-job.org.
const CRON_KEY = process.env.CRON_KEY || "bcn-cron-2026";

webpush.setVapidDetails('mailto:bcnrooms01@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

function authMiddleware(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expected = Buffer.from(ADMIN_PASSWORD).toString("base64");
  if (token === expected) next();
  else res.status(401).json({ error: "Unauthorized" });
}

export async function initNotifications() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Registro de avisos ya enviados, para no repetir en la misma hora si el cron llama dos veces
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_log (
      id SERIAL PRIMARY KEY,
      slot TEXT UNIQUE NOT NULL,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ── Helpers de zona horaria (España, maneja verano/invierno solo) ──
function madridHour(d = new Date()): number {
  return parseInt(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid', hour12: false, hour: '2-digit' }), 10) % 24;
}
function madridDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

router.get("/push/vapid-key", (_req: Request, res: Response) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Acepta la suscripción cruda del navegador: { endpoint, keys: { p256dh, auth } }
// o el objeto directo. Normaliza ambos formatos.
router.post("/push/subscribe", authMiddleware, async (req: Request, res: Response) => {
  const sub = req.body;
  const endpoint = sub.endpoint;
  const p256dh = sub.keys?.p256dh ?? sub.p256dh;
  const auth = sub.keys?.auth ?? sub.auth;

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: "Suscripción incompleta" });
  }
  try {
    await pool.query(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth)
      VALUES ($1, $2, $3)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3
    `, [endpoint, p256dh, auth]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to save subscription" });
  }
});

router.post("/push/send", authMiddleware, async (req: Request, res: Response) => {
  const { title, body } = req.body;
  const n = await sendToAll({ title, body });
  res.json({ success: true, sent: n });
});

export async function sendToAll(payload: { title: string; body: string; url?: string }): Promise<number> {
  const result = await pool.query(`SELECT * FROM push_subscriptions`);
  let sent = 0;
  for (const sub of result.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/admin' })
      );
      sent++;
    } catch (e: any) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
      }
    }
  }
  return sent;
}

// ── Envíos concretos ──
async function avisarCheckinManana(noche = false) {
  const manana = madridDateStr(1);
  const r = await pool.query(`SELECT guest_name, room_name FROM reservations WHERE check_in = $1`, [manana]);
  if (r.rows.length === 0) return;
  const names = r.rows.map((x: any) => x.guest_name).join(', ');
  await sendToAll({
    title: noche ? `🌙 Mañana llegan (${r.rows.length})` : `🏠 Check-in mañana (${r.rows.length})`,
    body: `${names} · entran a las 14:00`,
    url: '/admin',
  });
}

async function avisarCheckoutManana() {
  const manana = madridDateStr(1);
  const r = await pool.query(`SELECT guest_name, room_name FROM reservations WHERE check_out = $1`, [manana]);
  if (r.rows.length === 0) return;
  const names = r.rows.map((x: any) => x.guest_name).join(', ');
  await sendToAll({
    title: `🚪 Mañana se van (${r.rows.length})`,
    body: `${names} · salen a las 11:00`,
    url: '/admin',
  });
}

async function avisarCheckoutHoy() {
  const hoy = madridDateStr(0);
  const r = await pool.query(
    `SELECT guest_name, room_name, price_total, price_paid FROM reservations WHERE check_out = $1`, [hoy]
  );
  if (r.rows.length === 0) return;
  const pendientes = r.rows.filter((x: any) => Number(x.price_total) > Number(x.price_paid));
  const names = r.rows.map((x: any) => x.guest_name).join(', ');
  await sendToAll({
    title: `🚪 Hoy se van (${r.rows.length})`,
    body: pendientes.length > 0
      ? `${names} · ⚠️ ${pendientes.length} con pago pendiente`
      : `${names} · salen a las 11:00`,
    url: '/admin',
  });
}

// ── Endpoint que llama cron-job.org cada hora ──
// El server decide qué avisos tocan según la hora de Madrid.
router.get("/push/cron", async (req: Request, res: Response) => {
  if (req.query.key !== CRON_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const hora = madridHour();
  const hoy = madridDateStr(0);
  const slot = `${hoy}-${hora}`; // evita duplicados si cron llama 2 veces la misma hora

  // ¿Ya se envió este slot?
  const dup = await pool.query(`SELECT 1 FROM push_log WHERE slot = $1`, [slot]);
  const acciones: string[] = [];

  if (dup.rows.length === 0) {
    if (hora === 8)  { await avisarCheckoutHoy();        acciones.push('checkout-hoy'); }
    if (hora === 9)  { await avisarCheckinManana(false); acciones.push('checkin-manana-am'); }
    if (hora === 20) { await avisarCheckinManana(true);  acciones.push('checkin-manana-pm'); }
    if (hora === 21) { await avisarCheckoutManana();     acciones.push('checkout-manana'); }

    if (acciones.length > 0) {
      await pool.query(`INSERT INTO push_log (slot) VALUES ($1) ON CONFLICT DO NOTHING`, [slot]);
    }
  }

  res.json({ ok: true, hora_madrid: hora, acciones, ya_enviado: dup.rows.length > 0 });
});

// Mantengo la función antigua por compatibilidad (ya no se usa desde index.ts)
export async function sendDailyNotifications() {
  await avisarCheckoutHoy();
}

export default router;