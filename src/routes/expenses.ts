import { Router, Request, Response } from "express";
import { pool } from "../db";

const router = Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bcnrooms2024";

function authMiddleware(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expected = Buffer.from(ADMIN_PASSWORD).toString("base64");
  if (token === expected) next();
  else res.status(401).json({ error: "Unauthorized" });
}

// GET todos los gastos
router.get("/admin/expenses", authMiddleware, async (_req: Request, res: Response) => {
  const result = await pool.query(`SELECT * FROM expenses ORDER BY date DESC`);
  res.json(result.rows);
});

// POST crear gasto
router.post("/admin/expenses", authMiddleware, async (req: Request, res: Response) => {
  const { property_id, property_name, category, description, amount, date } = req.body;
  if (!property_id || !category || !description || !amount || !date)
    return res.status(400).json({ error: "Missing required fields" });

  const result = await pool.query(`
    INSERT INTO expenses (property_id, property_name, category, description, amount, date)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [property_id, property_name, category, description, Number(amount), date]);

  res.json({ success: true, id: result.rows[0].id });
});

// PUT actualizar gasto
router.put("/admin/expenses/:id", authMiddleware, async (req: Request, res: Response) => {
  const { property_id, property_name, category, description, amount, date } = req.body;
  await pool.query(`
    UPDATE expenses SET property_id=$1, property_name=$2, category=$3, description=$4, amount=$5, date=$6
    WHERE id=$7
  `, [property_id, property_name, category, description, Number(amount), date, req.params.id]);
  res.json({ success: true });
});

// DELETE gasto
router.delete("/admin/expenses/:id", authMiddleware, async (req: Request, res: Response) => {
  await pool.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

export default router;