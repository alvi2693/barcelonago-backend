import { Router, Request, Response } from "express";
import { pool } from "../db";
import { requireAdminAccount } from "../auth";

const router = Router();

// ─────────────────────────────────────────────
// CLIENTES — vista de socio
//
// Solo para la cuenta del panel de administración. Devuelve la
// ocupación y los precios de las demás cuentas, para poder ofrecer
// sus fechas libres sin tener que preguntarles.
//
// Deliberadamente NO devuelve nombres de huéspedes, teléfonos, notas
// ni cobros: para vender solo hace falta saber qué está libre y a qué
// precio. Cuando existan los niveles de partnership, este endpoint
// filtrará por el nivel que cada cliente conceda.
// ─────────────────────────────────────────────

const soloAdmin = requireAdminAccount("owner", "staff");

router.get("/admin/partners", soloAdmin, async (req: Request, res: Response) => {
  const miCuenta = req.auth!.accountId;

  const cuentas = await pool.query(
    `SELECT id, name, slug FROM accounts
     WHERE id <> $1 AND active = true
     ORDER BY name`, [miCuenta]
  );
  if (cuentas.rows.length === 0) return res.json({ partners: [] });

  const ids = cuentas.rows.map((c: any) => c.id);

  const pisos = await pool.query(
    `SELECT id, account_id, name, color
     FROM properties
     WHERE account_id = ANY($1::int[]) AND archived = false
     ORDER BY sort_order, id`, [ids]
  );

  const habitaciones = await pool.query(
    `SELECT rm.id, rm.property_id, rm.name, rm.room_type, rm.max_persons, p.account_id
     FROM rooms rm
     JOIN properties p ON p.id = rm.property_id
     WHERE p.account_id = ANY($1::int[]) AND rm.archived = false
     ORDER BY rm.sort_order, rm.id`, [ids]
  );

  const tarifas = await pool.query(
    `SELECT rt.id, rt.room_id, rt.label, rt.valid_from, rt.valid_to, rt.pax,
            rt.net_price, rt.min_net_price, rt.min_nights
     FROM room_rates rt
     JOIN rooms rm ON rm.id = rt.room_id
     JOIN properties p ON p.id = rm.property_id
     WHERE p.account_id = ANY($1::int[])`, [ids]
  );

  // Solo los tramos ocupados. Sin datos del huésped.
  const ocupacion = await pool.query(
    `SELECT r.room_id, r.check_in, r.check_out
     FROM reservations r
     WHERE r.account_id = ANY($1::int[])
       AND COALESCE(r.no_show, false) = false
       AND r.check_out >= CURRENT_DATE - INTERVAL '30 days'
     ORDER BY r.check_in`, [ids]
  );

  const partners = cuentas.rows.map((c: any) => ({
    account: { id: c.id, name: c.name, slug: c.slug },
    properties: pisos.rows
      .filter((p: any) => p.account_id === c.id)
      .map((p: any) => ({
        id: p.id, name: p.name, color: p.color,
        rooms: habitaciones.rows
          .filter((rm: any) => rm.property_id === p.id)
          .map((rm: any) => ({
            id: rm.id, name: rm.name, room_type: rm.room_type,
            max_persons: Number(rm.max_persons) || 2,
            rates: tarifas.rows
              .filter((t: any) => t.room_id === rm.id)
              .map((t: any) => ({
                ...t,
                net_price: Number(t.net_price) || 0,
                min_net_price: t.min_net_price === null ? null : Number(t.min_net_price),
                valid_from: t.valid_from ? String(t.valid_from).split("T")[0] : null,
                valid_to: t.valid_to ? String(t.valid_to).split("T")[0] : null,
              })),
            busy: ocupacion.rows
              .filter((o: any) => o.room_id === rm.id)
              .map((o: any) => ({
                from: String(o.check_in).split("T")[0],
                to: String(o.check_out).split("T")[0],
              })),
          })),
      })),
  }));

  res.json({ partners });
});

export default router;