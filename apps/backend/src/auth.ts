import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";
import { prisma } from "./lib/prisma.js";

const SESSION_COOKIE = "mobiedoor_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const cookieAttributes = (isProduction = process.env.NODE_ENV === "production") =>
  `HttpOnly; Path=/; SameSite=${isProduction ? "None" : "Lax"}${isProduction ? "; Secure" : ""}`;

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function createSession(user: AuthUser, response: Response) {
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieAttributes()}; Max-Age=${SESSION_TTL_MS / 1000}`);
}

export async function destroySession(request: Request, response: Response) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttributes()}; Max-Age=0`);
}

export async function loadUser(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return undefined;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, name: true, email: true, role: true, isActive: true } } },
  });
  if (!session || session.expiresAt <= new Date() || !session.user.isActive) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    return undefined;
  }
  return session.user;
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  try {
    const user = await loadUser(request);
    if (!user) {
      response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
      return;
    }
    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRoles(...roles: UserRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.user || !roles.includes(request.user.role)) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have permission to perform this action." } });
      return;
    }
    next();
  };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export async function recordActivity(userId: string, action: string, entity: string, entityId?: string, metadata?: object) {
  await prisma.activityLog.create({ data: { userId, action, entity, entityId, metadata } });
}

export async function cleanupExpiredSessions() {
  return prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

function readCookie(request: Request, name: string) {
  const header = request.headers.cookie;
  if (!header) return undefined;
  const match = header.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}
