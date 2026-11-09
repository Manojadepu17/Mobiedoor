import { describe, expect, it, vi } from "vitest";
import { UserRole } from "@prisma/client";
import { cookieAttributes, requireRoles } from "./auth.js";

describe("session cookie attributes", () => {
  it("uses Secure and SameSite=None in production", () => {
    expect(cookieAttributes(true)).toBe("HttpOnly; Path=/; SameSite=None; Secure");
  });

  it("uses an insecure SameSite=Lax cookie outside production", () => {
    expect(cookieAttributes(false)).toBe("HttpOnly; Path=/; SameSite=Lax");
  });
});

describe("role authorization", () => {
  it("allows Founder and Admin through the same permission gate", () => {
    for (const role of [UserRole.FOUNDER, UserRole.ADMIN]) {
      const next = vi.fn();
      const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      requireRoles(UserRole.FOUNDER, UserRole.ADMIN)({ user: { role } } as never, response as never, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("blocks Staff from admin-only mutations", () => {
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireRoles(UserRole.FOUNDER, UserRole.ADMIN)({ user: { role: UserRole.STAFF } } as never, response as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
