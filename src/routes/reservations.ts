import { Router, Request, Response } from "express";
import { db } from "../db";

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
  if (token === expected) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}

// Verificar solapamiento de fechas
function checkOverlap(room_id: number, check_in: string, check_out: string, excludeId?: number): boolean {
  const query = excludeId
    ? `SELECT id FROM reservations WHERE room_id = ? AND id != ? AND check_in < ? AND check_out > ?`
    : `SELECT id FROM reservations WHERE room_id = ? AND check_in < ? AND check_out > ?`;

  const params = excludeId
    ? [room_id, excludeId, check_out, check_in]
    : [room_id, check_out, check_in];

  const existing = db.prepare(query).get(...params as [any]);
  return !!existing;
}

// GET todas las reservas
router.get("/admin/reservations", authMiddleware, (_req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM reservations ORDER BY check_in ASC`).all();
  res.json(rows);
});

// GET reservas por habitación
router.get("/admin/reservations/room/:roomId", authMiddleware, (req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM reservations WHERE room_id = ? ORDER BY check_in ASC`).all(req.params.roomId);
  res.json(rows);
});

// POST crear reserva
router.post("/admin/reservations", authMiddleware, (req: Request, res: Response) => {
  const {
    room_id, room_name, guest_name, guest_email, guest_phone,
    guest_nationality, num_persons, check_in, check_out,
    price_total, price_paid, payment_status, channel, notes
  } = req.body;

  if (!room_id || !guest_name || !check_in || !check_out) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (check_in >= check_out) {
    return res.status(400).json({ error: "Check-out debe ser posterior al check-in" });
  }

  if (checkOverlap(room_id, check_in, check_out)) {
    return res.status(409).json({ error: "Ya existe una reserva en esa habitación para esas fechas" });
  }

  const result = db.prepare(`
    INSERT INTO reservations (
      room_id, room_name, guest_name, guest_email, guest_phone,
      guest_nationality, num_persons, check_in, check_out,
      price_total, price_paid, payment_status, payment_method, channel, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    room_id, room_name, guest_name, guest_email || null, guest_phone || null,
    guest_nationality || null, num_persons || 1, check_in, check_out,
    price_total || null, price_paid || 0, payment_status || "pending",
    req.body.payment_method || "Efectivo", channel || "whatsapp", notes || null
  );

  res.json({ success: true, id: result.lastInsertRowid });
});

// PUT actualizar reserva
router.put("/admin/reservations/:id", authMiddleware, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const {
    room_id, guest_name, guest_email, guest_phone, guest_nationality,
    num_persons, check_in, check_out, price_total, price_paid,
    payment_status, channel, notes
  } = req.body;

  if (check_in >= check_out) {
    return res.status(400).json({ error: "Check-out debe ser posterior al check-in" });
  }

  // Obtener room_id actual si no viene en el body
  const current = db.prepare(`SELECT room_id FROM reservations WHERE id = ?`).get(id) as any;
  const effectiveRoomId = room_id || current?.room_id;

  if (checkOverlap(effectiveRoomId, check_in, check_out, id)) {
    return res.status(409).json({ error: "Ya existe una reserva en esa habitación para esas fechas" });
  }

  db.prepare(`
    UPDATE reservations SET
      guest_name = ?, guest_email = ?, guest_phone = ?,
      guest_nationality = ?, num_persons = ?, check_in = ?,
      check_out = ?, price_total = ?, price_paid = ?,
      payment_status = ?, payment_method = ?, channel = ?, notes = ?
    WHERE id = ?
  `).run(
    guest_name, guest_email, guest_phone, guest_nationality,
    num_persons, check_in, check_out, price_total, price_paid,
    payment_status, req.body.payment_method || "Efectivo", channel, notes, id
  );

  res.json({ success: true });
});

// DELETE reserva
router.delete("/admin/reservations/:id", authMiddleware, (req: Request, res: Response) => {
  db.prepare("DELETE FROM reservations WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

export default router;