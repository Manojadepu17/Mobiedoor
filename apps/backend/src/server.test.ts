import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { MemoryStore, rateLimit } from "express-rate-limit";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { app, generateCloudinarySignature, getCloudinaryErrorDetails, isCloudinaryImageUrl, isProductInventoryHistoryConstraintError, isTransientPrismaReadError, retryPrismaRead } from "./server.js";
import { hashPassword } from "./auth.js";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";

vi.mock("./auth.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return { ...actual, cleanupExpiredSessions: vi.fn().mockResolvedValue({ count: 0 }) };
});

const rateLimitTestPassword = "correct-password-2026!";

async function createRateLimitTestUser(id: string, email: string) {
  return {
    id,
    name: "Rate Limit Customer",
    email,
    passwordHash: await bcrypt.hash(rateLimitTestPassword, 4),
    role: "CUSTOMER" as const,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function withProxyTrust<T>(trustProxy: false | number, run: () => Promise<T>) {
  const originalTrustProxy = app.get("trust proxy");
  app.set("trust proxy", trustProxy);
  try {
    return await run();
  } finally {
    app.set("trust proxy", originalTrustProxy);
  }
}

function loginAttempt(ip: string, email: string, password = "incorrect-password-2026!") {
  return request(app)
    .post("/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ email, password });
}

function expectRetryAfterWithinWindow(response: request.Response, windowMs: number, windowStartedAt: number) {
  const retryAfter = Number(response.headers["retry-after"]);
  const expectedRemainingSeconds = Math.ceil((windowStartedAt + windowMs - Date.now()) / 1000);
  expect(retryAfter).toBeGreaterThanOrEqual(expectedRemainingSeconds - 2);
  expect(retryAfter).toBeLessThanOrEqual(expectedRemainingSeconds + 2);
}

describe("public API security and contracts", () => {
  it("adds no-store cache protection to successful API responses", async () => {
    const response = await request(app)
      .options("/auth/login")
      .set("Origin", config.frontendUrl)
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("allows the equivalent loopback frontend origin without allowing arbitrary origins", async () => {
    const frontend = new URL(config.frontendUrl);
    const loopbackAlias = new URL(config.frontendUrl);
    loopbackAlias.hostname = frontend.hostname === "localhost" ? "127.0.0.1" : "localhost";

    if (config.frontendOrigins.includes(loopbackAlias.origin)) {
      const preflight = await request(app)
        .options("/auth/login")
        .set("Origin", loopbackAlias.origin)
        .set("Access-Control-Request-Method", "POST");

      expect(preflight.status).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe(loopbackAlias.origin);
    }

    const rejected = await request(app)
      .post("/auth/login")
      .set("Origin", "https://untrusted.example")
      .send({ email: "not-an-email", password: "short" });

    expect(rejected.status).toBe(403);
    expect(rejected.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("adds no-store cache protection to API error responses", async () => {
    const response = await request(app).post("/auth/login").send({ email: "not-an-email", password: "short" });

    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("adds no-store cache protection to a successful health response without querying a database", async () => {
    const query = vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([] as never);

    try {
      const response = await request(app).get("/health");

      expect(query).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      query.mockRestore();
    }
  });

  it("adds no-store cache protection to an unexpected server error without querying a database", async () => {
    const query = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("Simulated test failure"));

    try {
      const response = await request(app).get("/health");

      expect(query).toHaveBeenCalledOnce();
      expect(response.status).toBe(500);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      query.mockRestore();
    }
  });

  it("extracts sanitized Cloudinary provider diagnostics", () => {
    expect(getCloudinaryErrorDetails({
      error: { message: "The secret value was echoed", name: "Error", code: "401", http_code: 401 },
    }, 502)).toEqual({
      cloudinaryErrorStatus: 401,
    });
  });

  it("recognizes only Prisma foreign-key errors as inventory-history deletion conflicts", () => {
    expect(isProductInventoryHistoryConstraintError(new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "test",
    }))).toBe(true);
    expect(isProductInventoryHistoryConstraintError(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    }))).toBe(false);
    expect(isProductInventoryHistoryConstraintError({ code: "P2003" })).toBe(false);
  });

  it("accepts only HTTPS Cloudinary image URLs for product records", () => {
    expect(isCloudinaryImageUrl("https://res.cloudinary.com/demo/image/upload/sample.jpg")).toBe(true);
    expect(isCloudinaryImageUrl("http://localhost:4000/uploads/product.jpg")).toBe(false);
    expect(isCloudinaryImageUrl("https://example.com/product.jpg")).toBe(false);
  });

  it("generates deterministic Cloudinary SHA-1 upload signatures", () => {
    expect(generateCloudinarySignature("product-test", 1700000000, "api-secret"))
      .toBe("1749029a02e4cb615bc1d201187c5f7f2957238a");
  });

  it("uses the configured proxy trust policy before rate limiting", async () => {
    expect(app.get("trust proxy")).toBe(config.trustProxy);

    const response = await request(app).post("/auth/login").send({ email: "not-an-email", password: "short" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("reports a healthy service without requiring a database connection", async () => {
    const query = vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([] as never);

    try {
      const response = await request(app).get("/health");

      expect(query).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.body).toMatchObject({ status: "ok", service: "mobiedoor-api", database: "ok" });
    } finally {
      query.mockRestore();
    }
  });

  it("returns a published-product collection envelope", async () => {
    const response = await request(app).get("/products?limit=1");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: expect.any(Array), meta: expect.objectContaining({ page: 1, limit: 1 }) });
  });

  it("returns categories as an array envelope", async () => {
    const response = await request(app).get("/categories");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(expect.any(Array));
  });

  it("classifies transient Prisma read failures and avoids exposing database details", async () => {
    for (const errorCode of ["P1001", "P1002"]) {
      expect(isTransientPrismaReadError(new Prisma.PrismaClientInitializationError(
        "Unable to connect to mysql://private-user:private-password@private-db.invalid",
        "6.19.3",
        errorCode,
      ))).toBe(true);
    }
    expect(isTransientPrismaReadError(new Prisma.PrismaClientKnownRequestError("pool timed out", {
      code: "P2024",
      clientVersion: "test",
    }))).toBe(true);
    expect(isTransientPrismaReadError(new Prisma.PrismaClientKnownRequestError("invalid input", {
      code: "P2002",
      clientVersion: "test",
    }))).toBe(false);

    const originalTransaction = prisma.$transaction;
    const query = vi.spyOn(prisma, "$transaction").mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("database host detail that must stay private", {
        code: "P2024",
        clientVersion: "test",
      }),
    );
    try {
      const response = await request(app).get("/products?limit=12");
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The live catalogue service is temporarily unavailable. Please try again shortly.",
        },
      });
      expect(JSON.stringify(response.body)).not.toContain("database host");
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      query.mockRestore();
      Object.defineProperty(prisma, "$transaction", { configurable: true, writable: true, value: originalTransaction });
    }
  });

  it.each(["P1001", "P1002"])("retries initialization error %s and returns a sanitized 503", async errorCode => {
    const originalTransaction = prisma.$transaction;
    const query = vi.spyOn(prisma, "$transaction").mockRejectedValue(
      new Prisma.PrismaClientInitializationError(
        "Unable to connect to mysql://private-user:private-password@private-db.invalid",
        "6.19.3",
        errorCode,
      ),
    );
    try {
      const response = await request(app).get("/products?limit=12");
      expect(response.status).toBe(503);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.body).toEqual({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The live catalogue service is temporarily unavailable. Please try again shortly.",
        },
      });
      expect(JSON.stringify(response.body)).not.toMatch(/mysql|private-user|private-password|private-db|stack/i);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      query.mockRestore();
      Object.defineProperty(prisma, "$transaction", { configurable: true, writable: true, value: originalTransaction });
    }
  });

  it("does not classify Rust panics or permanent Prisma errors as transient", () => {
    expect(isTransientPrismaReadError(new Prisma.PrismaClientRustPanicError("engine panic", "test"))).toBe(false);
    expect(isTransientPrismaReadError(new Prisma.PrismaClientUnknownRequestError("unknown request", {
      clientVersion: "test",
    }))).toBe(false);
    for (const code of ["P2002", "P2003", "P2012", "P2028"]) {
      expect(isTransientPrismaReadError(new Prisma.PrismaClientKnownRequestError(code, {
        code,
        clientVersion: "test",
      }))).toBe(false);
    }
    for (const errorCode of ["P1000", "P1012", "P9999"]) {
      expect(isTransientPrismaReadError(new Prisma.PrismaClientInitializationError(
        "permanent initialization failure",
        "6.19.3",
        errorCode,
      ))).toBe(false);
    }
  });

  it("retries only confirmed temporary Prisma connection and timeout errors", async () => {
    for (const errorCode of ["P1001", "P1002"]) {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Prisma.PrismaClientInitializationError(
          "temporary connection failure",
          "6.19.3",
          errorCode,
        ))
        .mockResolvedValueOnce("ok");
      await expect(retryPrismaRead(operation)).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
    }

    const poolTimeout = vi.fn()
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("pool timed out", {
        code: "P2024",
        clientVersion: "test",
      }))
      .mockResolvedValueOnce("ok");
    await expect(retryPrismaRead(poolTimeout)).resolves.toBe("ok");
    expect(poolTimeout).toHaveBeenCalledTimes(2);

    const permanentErrors: Error[] = [
      new Prisma.PrismaClientInitializationError("authentication failed", "6.19.3", "P1000"),
      new Prisma.PrismaClientInitializationError("configuration error", "6.19.3", "P1012"),
      new Prisma.PrismaClientKnownRequestError("transaction closed", { code: "P2028", clientVersion: "test" }),
      new Prisma.PrismaClientRustPanicError("engine panic", "6.19.3"),
      new Prisma.PrismaClientUnknownRequestError("unknown request", { clientVersion: "6.19.3" }),
    ];
    for (const error of permanentErrors) {
      const operation = vi.fn().mockRejectedValue(error);
      await expect(retryPrismaRead(operation)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledOnce();
    }
  });

  it("does not retry a write operation when a transient Prisma error is returned", async () => {
    const write = vi.spyOn(prisma.contactEnquiry, "create").mockRejectedValue(
      new Prisma.PrismaClientInitializationError("temporary connection failure", "6.19.3", "P1001"),
    );
    try {
      const response = await request(app).post("/enquiries").send({
        name: "Test User",
        email: "test@example.test",
        phoneNumber: "+1 555 555 5555",
        message: "This enquiry is a mocked unit-test write.",
      });
      expect(response.status).toBe(503);
      expect(write).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it("rejects unauthenticated admin access", async () => {
    const response = await request(app).get("/admin/dashboard");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects unauthenticated product-image uploads", async () => {
    const response = await request(app).post("/admin/product-images").attach("image", Buffer.from("not-an-image"), "image.jpg");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("validates login input before credential lookup", async () => {
    const response = await request(app).post("/auth/login").send({ email: "not-an-email", password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("authenticates an existing mixed-case account after normalizing the login email", async () => {
    const passwordHash = await hashPassword("customer-password-2026!");
    const legacyUser = {
      id: "legacy-customer",
      name: "Legacy Customer",
      email: "Customer@Example.Test",
      passwordHash,
      role: "CUSTOMER" as const,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(legacyUser as never);
    const createSession = vi.spyOn(prisma.session, "create").mockResolvedValueOnce({ id: "session-1" } as never);

    try {
      const response = await request(app).post("/auth/login").send({
        email: " Customer@Example.Test ",
        password: "customer-password-2026!",
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: legacyUser.id,
        email: legacyUser.email,
        role: "CUSTOMER",
      });
      expect(lookup).toHaveBeenCalledWith({ where: { email: "customer@example.test" } });
      expect(createSession).toHaveBeenCalledOnce();
    } finally {
      lookup.mockRestore();
      createSession.mockRestore();
    }
  });

  it("validates a persisted session on refresh and rejects expired sessions", async () => {
    const token = "expired-test-session-token";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const validSession = {
      id: "valid-session",
      tokenHash,
      userId: "customer-1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      user: {
        id: "customer-1",
        name: "Test Customer",
        email: "customer@example.test",
        role: "CUSTOMER",
        isActive: true,
      },
    };
    const expiredSession = {
      id: "expired-session",
      tokenHash,
      userId: "customer-1",
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(Date.now() - 60_000),
      user: {
        id: "customer-1",
        name: "Test Customer",
        email: "customer@example.test",
        role: "CUSTOMER",
        isActive: true,
      },
    };
    const lookup = vi.spyOn(prisma.session, "findUnique")
      .mockResolvedValueOnce(validSession as never)
      .mockResolvedValue(expiredSession as never);
    const removeExpired = vi.spyOn(prisma.session, "delete").mockResolvedValue({ id: "expired-session" } as never);

    try {
      const cookie = `mobiedoor_session=${token}`;
      const valid = await request(app).get("/auth/me").set("Cookie", cookie);
      expect(valid.status).toBe(200);
      expect(valid.body.data).toMatchObject({ id: "customer-1", email: "customer@example.test" });

      const expired = await request(app).get("/auth/me").set("Cookie", cookie);
      expect(expired.status).toBe(401);
      expect(expired.body.error.code).toBe("UNAUTHORIZED");
      expect(lookup).toHaveBeenCalledWith(expect.objectContaining({
        where: { tokenHash },
      }));
      expect(removeExpired).toHaveBeenCalledWith({ where: { id: "expired-session" } });
    } finally {
      lookup.mockRestore();
      removeExpired.mockRestore();
    }
  });

  it("returns an authentication 503 without invalidating the cookie on temporary /auth/me database failure", async () => {
    const token = "temporary-test-session-token";
    const lookup = vi.spyOn(prisma.session, "findUnique").mockRejectedValue(
      new Prisma.PrismaClientInitializationError("Connection unavailable", "6.19.3", "P1001"),
    );

    try {
      const response = await request(app).get("/auth/me").set("Cookie", `mobiedoor_session=${token}`);

      expect(response.status).toBe(503);
      expect(response.body.error.message).toBe("The authentication service is temporarily unavailable. Please try again shortly.");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      lookup.mockRestore();
    }
  });

  it("validates customer registration before persistence", async () => {
    const response = await request(app).post("/auth/register").send({
      name: "Customer",
      email: "customer@example.test",
      password: "password-2026!",
      confirmPassword: "different-password-2026!",
      role: "ADMIN",
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details).toMatchObject({
      confirmPassword: ["Passwords do not match."],
    });
  });

  it("returns a generic 409 for a duplicate registration", async () => {
    const duplicateError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.19.3",
    });
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(duplicateError);

    try {
      const response = await request(app).post("/auth/register").send({
        name: "Duplicate Customer",
        email: "duplicate@example.test",
        password: "customer-password-2026!",
        confirmPassword: "customer-password-2026!",
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("EMAIL_ALREADY_REGISTERED");
      expect(response.body.error.message).toBe("An account with that email already exists.");
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      transaction.mockRestore();
    }
  });

  it("returns a generic authentication 503 for registration database failures", async () => {
    const databaseError = new Prisma.PrismaClientInitializationError(
      "Connection failed for mysql://private-user:private-password@private-host",
      "6.19.3",
      "P1001",
    );
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(databaseError);

    try {
      const response = await request(app).post("/auth/register").send({
        name: "Temporary Failure Customer",
        email: "temporary-failure@example.test",
        password: "customer-password-2026!",
        confirmPassword: "customer-password-2026!",
      });

      expect(response.status).toBe(503);
      expect(response.body.error.message).toBe("The authentication service is temporarily unavailable. Please try again shortly.");
      expect(JSON.stringify(response.body)).not.toContain("private-password");
      expect(JSON.stringify(response.body)).not.toContain("private-host");
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      transaction.mockRestore();
    }
  });

  it("denies initial setup without the backend setup secret", async () => {
    const response = await request(app).post("/auth/setup").send({
      name: "Initial Founder",
      email: "initial-founder@example.test",
      password: "password-2026!",
      confirmPassword: "password-2026!",
      setupSecret: "not-authorized",
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SETUP_NOT_AUTHORIZED");
  });

  it("rejects invalid public enquiry payloads without persistence", async () => {
    const response = await request(app).post("/enquiries").send({ name: "x", email: "bad", phoneNumber: "1", message: "short" });
    expect(response.status).toBe(400);
    expect(["VALIDATION_ERROR", "INVALID_JSON"]).toContain(response.body.error.code);
  });

  it("rejects invalid trade-in payloads", async () => {
    const response = await request(app).post("/trade-in").send({ customerName: "x" });
    expect(response.status).toBe(400);
  });

  it("rejects invalid partnership payloads", async () => {
    const response = await request(app).post("/partnerships").send({ companyName: "x" });
    expect(response.status).toBe(400);
  });
});

describe("login rate limiting", () => {
  it("expires inactive keys from the built-in memory store", async () => {
    const store = new MemoryStore();
    const limiter = rateLimit({ windowMs: 20, limit: 1, store });

    try {
      await store.increment("198.51.100.30");
      expect(await store.get("198.51.100.30")).toBeDefined();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await store.get("198.51.100.30")).toBeUndefined();
      expect(limiter).toBeTypeOf("function");
    } finally {
      store.shutdown();
    }
  });

  it("allows 20 invalid credentials, then returns 429 with Retry-After", async () => {
    const user = await createRateLimitTestUser("rate-limit-threshold", "threshold@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);

    try {
      await withProxyTrust(1, async () => {
        const windowStartedAt = Date.now();
        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt("198.51.100.31", user.email)).status).toBe(401);
        }

        const limited = await loginAttempt("198.51.100.31", user.email);
        expect(limited.status).toBe(429);
        expect(limited.body.error.code).toBe("RATE_LIMITED");
        expectRetryAfterWithinWindow(limited, 15 * 60 * 1000, windowStartedAt);
        expect(limited.headers.ratelimit).toContain("remaining=0");
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("does not consume failed-credential allowance for validation errors", async () => {
    const user = await createRateLimitTestUser("rate-limit-validation", "validation@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);

    try {
      await withProxyTrust(1, async () => {
        const invalid = await request(app).post("/auth/login").set("X-Forwarded-For", "198.51.100.32")
          .send({ email: "invalid-email", password: "short" });
        expect(invalid.status).toBe(400);

        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt("198.51.100.32", user.email)).status).toBe(401);
        }
        expect((await loginAttempt("198.51.100.32", user.email)).status).toBe(429);
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("does not consume failed-credential allowance for transient database failures", async () => {
    const user = await createRateLimitTestUser("rate-limit-database", "database@example.test");
    const transientError = new Prisma.PrismaClientInitializationError("Connection unavailable", "6.19.3", "P1001");
    const lookup = vi.spyOn(prisma.user, "findUnique")
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue(user as never);

    try {
      await withProxyTrust(1, async () => {
        const unavailable = await loginAttempt("198.51.100.33", user.email, rateLimitTestPassword);
        expect(unavailable.status).toBe(503);
        expect(unavailable.body.error.message).toBe("The authentication service is temporarily unavailable. Please try again shortly.");
        expect(unavailable.body.error.message).not.toContain("catalogue");

        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt("198.51.100.33", user.email)).status).toBe(401);
        }
        expect((await loginAttempt("198.51.100.33", user.email)).status).toBe(429);
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("does not block a successful login after failures from another user sharing the IP", async () => {
    const firstUser = await createRateLimitTestUser("rate-limit-shared-first", "first@example.test");
    const secondUser = await createRateLimitTestUser("rate-limit-shared-second", "second@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(firstUser as never);
    const createSession = vi.spyOn(prisma.session, "create").mockResolvedValue({ id: "session-1" } as never);

    try {
      await withProxyTrust(1, async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt("198.51.100.34", firstUser.email)).status).toBe(401);
        }

        lookup.mockResolvedValueOnce(secondUser as never);
        const successfulLogin = await loginAttempt("198.51.100.34", secondUser.email, rateLimitTestPassword);
        expect(successfulLogin.status).toBe(200);
        expect(successfulLogin.body.data.email).toBe(secondUser.email);
        expect(createSession).toHaveBeenCalledOnce();
        expect((await loginAttempt("198.51.100.34", firstUser.email)).status).toBe(429);
      });
    } finally {
      lookup.mockRestore();
      createSession.mockRestore();
    }
  });

  it("does not spend the login failure allowance on repeated authenticated refreshes", async () => {
    const user = await createRateLimitTestUser("rate-limit-refresh", "refresh@example.test");
    const token = "repeated-refresh-session-token";
    const sessionLookup = vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: "refresh-session",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: true,
      },
    } as never);
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);
    const createSession = vi.spyOn(prisma.session, "create").mockResolvedValue({ id: "new-session" } as never);

    try {
      await withProxyTrust(1, async () => {
        for (let refresh = 0; refresh < 25; refresh++) {
          expect((await request(app).get("/auth/me").set("Cookie", `mobiedoor_session=${token}`)).status).toBe(200);
        }
        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt("198.51.100.50", user.email)).status).toBe(401);
        }
        const successfulLogin = await loginAttempt("198.51.100.50", user.email, rateLimitTestPassword);
        expect(successfulLogin.status).toBe(200);
        expect(createSession).toHaveBeenCalledOnce();
      });
    } finally {
      sessionLookup.mockRestore();
      lookup.mockRestore();
      createSession.mockRestore();
    }
  });

  it("verifies passwords for unknown and existing accounts and returns equivalent invalid-credential responses", async () => {
    const user = await createRateLimitTestUser("rate-limit-enumeration", "known@example.test");
    user.passwordHash = await bcrypt.hash(rateLimitTestPassword, 12);
    const lookup = vi.spyOn(prisma.user, "findUnique")
      .mockResolvedValueOnce(user as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValue(user as never);
    const compare = vi.spyOn(bcrypt, "compare");

    try {
      await withProxyTrust(1, async () => {
        const existingAccount = await loginAttempt("198.51.100.35", user.email);
        const unknownAccount = await loginAttempt("198.51.100.35", "unknown@example.test");
        expect(unknownAccount.status).toBe(401);
        expect(existingAccount.status).toBe(401);
        expect(unknownAccount.body).toEqual(existingAccount.body);
        expect(compare).toHaveBeenCalledTimes(2);
        expect(compare.mock.calls[0][1]).toBe(user.passwordHash);
        expect(bcrypt.getRounds(compare.mock.calls[0][1])).toBe(12);
        expect(compare.mock.calls[1][1]).not.toBe(user.passwordHash);
        expect(bcrypt.getRounds(compare.mock.calls[1][1])).toBe(12);

      });
    } finally {
      lookup.mockRestore();
      compare.mockRestore();
    }
  });

  it("preserves inactive-account handling after password verification", async () => {
    const user = await createRateLimitTestUser("rate-limit-inactive", "inactive@example.test");
    user.isActive = false;
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);
    const createSession = vi.spyOn(prisma.session, "create").mockResolvedValue({ id: "inactive-session" } as never);

    try {
      await withProxyTrust(1, async () => {
        const invalidCredentials = await loginAttempt("198.51.100.45", user.email);
        const validCredentials = await loginAttempt("198.51.100.45", user.email, rateLimitTestPassword);
        expect(invalidCredentials.status).toBe(401);
        expect(invalidCredentials.body.error.code).toBe("INVALID_CREDENTIALS");
        expect(validCredentials.status).toBe(403);
        expect(validCredentials.body.error.code).toBe("ACCOUNT_INACTIVE");
        expect(createSession).not.toHaveBeenCalled();
      });
    } finally {
      lookup.mockRestore();
      createSession.mockRestore();
    }
  });

  it("counts concurrent invalid credentials without penalizing successful attempts", async () => {
    const user = await createRateLimitTestUser("rate-limit-concurrent", "concurrent@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);

    try {
      await withProxyTrust(1, async () => {
        const results = await Promise.all(
          Array.from({ length: 25 }, () => loginAttempt("198.51.100.36", user.email).then(result => result.status)),
        );
        expect(results.filter(status => status === 401)).toHaveLength(20);
        expect(results.filter(status => status === 429)).toHaveLength(5);
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("does not transiently reject concurrent successful logins from the same IP", async () => {
    const user = await createRateLimitTestUser("rate-limit-concurrent-success", "concurrent-success@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);
    const createSession = vi.spyOn(prisma.session, "create").mockResolvedValue({ id: "session-1" } as never);

    try {
      await withProxyTrust(1, async () => {
        const statuses = await Promise.all(
          Array.from(
            { length: 25 },
            () => loginAttempt("198.51.100.44", user.email, rateLimitTestPassword).then(result => result.status),
          ),
        );
        expect(statuses.every(status => status === 200)).toBe(true);
        expect(createSession).toHaveBeenCalledTimes(25);
      });
    } finally {
      lookup.mockRestore();
      createSession.mockRestore();
    }
  });

  it("does not consume the login IP allowance for malformed requests or successful logins", async () => {
    const user = await createRateLimitTestUser("rate-limit-malformed-success", "malformed-success@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);
    const createSession = vi.spyOn(prisma.session, "create").mockResolvedValue({ id: "session-1" } as never);

    try {
      await withProxyTrust(1, async () => {
        const ip = "198.51.100.37";
        for (let attempt = 0; attempt < 60; attempt++) {
          const invalid = await request(app).post("/auth/login").set("X-Forwarded-For", ip)
            .send({ email: "invalid-email", password: "short" });
          expect(invalid.status).toBe(400);
        }

        const successfulLogin = await loginAttempt(ip, user.email, rateLimitTestPassword);
        expect(successfulLogin.status).toBe(200);
        expect(createSession).toHaveBeenCalledOnce();
      });
    } finally {
      lookup.mockRestore();
      createSession.mockRestore();
    }
  });

  it("limits repeated invalid requests by IP and returns the remaining window in Retry-After", async () => {
    const user = await createRateLimitTestUser("rate-limit-request-volume", "request-volume@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);
    const compare = vi.spyOn(bcrypt, "compare");

    try {
      await withProxyTrust(1, async () => {
        const ip = "198.51.100.47";
        const windowStartedAt = Date.now();
        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt(ip, user.email)).status).toBe(401);
        }
        for (let attempt = 20; attempt < 60; attempt++) {
          expect((await loginAttempt(ip, user.email)).status).toBe(429);
        }

        const limited = await loginAttempt(ip, user.email);
        expect(limited.status).toBe(429);
        expectRetryAfterWithinWindow(limited, 60 * 1000, windowStartedAt);
        expect(lookup).toHaveBeenCalledTimes(60);
        expect(compare).toHaveBeenCalledTimes(60);
      });
    } finally {
      lookup.mockRestore();
      compare.mockRestore();
    }
  }, 15_000);

  it("allows repeated successful logins from one IP and creates independent sessions", async () => {
    const user = await createRateLimitTestUser("rate-limit-independent-sessions", "independent@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);
    const createSession = vi.spyOn(prisma.session, "create").mockResolvedValue({ id: "session-1" } as never);
    const cookies: string[] = [];

    try {
      await withProxyTrust(1, async () => {
        for (let attempt = 0; attempt < 61; attempt++) {
          const response = await loginAttempt("198.51.100.48", user.email, rateLimitTestPassword);
          expect(response.status).toBe(200);
          cookies.push(response.headers["set-cookie"][0]);
        }
      });
      expect(new Set(cookies).size).toBe(61);
      expect(createSession).toHaveBeenCalledTimes(61);
      expect(new Set(createSession.mock.calls.map(([input]) => input.data.tokenHash)).size).toBe(61);
    } finally {
      lookup.mockRestore();
      createSession.mockRestore();
    }
  }, 15_000);

  it("keeps a temporary database failure out of the IP failure allowance", async () => {
    const user = await createRateLimitTestUser("rate-limit-request-database", "request-database@example.test");
    const transientError = new Prisma.PrismaClientInitializationError("Connection unavailable", "6.19.3", "P1001");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockRejectedValue(transientError);

    try {
      await withProxyTrust(1, async () => {
        const ip = "198.51.100.49";
        for (let attempt = 0; attempt < 60; attempt++) {
          expect((await loginAttempt(ip, user.email, rateLimitTestPassword)).status).toBe(503);
        }
        lookup.mockResolvedValue(user as never);
        expect((await loginAttempt(ip, user.email)).status).toBe(401);
      });
    } finally {
      lookup.mockRestore();
    }
  }, 15_000);

  it("uses the configured trusted proxy IP, while documenting that forwarded headers need upstream sanitization", async () => {
    const user = await createRateLimitTestUser("rate-limit-proxy", "proxy@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);

    try {
      await withProxyTrust(1, async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt("198.51.100.38", user.email)).status).toBe(401);
        }
        expect((await loginAttempt("198.51.100.39", user.email)).status).toBe(401);
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("ignores forwarded client IPs when proxy trust is disabled", async () => {
    const user = await createRateLimitTestUser("rate-limit-untrusted-proxy", "untrusted-proxy@example.test");
    const lookup = vi.spyOn(prisma.user, "findUnique").mockResolvedValue(user as never);

    try {
      await withProxyTrust(false, async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await loginAttempt("198.51.100.40", user.email)).status).toBe(401);
        }
        expect((await loginAttempt("198.51.100.41", user.email)).status).toBe(429);
        expect(lookup).toHaveBeenCalledTimes(21);
      });
    } finally {
      lookup.mockRestore();
    }
  });
});

describe("other mutation rate limiters", () => {
  it("allows multiple legitimate registrations sharing an IP within the configured allowance", async () => {
    const transaction = vi.spyOn(prisma, "$transaction").mockResolvedValue({
      user: { id: "shared-ip-registration", name: "New Customer", email: "new@example.test", role: "CUSTOMER" },
      token: "shared-ip-session-token",
    } as never);

    try {
      await withProxyTrust(1, async () => {
        const responses = await Promise.all(["one", "two", "three"].map(suffix => request(app)
          .post("/auth/register")
          .set("X-Forwarded-For", "198.51.100.51")
          .send({
            name: `Shared IP Customer ${suffix}`,
            email: `${suffix}@shared-ip.example.test`,
            password: "customer-password-2026!",
            confirmPassword: "customer-password-2026!",
          })));

        expect(responses.map(response => response.status)).toEqual([201, 201, 201]);
        expect(transaction).toHaveBeenCalledTimes(3);
      });
    } finally {
      transaction.mockRestore();
    }
  });

  it("counts public submissions and valid registration attempts while skipping registration validation and server errors", async () => {
    const enquiryCreate = vi.spyOn(prisma.contactEnquiry, "create").mockResolvedValue({
      id: "enquiry-1",
      createdAt: new Date(),
    } as never);
    const transientError = new Prisma.PrismaClientInitializationError("Registration database unavailable", "6.19.3", "P1001");
    const transaction = vi.spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue({
        user: { id: "registration-1", name: "New Customer", email: "new@example.test", role: "CUSTOMER" },
        token: "registration-session-token",
      } as never);

    try {
      await withProxyTrust(1, async () => {
        const ip = "198.51.100.41";
        const validEnquiry = {
          name: "Test Customer",
          email: "test@example.test",
          phoneNumber: "1234567890",
          message: "Please contact me about a device.",
        };
        expect((await request(app).post("/enquiries").set("X-Forwarded-For", ip).send(validEnquiry)).status).toBe(201);
        for (let attempt = 0; attempt < 29; attempt++) {
          expect((await request(app).post("/enquiries").set("X-Forwarded-For", ip).send({ name: "x" })).status).toBe(400);
        }
        expect((await request(app).post("/enquiries").set("X-Forwarded-For", ip).send({ name: "x" })).status).toBe(429);
        expect(enquiryCreate).toHaveBeenCalledOnce();

        const registration = {
          name: "New Customer",
          email: "new@example.test",
          password: "new-password-2026!",
          confirmPassword: "new-password-2026!",
        };
        expect((await request(app).post("/auth/register").set("X-Forwarded-For", ip).send(registration)).status).toBe(503);
        expect((await request(app).post("/auth/register").set("X-Forwarded-For", ip).send({
          name: "x",
          email: "bad",
          password: "short",
          confirmPassword: "short",
        })).status).toBe(400);
        expect((await request(app).post("/auth/register").set("X-Forwarded-For", ip).send(registration)).status).toBe(201);
        for (let attempt = 1; attempt < 30; attempt++) {
          expect((await request(app).post("/auth/register").set("X-Forwarded-For", ip).send(registration)).status).toBe(201);
        }
        const limitedRegistration = await request(app).post("/auth/register").set("X-Forwarded-For", ip).send({
          ...registration,
        });
        expect(limitedRegistration.status).toBe(429);
      });
    } finally {
      enquiryCreate.mockRestore();
      transaction.mockRestore();
    }
  }, 30_000);

  it("keeps the setup limiter failure-sensitive and preserves its retry header", async () => {
    await withProxyTrust(1, async () => {
      const windowStartedAt = Date.now();
      const payload = {
        name: "Initial Admin",
        email: "initial@example.test",
        password: "setup-password-2026!",
        confirmPassword: "setup-password-2026!",
        setupSecret: "not-authorized",
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await request(app).post("/auth/setup").set("X-Forwarded-For", "198.51.100.42").send(payload)).status).toBe(403);
      }
      const limited = await request(app).post("/auth/setup").set("X-Forwarded-For", "198.51.100.42").send(payload);
      expect(limited.status).toBe(429);
      expectRetryAfterWithinWindow(limited, 15 * 60 * 1000, windowStartedAt);
    });
  });

  it("keeps admin mutations limited across successful and failed requests", async () => {
    const token = "admin-rate-limit-test-token";
    const session = vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: "admin-session",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: "admin-1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      user: {
        id: "admin-1",
        name: "Test Admin",
        email: "admin@example.test",
        role: "ADMIN",
        isActive: true,
      },
    } as never);
    const categoryCreate = vi.spyOn(prisma.category, "create").mockResolvedValue({
      id: "category-1",
      name: "Accessories",
      isActive: true,
    } as never);
    const activityCreate = vi.spyOn(prisma.activityLog, "create").mockResolvedValue({ id: "activity-1" } as never);

    try {
      await withProxyTrust(1, async () => {
        const ip = "198.51.100.43";
        const cookie = `mobiedoor_session=${token}`;
        expect((await request(app).post("/admin/categories").set("Cookie", cookie).set("X-Forwarded-For", ip)
          .send({ name: "Accessories" })).status).toBe(201);
        for (let attempt = 0; attempt < 119; attempt++) {
          expect((await request(app).post("/admin/categories").set("Cookie", cookie).set("X-Forwarded-For", ip)
            .send({})).status).toBe(400);
        }
        const limited = await request(app).post("/admin/categories").set("Cookie", cookie).set("X-Forwarded-For", ip)
          .send({});
        expect(limited.status).toBe(429);
        expect(categoryCreate).toHaveBeenCalledOnce();
        expect(activityCreate).toHaveBeenCalledOnce();
      });
    } finally {
      session.mockRestore();
      categoryCreate.mockRestore();
      activityCreate.mockRestore();
    }
  });
});
