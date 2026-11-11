import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupSetupIntegrationTestFixtures,
  trackIntegrationFixtureDependents,
  type IntegrationFixtureIds,
} from "./integration-fixture-cleanup.js";

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
  let originalSetupCompletedAt: Date | null = null;
  const fixtureIds: IntegrationFixtureIds = {
    productIds: [],
    userIds: [],
    enquiryIds: [],
    sessionIds: [],
    activityLogIds: [],
    inventoryAdjustmentIds: [],
  };

  async function cleanupCurrentSetupFixtures() {
    const dependents = await trackIntegrationFixtureDependents(prisma, fixtureIds);
    fixtureIds.sessionIds.push(...dependents.sessionIds);
    fixtureIds.activityLogIds.push(...dependents.activityLogIds);
    fixtureIds.inventoryAdjustmentIds.push(...dependents.inventoryAdjustmentIds);
    await cleanupSetupIntegrationTestFixtures(prisma, fixtureIds);
  }

  beforeAll(async () => {
    const state = await prisma.initialSetupState.findUniqueOrThrow({ where: { id: 1 }, select: { completedAt: true } });
    originalSetupCompletedAt = state.completedAt;
    const privilegedCount = await prisma.user.count({ where: { role: { in: ["FOUNDER", "ADMIN"] } } });
    if (privilegedCount > 0) {
      throw new Error("Initial setup integration tests require a test database without unrelated Founder or Admin accounts.");
    }
  });

  beforeEach(async () => {
    await cleanupCurrentSetupFixtures();
    const privilegedCount = await prisma.user.count({ where: { role: { in: ["FOUNDER", "ADMIN"] } } });
    if (privilegedCount > 0) {
      throw new Error("Initial setup integration tests require a test database without unrelated Founder or Admin accounts.");
    }
    await prisma.initialSetupState.update({ where: { id: 1 }, data: { completedAt: null } });
  });

  afterEach(async () => {
    await cleanupCurrentSetupFixtures();
  });

  afterAll(async () => {
    try {
      await cleanupCurrentSetupFixtures();
      await prisma.initialSetupState.update({ where: { id: 1 }, data: { completedAt: originalSetupCompletedAt } });
    } finally {
      await prisma.$disconnect();
    }
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
      if (typeof created.body.data?.id === "string") fixtureIds.userIds.push(created.body.data.id);
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
      const responses = await Promise.all([1, 2].map(index => request(app).post("/auth/setup").send({
        name: `Concurrent Founder ${index}`,
        email: `${fixturePrefix}-${index}@example.test`,
        password: "founder-password-2026!",
        confirmPassword: "founder-password-2026!",
        setupSecret,
      })));
      fixtureIds.userIds.push(...responses
        .filter(response => response.status === 201 && typeof response.body.data?.id === "string")
        .map(response => response.body.data.id as string));
      expect(responses.filter(response => response.status === 201)).toHaveLength(1);
      expect(responses.filter(response => response.status === 410)).toHaveLength(1);
      expect(await prisma.user.count({ where: { role: "FOUNDER", email: { startsWith: fixturePrefix } } })).toBe(1);
    });

    it("always creates a customer despite a client-supplied privileged role", async () => {
      const response = await request(app).post("/auth/register").send({
        name: "Integration Customer",
        email,
        password: "customer-password-2026!",
        confirmPassword: "customer-password-2026!",
        role: "ADMIN",
      });
      if (typeof response.body.data?.id === "string") fixtureIds.userIds.push(response.body.data.id);
      expect(response.status).toBe(201);
      expect(response.body.data.role).toBe("CUSTOMER");
      expect(response.headers["set-cookie"][0]).toContain("mobiedoor_session=");
      expect(await prisma.session.count({ where: { user: { email } } })).toBe(1);
      const sessionCookie = response.headers["set-cookie"][0].split(";")[0];
      expect((await request(app).get("/auth/me").set("Cookie", sessionCookie)).status).toBe(200);

      const duplicate = await request(app).post("/auth/register").send({
        name: "Integration Customer",
        email,
        password: "customer-password-2026!",
        confirmPassword: "customer-password-2026!",
      });
      expect(duplicate.status).toBe(409);
      expect(await prisma.session.count({ where: { user: { email } } })).toBe(1);
    });
  });
}
