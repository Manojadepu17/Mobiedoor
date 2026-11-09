import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const setupSecret = "integration-only-setup-secret-2026";

function isSafeTestUrl(value: string) {
  try {
    const parsed = new URL(value);
    const databaseName = parsed.pathname.replace(/^\/+/, "").toLowerCase();
    return parsed.protocol === "mysql:" &&
      databaseName.length > 0 &&
      databaseName !== "mobiedoor" &&
      !/(prod|production|live|staging)/i.test(databaseName);
  } catch {
    return false;
  }
}

if (!testDatabaseUrl) {
  describe("initial setup integration", () => {
    it.skip("requires TEST_DATABASE_URL; no database operation was attempted", () => undefined);
  });
} else if (!isSafeTestUrl(testDatabaseUrl)) {
  throw new Error("TEST_DATABASE_URL must be a MySQL URL for a separate non-production database.");
} else {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NODE_ENV = "test";
  process.env.INITIAL_SETUP_SECRET = setupSecret;

  const { app } = await import("./server.js");
  const { prisma } = await import("./lib/prisma.js");
  const fixturePrefix = `setup-integration-${Date.now()}`;
  const email = `${fixturePrefix}@example.test`;

  async function resetSetupFixture() {
    await prisma.session.deleteMany({ where: { user: { email: { startsWith: fixturePrefix } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: fixturePrefix } } });
    await prisma.initialSetupState.update({ where: { id: 1 }, data: { completedAt: null } });
  }

  beforeAll(async () => {
    await resetSetupFixture();
  });

  afterAll(async () => {
    await resetSetupFixture();
    await prisma.$disconnect();
  });

  describe("initial setup security", () => {
    it("creates one Founder with valid authorization and then disables setup", async () => {
      const created = await request(app).post("/auth/setup").send({
        name: "Integration Founder",
        email,
        password: "founder-password-2026!",
        confirmPassword: "founder-password-2026!",
        setupSecret,
      });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ email, role: "FOUNDER" });
      expect(created.body.data.passwordHash).toBeUndefined();

      const secondAttempt = await request(app).post("/auth/setup").send({
        name: "Second Founder",
        email: `second-${email}`,
        password: "founder-password-2026!",
        confirmPassword: "founder-password-2026!",
        setupSecret,
      });
      expect(secondAttempt.status).toBe(410);
    });

    it("denies setup with an invalid secret", async () => {
      await resetSetupFixture();
      const response = await request(app).post("/auth/setup").send({
        name: "Unauthorized Founder",
        email,
        password: "founder-password-2026!",
        confirmPassword: "founder-password-2026!",
        setupSecret: "wrong-secret",
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("SETUP_NOT_AUTHORIZED");
    });

    it("allows only one concurrent initial setup request", async () => {
      await resetSetupFixture();
      const responses = await Promise.all([1, 2].map(index => request(app).post("/auth/setup").send({
        name: `Concurrent Founder ${index}`,
        email: `${fixturePrefix}-${index}@example.test`,
        password: "founder-password-2026!",
        confirmPassword: "founder-password-2026!",
        setupSecret,
      })));
      expect(responses.filter(response => response.status === 201)).toHaveLength(1);
      expect(responses.filter(response => response.status === 410)).toHaveLength(1);
      expect(await prisma.user.count({ where: { role: "FOUNDER", email: { startsWith: fixturePrefix } } })).toBe(1);
    });

    it("always creates a customer despite a client-supplied privileged role", async () => {
      await resetSetupFixture();
      const response = await request(app).post("/auth/register").send({
        name: "Integration Customer",
        email,
        password: "customer-password-2026!",
        confirmPassword: "customer-password-2026!",
        role: "ADMIN",
      });
      expect(response.status).toBe(201);
      expect(response.body.data.role).toBe("CUSTOMER");
    });
  });
}
