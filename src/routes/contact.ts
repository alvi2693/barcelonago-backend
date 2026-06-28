import { Router, Request, Response } from "express";
import { pool } from "../db";

const router = Router();

router.post("/contact", async (req: Request, res: Response) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: "Missing fields" });
  }

  await pool.query(
    `INSERT INTO leads (name, email, message) VALUES ($1, $2, $3)`,
    [name, email, message]
  );

  console.log("📩 New lead saved:", { name, email, message });
  res.json({ success: true });
});

export default router;