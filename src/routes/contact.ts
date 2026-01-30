import { Router } from "express";
import { db } from "../db";

const router = Router();

router.post("/", (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const stmt = db.prepare(
      "INSERT INTO leads (name, email, message) VALUES (?, ?, ?)"
    );
    stmt.run(name, email, message);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
