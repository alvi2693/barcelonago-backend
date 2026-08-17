import { Router, Request, Response } from "express";
import { pool } from "../db";
import { requireAuth, cuentaDe } from "../auth";

const router = Router();

// ─────────────────────────────────────────────
// PANEL DEL CLIENTE
//
// Todo aquí filtra por la cuenta del token. Un cliente nunca ve
// ni toca datos de otra cuenta, ni siquiera equivocándose de id:
// cada endpoint comprueba la pertenencia antes de escribir.
// ─────────────────────────────────────────────

const soloRol = requireAuth("owner", "staff");

// Además del rol, comprueba que la cuenta del token sigue existiendo.
// Si se borró la cuenta, el token viejo sigue siendo válido para el
// JWT pero cualquier alta revienta con un fallo de clave ajena que no
// dice nada. Mejor un 401 claro que invite a volver a entrar.
async function auth(req: Request, res: Response, next: Function) {
  soloRol(req, res, async () => {
    try {
      const r = await pool.query(
        `SELECT 1 FROM accounts WHERE id = $1 AND active = true`, [cuentaDe(req)]
      );
      if (r.rows.length === 0) {
        return res.status(401).json({ error: "Tu sesión ya no es válida. Vuelve a entrar." });
      }
      next();
    } catch {
      res.status(500).json({ error: "No se pudo comprobar la sesión" });
    }
  });
}

// Comprueba que un piso es de la cuenta indicada.
async function pisoDeLaCuenta(propertyId: number, accountId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM properties WHERE id = $1 AND account_id = $2`,
    [propertyId, accountId]
  );
  return r.rows.length > 0;
}

// Comprueba que una habitación es de la cuenta indicada.
async function habitacionDeLaCuenta(roomId: number, accountId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM rooms rm
     JOIN properties p ON p.id = rm.property_id
     WHERE rm.id = $1 AND p.account_id = $2`,
    [roomId, accountId]
  );
  return r.rows.length > 0;
}

async function checkOverlap(room_id: number, check_in: string, check_out: string, excludeId?: number): Promise<boolean> {
  const query = excludeId
    ? `SELECT id FROM reservations WHERE room_id = $1 AND id != $2 AND check_in < $3 AND check_out > $4 AND COALESCE(no_show, false) = false`
    : `SELECT id FROM reservations WHERE room_id = $1 AND check_in < $2 AND check_out > $3 AND COALESCE(no_show, false) = false`;
  const params = excludeId ? [room_id, excludeId, check_out, check_in] : [room_id, check_out, check_in];
  const r = await pool.query(query, params);
  return r.rows.length > 0;
}

// ── Renta mensual ──
// A diferencia del panel de administración, aquí cualquier habitación
// puede alquilarse por meses: es el negocio del cliente, no el nuestro.

function esMensual(t?: string): boolean { return t === "monthly"; }

function primerDiaDelMes(fecha: string): string {
  const [y, m] = String(fecha).split("T")[0].split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function sumarMesesFecha(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  const ultimo = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(d, ultimo));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Una fila por mes. La primera vence el día de entrada; las siguientes,
// el día 1 de cada mes posterior.
async function generarMensualidades(accountId: number, reservationId: number, check_in: string, meses: number, importe: number) {
  const inicio = String(check_in).split("T")[0];
  for (let i = 0; i < meses; i++) {
    const periodo = i === 0 ? inicio : primerDiaDelMes(sumarMesesFecha(primerDiaDelMes(inicio), i));
    await pool.query(
      `INSERT INTO rent_payments (account_id, reservation_id, period_start, amount) VALUES ($1,$2,$3,$4)`,
      [accountId, reservationId, periodo, importe]
    );
  }
}

// En renta mensual, lo cobrado son la señal más las mensualidades pagadas.
async function recalcularMensual(reservationId: number) {
  const r = await pool.query(
    `SELECT price_total, deposit_amount FROM reservations WHERE id = $1`, [reservationId]
  );
  if (!r.rows[0]) return;
  const total = Number(r.rows[0].price_total) || 0;
  const dep = Number(r.rows[0].deposit_amount) || 0;

  const c = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS cobrado FROM rent_payments
     WHERE reservation_id = $1 AND paid_at IS NOT NULL`, [reservationId]
  );
  const cobrado = dep + (Number(c.rows[0].cobrado) || 0);

  await pool.query(
    `UPDATE reservations SET price_paid = $1, payment_status = $2 WHERE id = $3`,
    [cobrado, estadoPago(total, cobrado), reservationId]
  );
}

function estadoPago(total: number, cobrado: number): string {
  if (cobrado <= 0) return "pending";
  if (cobrado >= total) return "paid";
  return "partial";
}

// ─────────────────────────────────────────────
// CONFIGURACIÓN — una llamada al arrancar
// ─────────────────────────────────────────────

router.get("/client/config", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);

  const cuenta = await pool.query(
    `SELECT id, name, slug, currency FROM accounts WHERE id = $1`, [accountId]
  );

  const pisos = await pool.query(
    `SELECT id, code, name, color, address, sort_order
     FROM properties
     WHERE account_id = $1 AND archived = false
     ORDER BY sort_order, id`, [accountId]
  );

  const habitaciones = await pool.query(
    `SELECT rm.id, rm.property_id, rm.name, rm.room_type, rm.max_persons, rm.sort_order
     FROM rooms rm
     JOIN properties p ON p.id = rm.property_id
     WHERE p.account_id = $1 AND rm.archived = false
     ORDER BY rm.sort_order, rm.id`, [accountId]
  );

  const tarifas = await pool.query(
    `SELECT rt.id, rt.room_id, rt.label, rt.valid_from, rt.valid_to, rt.pax,
            rt.net_price, rt.min_net_price, rt.min_nights
     FROM room_rates rt
     JOIN rooms rm ON rm.id = rt.room_id
     JOIN properties p ON p.id = rm.property_id
     WHERE p.account_id = $1
     ORDER BY rt.room_id, rt.valid_from NULLS FIRST`, [accountId]
  );

  res.json({
    account: cuenta.rows[0] || null,
    properties: pisos.rows.map((p: any) => ({
      ...p,
      rooms: habitaciones.rows.filter((rm: any) => rm.property_id === p.id),
    })),
    rates: tarifas.rows.map((t: any) => ({
      ...t,
      net_price: Number(t.net_price) || 0,
      min_net_price: t.min_net_price === null ? null : Number(t.min_net_price),
      valid_from: t.valid_from ? String(t.valid_from).split("T")[0] : null,
      valid_to: t.valid_to ? String(t.valid_to).split("T")[0] : null,
    })),
  });
});

// ─────────────────────────────────────────────
// PISOS
// ─────────────────────────────────────────────

router.post("/client/properties", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "El piso necesita un nombre" });

  const r = await pool.query(
    `INSERT INTO properties (account_id, name, color, address, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM properties WHERE account_id = $1), 1))
     RETURNING id, name, color, address, sort_order`,
    [accountId, name, req.body?.color || "#3B82F6", req.body?.address || null]
  );
  res.json({ success: true, property: r.rows[0] });
});

router.put("/client/properties/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  if (!(await pisoDeLaCuenta(id, accountId))) return res.status(404).json({ error: "Piso no encontrado" });

  await pool.query(
    `UPDATE properties SET name = COALESCE($1, name), color = COALESCE($2, color), address = $3 WHERE id = $4`,
    [req.body?.name || null, req.body?.color || null, req.body?.address ?? null, id]
  );
  res.json({ success: true });
});

// No se borra: se archiva. Si hubiera reservas y se eliminara,
// quedarían apuntando a un piso inexistente.
router.delete("/client/properties/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  if (!(await pisoDeLaCuenta(id, accountId))) return res.status(404).json({ error: "Piso no encontrado" });

  await pool.query(`UPDATE properties SET archived = true WHERE id = $1`, [id]);
  await pool.query(`UPDATE rooms SET archived = true WHERE property_id = $1`, [id]);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// HABITACIONES
// ─────────────────────────────────────────────

router.post("/client/rooms", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const propertyId = Number(req.body?.property_id);
  const name = String(req.body?.name || "").trim();

  if (!propertyId || !name) return res.status(400).json({ error: "Faltan el piso o el nombre" });
  if (!(await pisoDeLaCuenta(propertyId, accountId))) return res.status(404).json({ error: "Piso no encontrado" });

  const r = await pool.query(
    `INSERT INTO rooms (property_id, name, room_type, max_persons, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM rooms WHERE property_id = $1), 1))
     RETURNING id, property_id, name, room_type, max_persons, sort_order`,
    [propertyId, name, req.body?.room_type || "double", Number(req.body?.max_persons) || 2]
  );
  res.json({ success: true, room: r.rows[0] });
});

router.put("/client/rooms/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  if (!(await habitacionDeLaCuenta(id, accountId))) return res.status(404).json({ error: "Habitación no encontrada" });

  await pool.query(
    `UPDATE rooms SET name = COALESCE($1, name), room_type = COALESCE($2, room_type),
            max_persons = COALESCE($3, max_persons)
     WHERE id = $4`,
    [req.body?.name || null, req.body?.room_type || null,
     req.body?.max_persons ? Number(req.body.max_persons) : null, id]
  );
  res.json({ success: true });
});

router.delete("/client/rooms/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  if (!(await habitacionDeLaCuenta(id, accountId))) return res.status(404).json({ error: "Habitación no encontrada" });

  const conReservas = await pool.query(`SELECT 1 FROM reservations WHERE room_id = $1 LIMIT 1`, [id]);
  if (conReservas.rows.length > 0) {
    await pool.query(`UPDATE rooms SET archived = true WHERE id = $1`, [id]);
    return res.json({ success: true, archivada: true });
  }
  await pool.query(`DELETE FROM rooms WHERE id = $1`, [id]);
  res.json({ success: true, archivada: false });
});

// ─────────────────────────────────────────────
// TARIFAS — precio neto que quiere recibir
// ─────────────────────────────────────────────

router.post("/client/rates", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const roomId = Number(req.body?.room_id);
  if (!(await habitacionDeLaCuenta(roomId, accountId))) return res.status(404).json({ error: "Habitación no encontrada" });

  const neto = Number(req.body?.net_price);
  if (!(neto > 0)) return res.status(400).json({ error: "El precio tiene que ser mayor que cero" });

  const r = await pool.query(
    `INSERT INTO room_rates (room_id, label, valid_from, valid_to, pax, net_price, min_net_price, min_nights, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      roomId,
      req.body?.label || null,
      req.body?.valid_from || null,
      req.body?.valid_to || null,
      req.body?.pax ? Number(req.body.pax) : null,
      neto,
      req.body?.min_net_price ? Number(req.body.min_net_price) : null,
      Number(req.body?.min_nights) || 1,
      req.body?.notes || null,
    ]
  );
  res.json({ success: true, id: r.rows[0].id });
});

router.put("/client/rates/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  const chk = await pool.query(
    `SELECT rt.id FROM room_rates rt
     JOIN rooms rm ON rm.id = rt.room_id
     JOIN properties p ON p.id = rm.property_id
     WHERE rt.id = $1 AND p.account_id = $2`, [id, accountId]
  );
  if (!chk.rows[0]) return res.status(404).json({ error: "Tarifa no encontrada" });

  await pool.query(
    `UPDATE room_rates SET label = $1, valid_from = $2, valid_to = $3, pax = $4,
            net_price = COALESCE($5, net_price), min_net_price = $6,
            min_nights = COALESCE($7, min_nights), notes = $8
     WHERE id = $9`,
    [
      req.body?.label || null,
      req.body?.valid_from || null,
      req.body?.valid_to || null,
      req.body?.pax ? Number(req.body.pax) : null,
      req.body?.net_price ? Number(req.body.net_price) : null,
      req.body?.min_net_price ? Number(req.body.min_net_price) : null,
      req.body?.min_nights ? Number(req.body.min_nights) : null,
      req.body?.notes || null,
      id,
    ]
  );
  res.json({ success: true });
});

router.delete("/client/rates/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  const r = await pool.query(
    `DELETE FROM room_rates rt
     USING rooms rm, properties p
     WHERE rt.id = $1 AND rm.id = rt.room_id AND p.id = rm.property_id AND p.account_id = $2`,
    [id, accountId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Tarifa no encontrada" });
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// RESERVAS — solo las de su cuenta
// ─────────────────────────────────────────────

router.get("/client/reservations", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const r = await pool.query(
    `SELECT id, room_id, room_name, guest_name, guest_phone, guest_nationality,
            num_persons, check_in, check_out, price_total, price_per_night,
            price_paid, payment_status, deposit_amount, deposit_method,
            checkin_amount, checkin_method, channel, notes, no_show,
            rental_type, monthly_rate, created_at
     FROM reservations
     WHERE account_id = $1
     ORDER BY check_in ASC`, [accountId]
  );
  res.json(r.rows);
});

router.post("/client/reservations", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const {
    room_id, guest_name, guest_phone, guest_nationality, num_persons,
    check_in, check_out, price_total, price_per_night,
    deposit_amount, deposit_method, checkin_amount, checkin_method, channel, notes,
    rental_type, monthly_rate, months_count,
  } = req.body;

  const roomId = Number(room_id);
  if (!roomId || !guest_name || !check_in || !check_out)
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  if (check_in >= check_out)
    return res.status(400).json({ error: "La salida debe ser posterior a la entrada" });

  // Sin esta comprobación, un cliente podría reservar en una
  // habitación de otra cuenta mandando su id a mano.
  if (!(await habitacionDeLaCuenta(roomId, accountId)))
    return res.status(404).json({ error: "Habitación no encontrada" });

  if (await checkOverlap(roomId, check_in, check_out))
    return res.status(409).json({ error: "Esa habitación ya está ocupada en esas fechas" });

  const nombre = await pool.query(
    `SELECT p.name AS piso, rm.name AS hab FROM rooms rm
     JOIN properties p ON p.id = rm.property_id WHERE rm.id = $1`, [roomId]
  );
  const roomName = nombre.rows[0] ? `${nombre.rows[0].piso} - ${nombre.rows[0].hab}` : "";

  const mensual = esMensual(rental_type);
  const meses = mensual ? Math.max(1, Number(months_count) || 1) : 0;
  const importeMes = mensual ? Number(monthly_rate) || 0 : 0;

  const dep = Number(deposit_amount) || 0;
  // En renta mensual no hay pago al entrar: lo marcan las mensualidades.
  const chk = mensual ? 0 : Number(checkin_amount) || 0;
  const total = mensual ? importeMes * meses : Number(price_total) || 0;
  const cobrado = dep + chk;

  const r = await pool.query(
    `INSERT INTO reservations (
       account_id, room_id, room_name, guest_name, guest_phone, guest_nationality,
       num_persons, check_in, check_out, price_total, price_per_night,
       deposit_amount, deposit_method, checkin_amount, checkin_method,
       price_paid, payment_status, channel, notes, no_show,
       rental_type, monthly_rate
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,false,$20,$21)
     RETURNING id`,
    [
      accountId, roomId, roomName, guest_name, guest_phone || null, guest_nationality || null,
      Number(num_persons) || 1, check_in, check_out,
      total || null, mensual ? null : price_per_night || null,
      dep, deposit_method || "Transferencia",
      chk, checkin_method || "Efectivo",
      cobrado, estadoPago(total, cobrado), channel || "Directo", notes || null,
      mensual ? "monthly" : "nightly", mensual ? importeMes : null,
    ]
  );

  const nuevaId = r.rows[0].id;
  if (mensual) await generarMensualidades(accountId, nuevaId, check_in, meses, importeMes);

  res.json({ success: true, id: nuevaId });
});

router.put("/client/reservations/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);

  const actual = await pool.query(
    `SELECT room_id, rental_type FROM reservations WHERE id = $1 AND account_id = $2`, [id, accountId]
  );
  if (!actual.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });

  const {
    room_id, guest_name, guest_phone, guest_nationality, num_persons,
    check_in, check_out, price_total, price_per_night,
    deposit_amount, deposit_method, checkin_amount, checkin_method, channel, notes,
  } = req.body;

  const roomId = Number(room_id) || actual.rows[0].room_id;
  if (check_in >= check_out)
    return res.status(400).json({ error: "La salida debe ser posterior a la entrada" });
  if (!(await habitacionDeLaCuenta(roomId, accountId)))
    return res.status(404).json({ error: "Habitación no encontrada" });
  if (await checkOverlap(roomId, check_in, check_out, id))
    return res.status(409).json({ error: "Esa habitación ya está ocupada en esas fechas" });

  const nombre = await pool.query(
    `SELECT p.name AS piso, rm.name AS hab FROM rooms rm
     JOIN properties p ON p.id = rm.property_id WHERE rm.id = $1`, [roomId]
  );
  const roomName = nombre.rows[0] ? `${nombre.rows[0].piso} - ${nombre.rows[0].hab}` : "";

  const eraMensual = esMensual(actual.rows[0].rental_type);
  const dep = Number(deposit_amount) || 0;
  const chk = eraMensual ? 0 : Number(checkin_amount) || 0;
  const total = Number(price_total) || 0;

  // Si es mensual, lo cobrado lo mandan las mensualidades: recalcular
  // aquí borraría los cobros ya marcados.
  let cobrado = dep + chk;
  if (eraMensual) {
    const c = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS cobrado FROM rent_payments
       WHERE reservation_id = $1 AND paid_at IS NOT NULL`, [id]
    );
    cobrado = dep + (Number(c.rows[0].cobrado) || 0);
  }

  await pool.query(
    `UPDATE reservations SET
       room_id=$1, room_name=$2, guest_name=$3, guest_phone=$4, guest_nationality=$5,
       num_persons=$6, check_in=$7, check_out=$8, price_total=$9, price_per_night=$10,
       deposit_amount=$11, deposit_method=$12, checkin_amount=$13, checkin_method=$14,
       price_paid=$15, payment_status=$16, channel=$17, notes=$18
     WHERE id=$19 AND account_id=$20`,
    [
      roomId, roomName, guest_name, guest_phone || null, guest_nationality || null,
      Number(num_persons) || 1, check_in, check_out,
      total || null, price_per_night || null,
      dep, deposit_method || "Transferencia",
      chk, checkin_method || "Efectivo",
      cobrado, estadoPago(total, cobrado), channel || "Directo", notes || null,
      id, accountId,
    ]
  );
  res.json({ success: true });
});

router.delete("/client/reservations/:id", auth, async (req: Request, res: Response) => {
  const r = await pool.query(
    `DELETE FROM reservations WHERE id = $1 AND account_id = $2`,
    [Number(req.params.id), cuentaDe(req)]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Reserva no encontrada" });
  res.json({ success: true });
});

// El huésped no vino: se conserva lo cobrado y se libera la habitación.
router.patch("/client/reservations/:id/no-show", auth, async (req: Request, res: Response) => {
  const r = await pool.query(
    `UPDATE reservations SET no_show = true, payment_status = 'paid'
     WHERE id = $1 AND account_id = $2`,
    [Number(req.params.id), cuentaDe(req)]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Reserva no encontrada" });
  res.json({ success: true });
});

router.patch("/client/reservations/:id/undo-no-show", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  const r = await pool.query(
    `SELECT room_id, check_in, check_out, price_total, price_paid
     FROM reservations WHERE id = $1 AND account_id = $2`, [id, accountId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });

  const row = r.rows[0];
  const ci = String(row.check_in).split("T")[0];
  const co = String(row.check_out).split("T")[0];
  if (await checkOverlap(row.room_id, ci, co, id))
    return res.status(409).json({ error: "Esas fechas ya están ocupadas por otra reserva" });

  await pool.query(
    `UPDATE reservations SET no_show = false, payment_status = $1 WHERE id = $2`,
    [estadoPago(Number(row.price_total) || 0, Number(row.price_paid) || 0), id]
  );
  res.json({ success: true });
});

// Registrar un cobro sin abrir toda la ficha
router.patch("/client/reservations/:id/payment", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  const r = await pool.query(
    `SELECT price_total, deposit_amount FROM reservations WHERE id = $1 AND account_id = $2`,
    [id, accountId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });

  const total = Number(r.rows[0].price_total) || 0;
  const dep = Number(r.rows[0].deposit_amount) || 0;
  const chk = Number(req.body?.checkin_amount) || 0;
  const cobrado = dep + chk;

  await pool.query(
    `UPDATE reservations SET checkin_amount = $1, checkin_method = $2,
            price_paid = $3, payment_status = $4
     WHERE id = $5`,
    [chk, req.body?.checkin_method || "Efectivo", cobrado, estadoPago(total, cobrado), id]
  );
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// MENSUALIDADES
// ─────────────────────────────────────────────

router.get("/client/rent-payments", auth, async (req: Request, res: Response) => {
  const r = await pool.query(
    `SELECT rp.id, rp.reservation_id, rp.period_start, rp.amount, rp.paid_at, rp.method,
            res.guest_name, res.room_id, res.room_name
     FROM rent_payments rp
     JOIN reservations res ON res.id = rp.reservation_id
     WHERE res.account_id = $1
     ORDER BY rp.period_start ASC`,
    [cuentaDe(req)]
  );
  res.json(r.rows);
});

// Comprueba que la mensualidad pertenece a la cuenta antes de tocarla.
async function mensualidadDeLaCuenta(id: number, accountId: number): Promise<number | null> {
  const r = await pool.query(
    `SELECT rp.reservation_id FROM rent_payments rp
     JOIN reservations res ON res.id = rp.reservation_id
     WHERE rp.id = $1 AND res.account_id = $2`, [id, accountId]
  );
  return r.rows[0] ? Number(r.rows[0].reservation_id) : null;
}

router.patch("/client/rent-payments/:id/pay", auth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const resId = await mensualidadDeLaCuenta(id, cuentaDe(req));
  if (!resId) return res.status(404).json({ error: "Mensualidad no encontrada" });

  await pool.query(`
    UPDATE rent_payments
    SET paid_at = COALESCE($1::date, CURRENT_DATE),
        method  = $2,
        amount  = COALESCE($3, amount)
    WHERE id = $4
  `, [
    req.body?.paid_at || null,
    req.body?.method || "Efectivo",
    req.body?.amount !== undefined && req.body?.amount !== null && req.body?.amount !== "" ? Number(req.body.amount) : null,
    id,
  ]);

  await recalcularMensual(resId);
  res.json({ success: true });
});

router.patch("/client/rent-payments/:id/unpay", auth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const resId = await mensualidadDeLaCuenta(id, cuentaDe(req));
  if (!resId) return res.status(404).json({ error: "Mensualidad no encontrada" });

  await pool.query(`UPDATE rent_payments SET paid_at = NULL, method = NULL WHERE id = $1`, [id]);
  await recalcularMensual(resId);
  res.json({ success: true });
});

// El inquilino prorroga un mes más.
router.post("/client/reservations/:id/extend-month", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);

  const r = await pool.query(
    `SELECT room_id, check_out, monthly_rate, rental_type
     FROM reservations WHERE id = $1 AND account_id = $2`, [id, accountId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });
  if (!esMensual(r.rows[0].rental_type))
    return res.status(400).json({ error: "Esta reserva no es de renta mensual" });

  const co = String(r.rows[0].check_out).split("T")[0];
  const nuevoCheckOut = sumarMesesFecha(co, 1);

  if (await checkOverlap(r.rows[0].room_id, co, nuevoCheckOut, id))
    return res.status(409).json({ error: "El mes siguiente ya está ocupado por otra reserva" });

  const importe = Number(req.body?.monthly_rate) || Number(r.rows[0].monthly_rate) || 0;

  await pool.query(
    `INSERT INTO rent_payments (account_id, reservation_id, period_start, amount) VALUES ($1,$2,$3,$4)`,
    [accountId, id, primerDiaDelMes(co), importe]
  );
  await pool.query(
    `UPDATE reservations SET check_out = $1, price_total = COALESCE(price_total, 0) + $2 WHERE id = $3`,
    [nuevoCheckOut, importe, id]
  );
  await recalcularMensual(id);

  res.json({ success: true, check_out: nuevoCheckOut });
});

// ─────────────────────────────────────────────
// GASTOS
//
// La tabla expenses viene del panel antiguo y exige property_id y
// property_name como texto. Para las cuentas nuevas se rellenan a
// partir del piso real, y property_ref guarda el enlace de verdad.
// ─────────────────────────────────────────────

router.get("/client/expenses", auth, async (req: Request, res: Response) => {
  const r = await pool.query(
    `SELECT e.id, e.property_ref, e.category, e.description, e.amount, e.date,
            e.payment_method, e.paid_by, e.own_money, e.reimbursed_at, p.name AS property_name
     FROM expenses e
     LEFT JOIN properties p ON p.id = e.property_ref
     WHERE e.account_id = $1
     ORDER BY e.date DESC, e.id DESC`,
    [cuentaDe(req)]
  );
  res.json(r.rows);
});

router.post("/client/expenses", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const propertyRef = Number(req.body?.property_ref);
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || "").trim();

  if (!propertyRef || !description || !(amount > 0) || !req.body?.date)
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  if (!(await pisoDeLaCuenta(propertyRef, accountId)))
    return res.status(404).json({ error: "Piso no encontrado" });

  const piso = await pool.query(`SELECT name FROM properties WHERE id = $1`, [propertyRef]);
  const nombrePiso = piso.rows[0]?.name || "Piso";

  const r = await pool.query(
    `INSERT INTO expenses (account_id, property_id, property_name, property_ref,
                           category, description, amount, date, payment_method, own_money)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)
     RETURNING id`,
    [
      accountId, String(propertyRef), nombrePiso, propertyRef,
      req.body?.category || "Otros", description, amount, req.body.date,
      req.body?.payment_method || "Efectivo",
    ]
  );
  res.json({ success: true, id: r.rows[0].id });
});

router.put("/client/expenses/:id", auth, async (req: Request, res: Response) => {
  const accountId = cuentaDe(req);
  const id = Number(req.params.id);
  const propertyRef = Number(req.body?.property_ref);

  const actual = await pool.query(
    `SELECT id FROM expenses WHERE id = $1 AND account_id = $2`, [id, accountId]
  );
  if (!actual.rows[0]) return res.status(404).json({ error: "Gasto no encontrado" });
  if (propertyRef && !(await pisoDeLaCuenta(propertyRef, accountId)))
    return res.status(404).json({ error: "Piso no encontrado" });

  const piso = await pool.query(`SELECT name FROM properties WHERE id = $1`, [propertyRef]);
  const nombrePiso = piso.rows[0]?.name || "Piso";

  await pool.query(
    `UPDATE expenses SET property_id=$1, property_name=$2, property_ref=$3,
            category=$4, description=$5, amount=$6, date=$7, payment_method=$8
     WHERE id=$9 AND account_id=$10`,
    [
      String(propertyRef), nombrePiso, propertyRef,
      req.body?.category || "Otros", req.body?.description, Number(req.body?.amount) || 0,
      req.body?.date, req.body?.payment_method || "Efectivo", id, accountId,
    ]
  );
  res.json({ success: true });
});

router.delete("/client/expenses/:id", auth, async (req: Request, res: Response) => {
  const r = await pool.query(
    `DELETE FROM expenses WHERE id = $1 AND account_id = $2`,
    [Number(req.params.id), cuentaDe(req)]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Gasto no encontrado" });
  res.json({ success: true });
});

export default router;