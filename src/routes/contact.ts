import { Router } from "express";
import { db } from "../db";

const router = Router();

router.post("/", (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  db.run(
    "INSERT INTO leads (name, email, message) VALUES (?, ?, ?)",
    [name, email, message || ""],
    () => {
      res.json({ success: true });
    }
  );
});

export default router;
