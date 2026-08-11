import { Router, Request, Response } from "express";
import { pool } from "../db";
import { authMiddleware } from "../auth";

const router = Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bcnrooms2024";


// GET todos los gastos
router.get("/admin/expenses", authMiddleware, async (_req: Request, res: Response) => {
  const result = await pool.query(`SELECT * FROM expenses ORDER BY date DESC`);
  res.json(result.rows);
});

// POST crear gasto
router.post("/admin/expenses", authMiddleware, async (req: Request, res: Response) => {
  const { property_id, property_name, category, description, amount, date, paid_by, own_money } = req.body;
  if (!property_id || !category || !description || !amount || !date)
    return res.status(400).json({ error: "Missing required fields" });

  const result = await pool.query(`
    INSERT INTO expenses (property_id, property_name, category, description, amount, date, payment_method, paid_by, own_money)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
  `, [
    property_id, property_name, category, description, Number(amount), date,
    req.body.payment_method || 'Efectivo',
    paid_by || null,
    own_money === true || own_money === 'true',
  ]);

  res.json({ success: true, id: result.rows[0].id });
});

// PUT actualizar gasto
router.put("/admin/expenses/:id", authMiddleware, async (req: Request, res: Response) => {
  const { property_id, property_name, category, description, amount, date, paid_by, own_money } = req.body;
  await pool.query(`
    UPDATE expenses SET
      property_id=$1, property_name=$2, category=$3, description=$4, amount=$5, date=$6,
      payment_method=$7, paid_by=$8, own_money=$9
    WHERE id=$10
  `, [
    property_id, property_name, category, description, Number(amount), date,
    req.body.payment_method || 'Efectivo',
    paid_by || null,
    own_money === true || own_money === 'true',
    req.params.id,
  ]);
  res.json({ success: true });
});

// DELETE gasto
router.delete("/admin/expenses/:id", authMiddleware, async (req: Request, res: Response) => {
  await pool.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

// PATCH marcar gasto como reembolsado (cuando pagó con su dinero)
router.patch("/admin/expenses/:id/reimburse", authMiddleware, async (req: Request, res: Response) => {
  await pool.query(
    `UPDATE expenses SET reimbursed_at = CURRENT_DATE WHERE id = $1`,
    [req.params.id]
  );
  res.json({ success: true });
});

// PATCH deshacer reembolso
router.patch("/admin/expenses/:id/unreimburse", authMiddleware, async (req: Request, res: Response) => {
  await pool.query(
    `UPDATE expenses SET reimbursed_at = NULL WHERE id = $1`,
    [req.params.id]
  );
  res.json({ success: true });
});

export default router;