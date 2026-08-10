import { Router, Request, Response } from "express";
import { pool } from "../db";
import { sendToAll } from "./notifications";

const router = Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bcnrooms2024";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "sagrada2026";
// Colaborador que busca clientes: solo ve el calendario y crea reservas.
const CALENDAR_PASSWORD = process.env.CALENDAR_PASSWORD || "bcnroom2026";

// Piso gestionado para un tercero (no es nuestro).
const MANAGED_ROOM_IDS = [7]; // Sagrada Família
const DEFAULT_COMMISSION_PER_PAX_NIGHT = 4;

// Solo las medianas del Born admiten renta mensual.
// Hab. 3, Hab. 4 y Hab. 5 del Born.
const MONTHLY_ROOM_IDS = [2, 3, 4];

router.post("/admin/login", (req: Request, res: Response) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD).toString("base64") });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Login separado para el propietario de Sagrada Família (solo lectura)
router.post("/owner/login", (req: Request, res: Response) => {
  const { password } = req.body;
  if (password === OWNER_PASSWORD) {
    res.json({ success: true, token: Buffer.from(OWNER_PASSWORD).toString("base64") });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Login del colaborador que gestiona el calendario.
router.post("/calendar/login", (req: Request, res: Response) => {
  const { password } = req.body;
  if (password === CALENDAR_PASSWORD) {
    res.json({ success: true, token: Buffer.from(CALENDAR_PASSWORD).toString("base64") });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

function authMiddleware(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expected = Buffer.from(ADMIN_PASSWORD).toString("base64");
  if (token === expected) next();
  else res.status(401).json({ error: "Unauthorized" });
}

// Solo permite el token del propietario. NO da acceso a otros pisos.
function ownerAuthMiddleware(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expected = Buffer.from(OWNER_PASSWORD).toString("base64");
  if (token === expected) next();
  else res.status(401).json({ error: "Unauthorized" });
}

// Acepta el token del colaborador o el del admin, para que el admin
// pueda abrir /calendario sin volver a autenticarse.
function calendarAuthMiddleware(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const calendario = Buffer.from(CALENDAR_PASSWORD).toString("base64");
  const admin = Buffer.from(ADMIN_PASSWORD).toString("base64");
  if (token === calendario || token === admin) next();
  else res.status(401).json({ error: "Unauthorized" });
}

// Las reservas marcadas como "no vino" liberan la habitación: no bloquean
// esas fechas, aunque la fila siga existiendo para conservar el ingreso.
async function checkOverlap(room_id: number, check_in: string, check_out: string, excludeId?: number): Promise<boolean> {
  const query = excludeId
    ? `SELECT id FROM reservations WHERE room_id = $1 AND id != $2 AND check_in < $3 AND check_out > $4 AND COALESCE(no_show, false) = false`
    : `SELECT id FROM reservations WHERE room_id = $1 AND check_in < $2 AND check_out > $3 AND COALESCE(no_show, false) = false`;
  const params = excludeId ? [room_id, excludeId, check_out, check_in] : [room_id, check_out, check_in];
  const result = await pool.query(query, params);
  return result.rows.length > 0;
}

function calcPaymentStatus(price_total: number, deposit: number, checkin: number): string {
  const total_paid = deposit + checkin;
  if (total_paid <= 0) return 'pending';
  if (total_paid >= price_total) return 'paid';
  return 'partial';
}

// Fecha corta para el cuerpo de las notificaciones.
function fmtDiaMes(fecha: string): string {
  const d = new Date(String(fecha).split("T")[0] + "T00:00:00");
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

// Comisión sugerida al crear una reserva de piso gestionado.
// Es solo un valor por defecto: el admin puede editarlo y se guarda el real.
function suggestCommission(room_id: number, num_persons: number, check_in: string, check_out: string): number {
  if (!MANAGED_ROOM_IDS.includes(Number(room_id))) return 0;
  const nights = Math.max(
    0,
    Math.round((new Date(check_out).getTime() - new Date(check_in).getTime()) / 86400000)
  );
  return DEFAULT_COMMISSION_PER_PAX_NIGHT * (Number(num_persons) || 1) * nights;
}

// ── Renta mensual ──

function esMensual(rental_type?: string): boolean {
  return rental_type === 'monthly';
}

// Primer día del mes de una fecha dada, en formato YYYY-MM-DD.
function primerDiaDelMes(fecha: string): string {
  const [y, m] = String(fecha).split("T")[0].split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function sumarMeses(fechaYMD: string, n: number): string {
  const [y, m, d] = fechaYMD.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Crea una fila por mensualidad. La primera vence el día del check-in,
// las siguientes el día 1 de cada mes posterior.
async function generarMensualidades(reservationId: number, check_in: string, meses: number, importeMes: number) {
  const inicio = String(check_in).split("T")[0];
  for (let i = 0; i < meses; i++) {
    const periodo = i === 0 ? inicio : primerDiaDelMes(sumarMeses(primerDiaDelMes(inicio), i));
    await pool.query(
      `INSERT INTO rent_payments (reservation_id, period_start, amount) VALUES ($1, $2, $3)`,
      [reservationId, periodo, importeMes]
    );
  }
}

// price_paid de una reserva mensual = señal + mensualidades ya cobradas.
async function recalcularPagosMensuales(reservationId: number) {
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
  const cobrado = Number(c.rows[0].cobrado) || 0;
  const price_paid = dep + cobrado;

  await pool.query(
    `UPDATE reservations SET price_paid = $1, payment_status = $2 WHERE id = $3`,
    [price_paid, calcPaymentStatus(total, price_paid, 0), reservationId]
  );
}

router.get("/admin/reservations", authMiddleware, async (_req: Request, res: Response) => {
  const result = await pool.query(`SELECT * FROM reservations ORDER BY check_in ASC`);
  res.json(result.rows);
});

router.get("/admin/reservations/room/:roomId", authMiddleware, async (req: Request, res: Response) => {
  const result = await pool.query(`SELECT * FROM reservations WHERE room_id = $1 ORDER BY check_in ASC`, [req.params.roomId]);
  res.json(result.rows);
});

// ─────────────────────────────────────────────
// VISTA DEL PROPIETARIO — solo Sagrada Família
// Nunca expone otros pisos ni nuestras cuentas.
// ─────────────────────────────────────────────
router.get("/owner/reservations", ownerAuthMiddleware, async (_req: Request, res: Response) => {
  const result = await pool.query(`
    SELECT
      id, guest_name, guest_nationality, num_persons,
      check_in, check_out, price_total,
      commission_amount, collected_by_us, channel, settled_at,
      (check_out - check_in) AS nights
    FROM reservations
    WHERE room_id = ANY($1::int[])
    ORDER BY check_in ASC
  `, [MANAGED_ROOM_IDS]);

  const rows = result.rows.map((r: any) => {
    const priceTotal = Number(r.price_total) || 0;
    const commission = Number(r.commission_amount) || 0;
    return {
      ...r,
      price_total: priceTotal,
      commission_amount: commission,
      // Lo que le corresponde al propietario
      owner_income: priceTotal - commission,
    };
  });

  res.json(rows);
});

// ─────────────────────────────────────────────
// VISTA DEL COLABORADOR — solo calendario
// Columnas explícitas: nunca precios de reservas ajenas, pagos,
// comisiones ni contacto. Lo que no sale de la consulta no se puede
// filtrar desde el navegador.
// ─────────────────────────────────────────────
router.get("/calendar/reservations", calendarAuthMiddleware, async (_req: Request, res: Response) => {
  const result = await pool.query(`
    SELECT id, room_id, room_name, guest_name, num_persons, check_in, check_out
    FROM reservations
    ORDER BY check_in ASC
  `);
  res.json(result.rows);
});

// Crear reserva. El colaborador pone el precio acordado y la señal que haya
// cobrado al cerrar el trato. Lo que NO puede tocar es el pago al ingresar:
// ese lo registra el admin cuando el huésped llega.
router.post("/calendar/reservations", calendarAuthMiddleware, async (req: Request, res: Response) => {
  const {
    room_id, room_name, guest_name, guest_phone, guest_nationality,
    num_persons, check_in, check_out, price_total, price_per_night,
    deposit_amount, deposit_method, channel, notes
  } = req.body;

  if (!room_id || !guest_name || !check_in || !check_out)
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  if (check_in >= check_out)
    return res.status(400).json({ error: "Check-out debe ser posterior al check-in" });
  if (await checkOverlap(room_id, check_in, check_out))
    return res.status(409).json({ error: "Ya existe una reserva en esa habitación para esas fechas" });

  const total = Number(price_total) || 0;
  const dep = Number(deposit_amount) || 0;
  // El pago al ingresar siempre entra a 0: no es cosa del colaborador.
  const payment_status = calcPaymentStatus(total, dep, 0);
  const commission = suggestCommission(room_id, num_persons, check_in, check_out);

  const result = await pool.query(`
    INSERT INTO reservations (
      room_id, room_name, guest_name, guest_phone, guest_nationality,
      num_persons, check_in, check_out, price_total, price_per_night,
      deposit_amount, deposit_method, checkin_amount, checkin_method,
      price_paid, payment_status, channel, notes,
      commission_amount, collected_by_us
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,'Efectivo',$13,$14,$15,$16,$17,false)
    RETURNING id
  `, [
    room_id, room_name, guest_name, guest_phone || null, guest_nationality || null,
    num_persons || 1, check_in, check_out,
    total || null, price_per_night || null,
    dep, deposit_method || 'Transferencia',
    dep, payment_status,
    channel || 'WhatsApp',
    notes ? `[Colaborador] ${notes}` : '[Creada por el colaborador]',
    commission,
  ]);

  // Aviso push, sin bloquear la respuesta ni romperla si el envío falla.
  const detalle = total > 0
    ? `${total}€${dep > 0 ? ` · señal ${dep}€ (${deposit_method || 'Transferencia'})` : ' · sin señal'}`
    : 'sin precio';
  sendToAll({
    title: `Reserva del colaborador · ${guest_name}`,
    body: `${room_name || 'Habitación'} · ${fmtDiaMes(check_in)} → ${fmtDiaMes(check_out)} · ${detalle}`,
    url: '/admin',
  }).catch(() => {});

  res.json({ success: true, id: result.rows[0].id });
});

router.post("/admin/reservations", authMiddleware, async (req: Request, res: Response) => {
  const {
    room_id, room_name, guest_name, guest_email, guest_phone, guest_nationality,
    num_persons, check_in, check_out, price_total, price_per_night,
    deposit_amount, deposit_method, checkin_amount, checkin_method, channel, notes,
    commission_amount, collected_by_us,
    rental_type, monthly_rate, months_count
  } = req.body;

  if (!room_id || !guest_name || !check_in || !check_out)
    return res.status(400).json({ error: "Missing required fields" });
  if (check_in >= check_out)
    return res.status(400).json({ error: "Check-out debe ser posterior al check-in" });
  if (await checkOverlap(room_id, check_in, check_out))
    return res.status(409).json({ error: "Ya existe una reserva en esa habitación para esas fechas" });

  const mensual = esMensual(rental_type);
  if (mensual && !MONTHLY_ROOM_IDS.includes(Number(room_id)))
    return res.status(400).json({ error: "La renta mensual solo está disponible en las habitaciones medianas del Born" });

  const meses = mensual ? Math.max(1, Number(months_count) || 1) : 0;
  const importeMes = mensual ? Number(monthly_rate) || 0 : 0;

  const dep = Number(deposit_amount) || 0;
  const chk = mensual ? 0 : Number(checkin_amount) || 0;
  // En renta mensual el total lo marcan las mensualidades, no el precio por noche.
  const total = mensual ? importeMes * meses : Number(price_total) || 0;
  // Las mensualidades arrancan sin cobrar: solo cuenta la señal.
  const price_paid = dep + chk;
  const payment_status = calcPaymentStatus(total, dep, chk);

  // Si el front no manda comisión, la sugerimos. Si la manda (aunque sea 0), respetamos su valor.
  const commission = commission_amount !== undefined && commission_amount !== null && commission_amount !== ''
    ? Number(commission_amount) || 0
    : suggestCommission(room_id, num_persons, check_in, check_out);

  const collected = collected_by_us === true || collected_by_us === 'true';

  const result = await pool.query(`
    INSERT INTO reservations (
      room_id, room_name, guest_name, guest_email, guest_phone, guest_nationality,
      num_persons, check_in, check_out, price_total, price_per_night,
      deposit_amount, deposit_method, checkin_amount, checkin_method,
      price_paid, payment_status, channel, notes,
      commission_amount, collected_by_us,
      rental_type, monthly_rate
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    RETURNING id
  `, [
    room_id, room_name, guest_name, guest_email || null, guest_phone || null,
    guest_nationality || null, num_persons || 1, check_in, check_out,
    total || null, mensual ? null : price_per_night || null,
    dep, deposit_method || 'Transferencia',
    chk, checkin_method || 'Efectivo',
    price_paid, payment_status, channel || 'whatsapp', notes || null,
    commission, collected,
    mensual ? 'monthly' : 'nightly', mensual ? importeMes : null
  ]);

  const nuevaId = result.rows[0].id;
  if (mensual) await generarMensualidades(nuevaId, check_in, meses, importeMes);

  // Aviso push. No bloquea la respuesta ni la rompe si el envío falla.
  const nochesRes = Math.max(0, Math.round(
    (new Date(check_out).getTime() - new Date(check_in).getTime()) / 86400000
  ));
  const resumen = mensual
    ? `${meses} ${meses === 1 ? 'mes' : 'meses'} · ${importeMes}€/mes`
    : `${nochesRes} ${nochesRes === 1 ? 'noche' : 'noches'} · ${total > 0 ? `${total}€` : 'sin precio'}`;
  sendToAll({
    title: `Nueva reserva · ${guest_name}`,
    body: `${room_name || 'Habitación'} · ${fmtDiaMes(check_in)} → ${fmtDiaMes(check_out)} · ${resumen}`,
    url: '/admin',
  }).catch(() => {});

  res.json({ success: true, id: nuevaId });
});

router.put("/admin/reservations/:id", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const {
    room_id, room_name, guest_name, guest_email, guest_phone, guest_nationality,
    num_persons, check_in, check_out, price_total, price_per_night,
    deposit_amount, deposit_method, checkin_amount, checkin_method, channel, notes,
    commission_amount, collected_by_us
  } = req.body;

  if (check_in >= check_out)
    return res.status(400).json({ error: "Check-out debe ser posterior al check-in" });

  const current = await pool.query(`SELECT room_id, rental_type FROM reservations WHERE id = $1`, [id]);
  const effectiveRoomId = room_id || current.rows[0]?.room_id;

  if (await checkOverlap(effectiveRoomId, check_in, check_out, id))
    return res.status(409).json({ error: "Ya existe una reserva en esa habitación para esas fechas" });

  const dep = Number(deposit_amount) || 0;
  const chk = Number(checkin_amount) || 0;
  const total = Number(price_total) || 0;

  // En renta mensual el cobrado lo mandan las mensualidades, no el pago
  // al ingresar: si no, editar la reserva borraría los cobros ya marcados.
  const esRentaMensual = esMensual(current.rows[0]?.rental_type);
  let price_paid = dep + chk;
  if (esRentaMensual) {
    const c = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS cobrado FROM rent_payments
       WHERE reservation_id = $1 AND paid_at IS NOT NULL`, [id]
    );
    price_paid = dep + (Number(c.rows[0].cobrado) || 0);
  }
  const payment_status = calcPaymentStatus(total, price_paid, 0);

  const commission = Number(commission_amount) || 0;
  const collected = collected_by_us === true || collected_by_us === 'true';

  await pool.query(`
    UPDATE reservations SET
      room_id=$1, room_name=$2, guest_name=$3, guest_email=$4, guest_phone=$5,
      guest_nationality=$6, num_persons=$7, check_in=$8, check_out=$9,
      price_total=$10, price_per_night=$11,
      deposit_amount=$12, deposit_method=$13,
      checkin_amount=$14, checkin_method=$15,
      price_paid=$16, payment_status=$17, channel=$18, notes=$19,
      commission_amount=$20, collected_by_us=$21
    WHERE id=$22
  `, [
    effectiveRoomId, room_name, guest_name, guest_email, guest_phone,
    guest_nationality, num_persons, check_in, check_out,
    total || null, price_per_night || null,
    dep, deposit_method || 'Transferencia',
    chk, checkin_method || 'Efectivo',
    price_paid, payment_status, channel, notes,
    commission, collected, id
  ]);

  res.json({ success: true });
});

router.delete("/admin/reservations/:id", authMiddleware, async (req: Request, res: Response) => {
  await pool.query(`DELETE FROM reservations WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

// PATCH — registrar pago al ingreso
router.patch("/admin/reservations/:id/checkin-payment", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { checkin_amount, checkin_method } = req.body;

  const current = await pool.query(`SELECT price_total, deposit_amount FROM reservations WHERE id = $1`, [id]);
  if (!current.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });

  const price_total = Number(current.rows[0].price_total) || 0;
  const deposit = Number(current.rows[0].deposit_amount) || 0;
  const chk = Number(checkin_amount) || 0;
  const price_paid = deposit + chk;
  const payment_status = calcPaymentStatus(price_total, deposit, chk);

  await pool.query(`
    UPDATE reservations SET
      checkin_amount=$1, checkin_method=$2,
      price_paid=$3, payment_status=$4
    WHERE id=$5
  `, [chk, checkin_method || 'Efectivo', price_paid, payment_status, id]);

  res.json({ success: true, price_paid, payment_status });
});

// PATCH — liquidar comisión de piso gestionado
router.patch("/admin/reservations/:id/settle", authMiddleware, async (req: Request, res: Response) => {
  const { settled_method } = req.body;
  const method = settled_method === 'BBVA' ? 'BBVA' : 'Efectivo';
  await pool.query(
    `UPDATE reservations SET settled_at = CURRENT_DATE, settled_method = $1 WHERE id = $2`,
    [method, Number(req.params.id)]
  );
  res.json({ success: true });
});

// PATCH — deshacer liquidación
router.patch("/admin/reservations/:id/unsettle", authMiddleware, async (req: Request, res: Response) => {
  await pool.query(
    `UPDATE reservations SET settled_at = NULL, settled_method = NULL WHERE id = $1`,
    [Number(req.params.id)]
  );
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// NO-SHOW
// El huésped no vino. La reserva se conserva para no perder el
// ingreso de la señal, pero deja de ocupar la habitación y el
// pendiente de cobro pasa a 0.
// ─────────────────────────────────────────────
router.patch("/admin/reservations/:id/no-show", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query(`SELECT price_paid FROM reservations WHERE id = $1`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });

  await pool.query(
    `UPDATE reservations SET no_show = true, payment_status = 'paid' WHERE id = $1`, [id]
  );
  res.json({ success: true, cobrado: Number(r.rows[0].price_paid) || 0 });
});

router.patch("/admin/reservations/:id/undo-no-show", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    `SELECT room_id, check_in, check_out, price_total, price_paid FROM reservations WHERE id = $1`, [id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });

  const row = r.rows[0];
  const ci = String(row.check_in).split("T")[0];
  const co = String(row.check_out).split("T")[0];

  // Puede que esas fechas ya se hayan revendido mientras estaba liberada.
  if (await checkOverlap(row.room_id, ci, co, id))
    return res.status(409).json({ error: "Esas fechas ya están ocupadas por otra reserva" });

  const total = Number(row.price_total) || 0;
  const pagado = Number(row.price_paid) || 0;
  await pool.query(
    `UPDATE reservations SET no_show = false, payment_status = $1 WHERE id = $2`,
    [calcPaymentStatus(total, pagado, 0), id]
  );
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// MENSUALIDADES (renta mensual del Born)
// ─────────────────────────────────────────────
router.get("/admin/rent-payments", authMiddleware, async (_req: Request, res: Response) => {
  const result = await pool.query(`
    SELECT rp.*, r.guest_name, r.room_id, r.room_name
    FROM rent_payments rp
    JOIN reservations r ON r.id = rp.reservation_id
    ORDER BY rp.period_start ASC
  `);
  res.json(result.rows);
});

// Marcar una mensualidad como cobrada.
router.patch("/admin/rent-payments/:id/pay", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { method, paid_at, amount } = req.body;

  const r = await pool.query(`SELECT reservation_id FROM rent_payments WHERE id = $1`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Mensualidad no encontrada" });

  await pool.query(`
    UPDATE rent_payments
    SET paid_at = COALESCE($1::date, CURRENT_DATE),
        method  = $2,
        amount  = COALESCE($3, amount)
    WHERE id = $4
  `, [paid_at || null, method || 'Efectivo', amount !== undefined && amount !== null && amount !== '' ? Number(amount) : null, id]);

  await recalcularPagosMensuales(r.rows[0].reservation_id);
  res.json({ success: true });
});

router.patch("/admin/rent-payments/:id/unpay", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query(`SELECT reservation_id FROM rent_payments WHERE id = $1`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Mensualidad no encontrada" });

  await pool.query(`UPDATE rent_payments SET paid_at = NULL, method = NULL WHERE id = $1`, [id]);
  await recalcularPagosMensuales(r.rows[0].reservation_id);
  res.json({ success: true });
});

// Añadir un mes más a una renta en curso (el inquilino prorroga).
router.post("/admin/reservations/:id/extend-month", authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    `SELECT room_id, check_in, check_out, monthly_rate, rental_type FROM reservations WHERE id = $1`, [id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Reserva no encontrada" });
  if (!esMensual(r.rows[0].rental_type))
    return res.status(400).json({ error: "Esta reserva no es de renta mensual" });

  const co = String(r.rows[0].check_out).split("T")[0];
  const nuevoCheckOut = sumarMeses(co, 1);

  if (await checkOverlap(r.rows[0].room_id, co, nuevoCheckOut, id))
    return res.status(409).json({ error: "El mes siguiente ya está ocupado por otra reserva" });

  const importeMes = Number(req.body?.monthly_rate) || Number(r.rows[0].monthly_rate) || 0;

  await pool.query(
    `INSERT INTO rent_payments (reservation_id, period_start, amount) VALUES ($1, $2, $3)`,
    [id, primerDiaDelMes(co), importeMes]
  );
  await pool.query(
    `UPDATE reservations
     SET check_out = $1,
         price_total = COALESCE(price_total, 0) + $2
     WHERE id = $3`,
    [nuevoCheckOut, importeMes, id]
  );
  await recalcularPagosMensuales(id);

  res.json({ success: true, check_out: nuevoCheckOut });
});

export default router;