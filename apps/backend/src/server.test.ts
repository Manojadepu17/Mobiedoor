import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { app, generateCloudinarySignature, getCloudinaryErrorDetails, isCloudinaryImageUrl, isProductInventoryHistoryConstraintError } from "./server.js";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";

vi.mock("./auth.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return { ...actual, cleanupExpiredSessions: vi.fn().mockResolvedValue({ count: 0 }) };
});

describe("public API security and contracts", () => {
  it("adds no-store cache protection to successful API responses", async () => {
    const response = await request(app)
      .options("/auth/login")
      .set("Origin", config.frontendUrl)
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("private, no-store");
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
