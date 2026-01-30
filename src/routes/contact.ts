import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.post("/contact", (req: Request, res: Response) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const stmt = db.prepare(`
    INSERT INTO leads (name, email, message)
    VALUES (?, ?, ?)
  `);

  stmt.run(name, email, message);

  console.log("📩 New lead saved:", { name, email, message });

  res.json({ success: true });
});

export default router;
