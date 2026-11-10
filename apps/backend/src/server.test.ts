import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, getCloudinaryErrorDetails, isCloudinaryImageUrl } from "./server.js";
import { config } from "./config.js";

describe("public API security and contracts", () => {
  it("extracts sanitized Cloudinary provider diagnostics", () => {
    expect(getCloudinaryErrorDetails({
      error: { message: "The secret value was echoed", name: "Error", code: "401", http_code: 401 },
    }, 502)).toEqual({
      cloudinaryErrorStatus: 401,
    });
  });

  it("accepts only HTTPS Cloudinary image URLs for product records", () => {
    expect(isCloudinaryImageUrl("https://res.cloudinary.com/demo/image/upload/sample.jpg")).toBe(true);
    expect(isCloudinaryImageUrl("http://localhost:4000/uploads/product.jpg")).toBe(false);
    expect(isCloudinaryImageUrl("https://example.com/product.jpg")).toBe(false);
  });

  it("uses the configured proxy trust policy before rate limiting", async () => {
    expect(app.get("trust proxy")).toBe(config.trustProxy);

    const response = await request(app).post("/auth/login").send({ email: "not-an-email", password: "short" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("reports a database-backed healthy service", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", database: "ok" });
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
