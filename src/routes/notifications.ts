import { Router, Request, Response } from "express";
import webpush from "web-push";
import { pool } from "../db";

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bcnrooms2024";
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "BA5DaRGffeauWh_Cn1tvUERV6x0I5OBfmAOv9V2m2AS5lSekyDz-g5CztBbgy_DGIFrTTZ1zRR_jsOqgiE2DrIM";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "uGTdJODRhd4r9iCLOHofl2OZAclas2LHur0RrRrd1jU";

webpush.setVapidDetails('mailto:bcnrooms01@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

function authMiddleware(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expected = Buffer.from(ADMIN_PASSWORD).toString("base64");
  if (token === expected) next();
  else res.status(401).json({ error: "Unauthorized" });
}

// Crear tabla de suscripciones
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
}

// GET vapid public key
router.get("/push/vapid-key", (_req: Request, res: Response) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// POST guardar suscripción
router.post("/push/subscribe", authMiddleware, async (req: Request, res: Response) => {
  const { endpoint, keys } = req.body;
  try {
    await pool.query(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth)
      VALUES ($1, $2, $3)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3
    `, [endpoint, keys.p256dh, keys.auth]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to save subscription" });
  }
});

// POST enviar notificación manual
router.post("/push/send", authMiddleware, async (req: Request, res: Response) => {
  const { title, body } = req.body;
  await sendToAll({ title, body });
  res.json({ success: true });
});

// Función para enviar a todos los suscriptores
export async function sendToAll(payload: { title: string; body: string; url?: string }) {
  const result = await pool.query(`SELECT * FROM push_subscriptions`);
  const subs = result.rows;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/admin' })
      );
    } catch (e: any) {
      // Si el endpoint ya no es válido, eliminarlo
      if (e.statusCode === 410) {
        await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
      }
    }
  }
}

// Notificaciones diarias automáticas (llamar desde cron)
export async function sendDailyNotifications() {
  const today = new Date().toISOString().split('T')[0];

  const checkins = await pool.query(
    `SELECT guest_name, room_name FROM reservations WHERE check_in = $1`, [today]
  );
  const checkouts = await pool.query(
    `SELECT guest_name, room_name, price_total, price_paid FROM reservations WHERE check_out = $1`, [today]
  );

  if (checkins.rows.length > 0) {
    const names = checkins.rows.map((r: any) => r.guest_name).join(', ');
    await sendToAll({
      title: `🏠 Check-in hoy (${checkins.rows.length})`,
      body: names,
      url: '/admin'
    });
  }

  if (checkouts.rows.length > 0) {
    const pending = checkouts.rows.filter((r: any) => Number(r.price_total) > Number(r.price_paid));
    await sendToAll({
      title: `🚪 Check-out hoy (${checkouts.rows.length})`,
      body: pending.length > 0 ? `${pending.length} con pago pendiente` : 'Todo al día',
      url: '/admin'
    });
  }
}

export default router;