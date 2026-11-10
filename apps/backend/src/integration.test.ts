import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

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
  describe("authenticated database integration", () => {
    it.skip("requires TEST_DATABASE_URL; no database operation was attempted", () => undefined);
  });
} else if (!isSafeTestUrl(testDatabaseUrl)) {
  throw new Error("TEST_DATABASE_URL must be a MySQL URL for a separate non-production database.");
} else {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NODE_ENV = "test";

  const { app } = await import("./server.js");
  const { hashPassword } = await import("./auth.js");
  const { prisma } = await import("./lib/prisma.js");
  const fixturePrefix = `integration-${Date.now()}`;
  const password = "Integration-password-2026!";
  const users: Record<"founder" | "admin" | "staff" | "customer" | "inactive" | "lastAdmin", { id: string; email: string }> = {} as never;
  const productIds: string[] = [];
  const enquiryIds: string[] = [];

  async function login(email: string) {
    const agent = request.agent(app);
    const response = await agent.post("/auth/login").send({ email, password });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toHaveLength(1);
    expect(response.headers["set-cookie"][0]).toContain("mobiedoor_session=");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"][0]).toContain("Max-Age=28800");
    expect((await agent.get("/auth/me")).status).toBe(200);
    return agent;
  }

  async function createProduct(agent: ReturnType<typeof request.agent>, suffix: string) {
    const response = await agent.post("/admin/products").send({
      name: `${fixturePrefix} ${suffix}`,
      sku: `${fixturePrefix}-${suffix}`.slice(0, 80),
      brand: "MobieDoor Test",
      model: suffix,
      slug: `${fixturePrefix}-${suffix}`.toLowerCase(),
      description: "Controlled integration-test product record.",
      priceInPaise: 6_500_000,
      originalPriceInPaise: 10_000_000,
      condition: "EXCELLENT",
      category: "Integration",
      stockQuantity: 2,
      specifications: {},
      imageUrls: [],
      isPublished: false,
    });
    expect(response.status).toBe(201);
    expect(response.body.data.priceInPaise).toBe(6_500_000);
    expect(response.body.data.originalPriceInPaise).toBe(10_000_000);
    productIds.push(response.body.data.id);
    return response.body.data.id as string;
  }

  beforeAll(async () => {
    const passwordHash = await hashPassword(password);
    users.founder = await prisma.user.create({ data: { name: `${fixturePrefix} Founder`, email: `${fixturePrefix}-founder@example.test`, passwordHash, role: "FOUNDER" }, select: { id: true, email: true } });
    users.admin = await prisma.user.create({ data: { name: `${fixturePrefix} Admin`, email: `${fixturePrefix}-admin@example.test`, passwordHash, role: "ADMIN" }, select: { id: true, email: true } });
    users.staff = await prisma.user.create({ data: { name: `${fixturePrefix} Staff`, email: `${fixturePrefix}-staff@example.test`, passwordHash, role: "STAFF" }, select: { id: true, email: true } });
    users.customer = await prisma.user.create({ data: { name: `${fixturePrefix} Customer`, email: `${fixturePrefix}-customer@example.test`, passwordHash, role: "CUSTOMER" }, select: { id: true, email: true } });
    users.inactive = await prisma.user.create({ data: { name: `${fixturePrefix} Inactive`, email: `${fixturePrefix}-inactive@example.test`, passwordHash, role: "STAFF", isActive: false }, select: { id: true, email: true } });
    users.lastAdmin = await prisma.user.create({ data: { name: `${fixturePrefix} Last Admin`, email: `${fixturePrefix}-last-admin@example.test`, passwordHash, role: "ADMIN" }, select: { id: true, email: true } });
  });

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { userId: { in: Object.values(users).map(user => user.id) } } });
    await prisma.session.deleteMany({ where: { userId: { in: Object.values(users).map(user => user.id) } } });
    await prisma.contactEnquiry.deleteMany({ where: { id: { in: enquiryIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map(user => user.id) } } });
    await prisma.$disconnect();
  });

  describe("authenticated database workflows", () => {
    it("supports login, session lookup, logout, and invalidation", async () => {
      const agent = await login(users.founder.email);
      expect((await agent.get("/auth/me")).status).toBe(200);
      expect((await agent.post("/auth/logout")).status).toBe(204);
      expect((await agent.get("/auth/me")).status).toBe(401);
    });

    it("rejects inactive users before creating a session", async () => {
      const response = await request(app).post("/auth/login").send({ email: users.inactive.email, password });
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: "ACCOUNT_INACTIVE" });
      expect(response.body.error.message).toContain("inactive");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await prisma.session.count({ where: { userId: users.inactive.id } })).toBe(0);
    });

    it("gives Founder and Admin equivalent product and inventory permissions", async () => {
      for (const [role, email] of [["founder", users.founder.email], ["admin", users.admin.email]] as const) {
        const agent = await login(email);
        const productId = await createProduct(agent, role);
        const edited = await agent.patch(`/admin/products/${productId}`).send({
          description: `Edited by ${role}`,
          priceInPaise: 6_500_000,
          originalPriceInPaise: 10_000_000,
        });
        expect(edited.status).toBe(200);
        expect(edited.body.data).toMatchObject({ priceInPaise: 6_500_000, originalPriceInPaise: 10_000_000 });
        const published = await agent.patch(`/admin/products/${productId}/publish`).send({ isPublished: true });
        expect(published.status).toBe(200);
        expect(published.body.data).toMatchObject({ priceInPaise: 6_500_000, originalPriceInPaise: 10_000_000 });
        const publicProduct = await request(app).get(`/products/${published.body.data.slug}`);
        expect(publicProduct.status).toBe(200);
        expect(publicProduct.body.data).toMatchObject({ priceInPaise: 6_500_000, originalPriceInPaise: 10_000_000 });
        expect((await agent.patch(`/admin/products/${productId}/publish`).send({ isPublished: false })).status).toBe(200);
        expect((await agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 3, reason: `${role} stock receipt` })).status).toBe(200);
        const history = await agent.get("/admin/inventory/history");
        expect(history.status).toBe(200);
        expect(history.body.data.some((item: { product: { name: string } }) => item.product.name.includes(`${fixturePrefix} ${role}`))).toBe(true);
      }
    });

    it("persists enquiry status, notes, and activity records", async () => {
      const agent = await login(users.admin.email);
      const created = await request(app).post("/enquiries").send({ name: `${fixturePrefix} Customer`, email: `${fixturePrefix}@example.test`, phoneNumber: "9999999999", message: "Controlled integration enquiry." });
      expect(created.status).toBe(201);
      enquiryIds.push(created.body.data.id);
      const updated = await agent.patch(`/admin/enquiries/${created.body.data.id}`).send({ status: "IN_PROGRESS", adminNotes: "Fixture note" });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({ status: "IN_PROGRESS", adminNotes: "Fixture note" });
      const activity = await agent.get("/admin/activity?action=UPDATE_STATUS");
      expect(activity.status).toBe(200);
      expect(activity.body.data.some((item: { entityId?: string }) => item.entityId === created.body.data.id)).toBe(true);
    });

    it("rejects Staff from restricted direct API operations", async () => {
      const agent = await login(users.staff.email);
      expect((await agent.post("/admin/products").send({})).status).toBe(403);
      expect((await agent.post("/admin/staff").send({})).status).toBe(403);
      expect((await agent.post("/admin/categories").send({ name: `${fixturePrefix} Category` })).status).toBe(403);
      expect((await agent.put("/admin/settings/integration-test").send({ value: "not allowed" })).status).toBe(403);
      expect((await agent.patch(`/admin/products/${productIds[0]}/publish`).send({ isPublished: true })).status).toBe(403);
      expect((await agent.post(`/admin/products/${productIds[0]}/inventory`).send({ quantity: 1, reason: "not allowed" })).status).toBe(403);
    });

    it("limits staff management to operational roles and protects Founder accounts", async () => {
      const agent = await login(users.founder.email);
      const listed = await agent.get("/admin/staff");
      expect(listed.status).toBe(200);
      expect(listed.body.data.every((user: { role: string }) => ["ADMIN", "STAFF"].includes(user.role))).toBe(true);
      expect(listed.body.data.some((user: { id: string }) => user.id === users.customer.id)).toBe(false);
      expect(listed.body.data.some((user: { id: string }) => user.id === users.founder.id)).toBe(false);
      expect((await (await login(users.admin.email)).get("/admin/staff")).status).toBe(200);

      const escalateCustomer = await agent.patch(`/admin/staff/${users.customer.id}`).send({ role: "ADMIN" });
      expect(escalateCustomer.status).toBe(404);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: users.customer.id }, select: { role: true } })).role).toBe("CUSTOMER");

      const deactivateFounder = await agent.patch(`/admin/staff/${users.founder.id}`).send({ isActive: false });
      expect(deactivateFounder.status).toBe(403);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: users.founder.id }, select: { isActive: true } })).isActive).toBe(true);
    });

    it("prevents disabling the last active Founder or Admin", async () => {
      await prisma.user.updateMany({
        where: { id: { in: [users.founder.id, users.admin.id] } },
        data: { isActive: false },
      });
      try {
        const agent = await login(users.lastAdmin.email);
        const response = await agent.patch(`/admin/staff/${users.lastAdmin.id}`).send({ isActive: false });
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("LAST_ACTIVE_ADMIN");
        expect((await prisma.user.findUniqueOrThrow({ where: { id: users.lastAdmin.id }, select: { isActive: true } })).isActive).toBe(true);
      } finally {
        await prisma.user.updateMany({
          where: { id: { in: [users.founder.id, users.admin.id] } },
          data: { isActive: true },
        });
      }
    });
  });
}
