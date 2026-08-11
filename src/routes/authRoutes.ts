import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { signToken, requireAuth, Rol } from "../auth";

const router = Router();

// Retraso mínimo ante credenciales incorrectas: hace más lento
// probar contraseñas a lo bruto y no molesta a nadie legítimo.
const espera = (ms: number) => new Promise(r => setTimeout(r, ms));

router.post("/auth/login", async (req: Request, res: Response) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Faltan el correo o la contraseña" });
  }

  const r = await pool.query(
    `SELECT id, account_id, email, password_hash, name, role, active
     FROM app_users WHERE LOWER(email) = $1`,
    [email]
  );

  const user = r.rows[0];
  // Mismo mensaje tanto si el usuario no existe como si la contraseña
  // falla: si no, se puede averiguar qué correos están dados de alta.
  if (!user || !user.active) {
    await espera(400);
    return res.status(401).json({ error: "Correo o contraseña incorrectos" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await espera(400);
    return res.status(401).json({ error: "Correo o contraseña incorrectos" });
  }

  await pool.query(`UPDATE app_users SET last_login_at = now() WHERE id = $1`, [user.id]);

  const cuenta = await pool.query(`SELECT id, name, slug FROM accounts WHERE id = $1`, [user.account_id]);

  const token = signToken({
    userId: user.id,
    accountId: user.account_id,
    role: user.role as Rol,
  });

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    account: cuenta.rows[0] || null,
  });
});

// Quién soy. El frontend lo llama al arrancar para saber si el
// token guardado sigue siendo válido.
router.get("/auth/me", requireAuth(), async (req: Request, res: Response) => {
  const auth = req.auth!;

  if (auth.legacy) {
    const cuenta = await pool.query(`SELECT id, name, slug FROM accounts WHERE id = $1`, [auth.accountId]);
    return res.json({
      user: { id: null, email: null, name: "Sesión antigua", role: auth.role },
      account: cuenta.rows[0] || null,
      legacy: true,
    });
  }

  const r = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, a.id AS account_id, a.name AS account_name, a.slug
     FROM app_users u JOIN accounts a ON a.id = u.account_id
     WHERE u.id = $1 AND u.active = true`,
    [auth.userId]
  );
  if (!r.rows[0]) return res.status(401).json({ error: "Unauthorized" });

  const u = r.rows[0];
  res.json({
    user: { id: u.id, email: u.email, name: u.name, role: u.role },
    account: { id: u.account_id, name: u.account_name, slug: u.slug },
    legacy: false,
  });
});

router.post("/auth/change-password", requireAuth(), async (req: Request, res: Response) => {
  const auth = req.auth!;
  if (auth.legacy || !auth.userId) {
    return res.status(400).json({ error: "Entra con tu correo y contraseña para poder cambiarla" });
  }

  const actual = String(req.body?.current_password || "");
  const nueva = String(req.body?.new_password || "");

  if (nueva.length < 8) {
    return res.status(400).json({ error: "La contraseña nueva debe tener al menos 8 caracteres" });
  }

  const r = await pool.query(`SELECT password_hash FROM app_users WHERE id = $1`, [auth.userId]);
  if (!r.rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });

  const ok = await bcrypt.compare(actual, r.rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: "La contraseña actual no es correcta" });

  const hash = await bcrypt.hash(nueva, 10);
  await pool.query(`UPDATE app_users SET password_hash = $1 WHERE id = $2`, [hash, auth.userId]);

  res.json({ success: true });
});

// Alta de usuarios dentro de la propia cuenta. Solo el dueño.
router.post("/auth/users", requireAuth("owner"), async (req: Request, res: Response) => {
  const auth = req.auth!;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const name = String(req.body?.name || "").trim() || null;
  const role = (req.body?.role || "staff") as Rol;

  if (!email || password.length < 8) {
    return res.status(400).json({ error: "Hace falta un correo y una contraseña de 8 caracteres o más" });
  }
  if (!["owner", "staff", "calendar"].includes(role)) {
    return res.status(400).json({ error: "Rol no válido" });
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      `INSERT INTO app_users (account_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role`,
      [auth.accountId, email, hash, name, role]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch (e: any) {
    if (e?.code === "23505") return res.status(409).json({ error: "Ese correo ya está dado de alta" });
    throw e;
  }
});

router.get("/auth/users", requireAuth("owner"), async (req: Request, res: Response) => {
  const r = await pool.query(
    `SELECT id, email, name, role, active, last_login_at, created_at
     FROM app_users WHERE account_id = $1 ORDER BY created_at`,
    [req.auth!.accountId]
  );
  res.json(r.rows);
});

export default router;