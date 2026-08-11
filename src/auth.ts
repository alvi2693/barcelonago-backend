import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ─────────────────────────────────────────────
// Autenticación
//
// Convive con el esquema antiguo a propósito: los tokens viejos
// (base64 de la contraseña) siguen aceptándose mientras migras el
// frontend. Cuando /admin ya use JWT, se pone LEGACY_ENABLED=false
// en Render y esa puerta se cierra sin tocar código.
// ─────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

if (!JWT_SECRET) {
  console.warn("[auth] Falta JWT_SECRET. El login con JWT no funcionará.");
}

// Contraseñas del esquema antiguo
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bcnrooms2024";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "sagrada2026";
const CALENDAR_PASSWORD = process.env.CALENDAR_PASSWORD || "bcnroom2026";
const LEGACY_ENABLED = process.env.LEGACY_AUTH !== "false";

// La cuenta a la que pertenecen los tokens antiguos: vosotros.
const LEGACY_ACCOUNT_ID = Number(process.env.LEGACY_ACCOUNT_ID || 1);

export type Rol = "owner" | "staff" | "calendar";

export interface Auth {
  userId: number | null;      // null si viene de un token antiguo
  accountId: number;
  role: Rol;
  legacy: boolean;
}

declare global {
  namespace Express {
    interface Request { auth?: Auth }
  }
}

export function signToken(payload: { userId: number; accountId: number; role: Rol }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
}

function leerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

// Traduce un token antiguo a la misma forma que uno nuevo, para que
// el resto del código no tenga que saber de dónde viene.
function resolverLegacy(token: string): Auth | null {
  if (!LEGACY_ENABLED) return null;
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  if (token === b64(ADMIN_PASSWORD))    return { userId: null, accountId: LEGACY_ACCOUNT_ID, role: "owner",    legacy: true };
  if (token === b64(CALENDAR_PASSWORD)) return { userId: null, accountId: LEGACY_ACCOUNT_ID, role: "calendar", legacy: true };
  if (token === b64(OWNER_PASSWORD))    return { userId: null, accountId: LEGACY_ACCOUNT_ID, role: "staff",    legacy: true };
  return null;
}

export function resolverAuth(req: Request): Auth | null {
  const token = leerToken(req);
  if (!token) return null;

  if (JWT_SECRET) {
    try {
      const p = jwt.verify(token, JWT_SECRET) as any;
      if (p?.accountId && p?.role) {
        return { userId: Number(p.userId), accountId: Number(p.accountId), role: p.role, legacy: false };
      }
    } catch {
      // No es un JWT válido: probamos con el esquema antiguo.
    }
  }
  return resolverLegacy(token);
}

// Exige sesión válida con alguno de los roles indicados.
export function requireAuth(...roles: Rol[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = resolverAuth(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });
    if (roles.length && !roles.includes(auth.role)) {
      return res.status(403).json({ error: "No tienes permiso para esta operación" });
    }
    req.auth = auth;
    next();
  };
}

// Atajos con los mismos nombres que usa el código actual
export const authMiddleware      = requireAuth("owner", "staff");
export const calendarMiddleware  = requireAuth("owner", "staff", "calendar");
export const anyAuthMiddleware   = requireAuth();

// La cuenta de quien hace la petición. Toda consulta debería filtrar
// por este valor en cuanto haya más de una cuenta en la base.
export function cuentaDe(req: Request): number {
  return req.auth?.accountId ?? LEGACY_ACCOUNT_ID;
}