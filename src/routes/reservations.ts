import { Router, Request, Response } from "express";
import { pool } from "../db";

const router = Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bcnrooms2024";

// Login admin
router.post("/admin/login", (req: Request, res: Response) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD).toString("base64") });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Middleware auth
function authMiddleware(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expected = Buffer.from(ADMIN_PASSWORD).toString("base64");
  if (token === expected) next();
  else res.status(401).json({ error: "Unauthorized" });
}

// Verificar solapamiento
async function checkOverlap(room_id: number, check_in: string, check_out: string, excludeId?: number): Promise<boolean> {
  const query = excludeId
    ? `SELECT id FROM reservations WHERE room_id = $1 AND id != $2 AND check_in < $3 AND check_out > $4`
    : `SELECT id FROM reservations WHERE room_id = $1 AND check_in < $2 AND check_out > $3`;
  const params = excludeId
    ? [room_id, excludeId, check_out, check_in]
    : [room_id, check_out, check_in];
  const result = await pool.query(query, params);
  return result.rows.length > 0;
}

// GET todas las reservas
router.get("/admin/reservations", authMiddleware, async (_req: Request, res: Response) => {
  const result = await pool.query(`SELECT * FROM reservations ORDER BY check_in ASC`);
  res.json(result.rows);
});

// GET reservas por habitación
router.get("/admin/reservations/room/:roomId", authMiddleware, async (req: Request, res: Response) => {
  const result = await pool.query(`SELECT * FROM reservations WHERE room_id = $1 ORDER BY check_in ASC`, [req.params.roomId]);
  res.json(result.rows);
});

// POST crear reserva
router.post("/admin/reservations", authMiddleware, async (req: Request, res: Response) => {
  const {
    room_id, room_name, guest_name, guest_email, guest_phone,
    guest_nationality, num_persons, check_in, check_out,
    price_total, price_paid, payment_status, payment_method, channel, notes
  } = req.body;

  if (!room_id || !guest_name || !check_in || !check_out) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (check_in >= check_out) {
    return res.status(400).json({ error: "Check-out debe ser posterior al check-in" });
  }
  if (await checkOverlap(room_id, check_in, check_out)) {
    return res.status(409).json({ error: "Ya existe una reserva en esa habitación para esas fechas" });
  }

  const result = await pool.query(`
    INSERT INTO reservations (
      room_id, room_name, guest_name, guest_email, guest_phone,
      guest_nationality, num_persons, check_in, check_out,
      price_total, price_paid, payment_status, payment_method, channel, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING id
  `, [
    room_id, room_name, guest_name, guest_email || null, guest_phone || null,
    guest_nationality || null, num_persons || 1, check_in, check_out,
    price_total || null, price_paid || 0, payment_status || 'pending',
    payment_method || 'Efectivo', channel || 'whatsapp', notes || null
  ]);

  res.json({ success: true, id: result.rows[0].id });
});

// PUT actualizar reserva
router.put("/admin/reservations/:id", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const {
    room_id, guest_name, guest_email, guest_phone, guest_nationality,
    num_persons, check_in, check_out, price_total, price_paid,
    payment_status, payment_method, channel, notes
  } = req.body;

  if (check_in >= check_out) {
    return res.status(400).json({ error: "Check-out debe ser posterior al check-in" });
  }

  const current = await pool.query(`SELECT room_id FROM reservations WHERE id = $1`, [id]);
  const effectiveRoomId = room_id || current.rows[0]?.room_id;

  if (await checkOverlap(effectiveRoomId, check_in, check_out, id)) {
    return res.status(409).json({ error: "Ya existe una reserva en esa habitación para esas fechas" });
  }

  await pool.query(`
    UPDATE reservations SET
      guest_name=$1, guest_email=$2, guest_phone=$3, guest_nationality=$4,
      num_persons=$5, check_in=$6, check_out=$7, price_total=$8,
      price_paid=$9, payment_status=$10, payment_method=$11, channel=$12, notes=$13
    WHERE id=$14
  `, [
    guest_name, guest_email, guest_phone, guest_nationality,
    num_persons, check_in, check_out, price_total, price_paid,
    payment_status, payment_method || 'Efectivo', channel, notes, id
  ]);

  res.json({ success: true });
});

// DELETE reserva
router.delete("/admin/reservations/:id", authMiddleware, async (req: Request, res: Response) => {
  await pool.query(`DELETE FROM reservations WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

export default router;