import "dotenv/config";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupIntegrationTestFixtures, trackIntegrationFixtureDependents, type IntegrationFixtureIds } from "./integration-fixture-cleanup.js";

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
  app.set("trust proxy", 1);
  const fixturePrefix = `integration-${Date.now()}`;
  const password = "Integration-password-2026!";
  const users: Record<"founder" | "admin" | "staff" | "customer" | "inactive" | "lastAdmin", { id: string; email: string }> = {} as never;
  const fixtureIds: IntegrationFixtureIds = {
    productIds: [],
    userIds: [],
    enquiryIds: [],
    sessionIds: [],
    activityLogIds: [],
    inventoryAdjustmentIds: [],
  };
  const productIds = fixtureIds.productIds;
  const enquiryIds = fixtureIds.enquiryIds;
  let loginRequestId = 0;

  async function login(email: string) {
    const agent = request.agent(app);
    const response = await agent.post("/auth/login")
      .set("X-Forwarded-For", `198.51.100.${++loginRequestId}`)
      .send({ email, password });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toHaveLength(1);
    expect(response.headers["set-cookie"][0]).toContain("mobiedoor_session=");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"][0]).toContain("Max-Age=28800");
    expect((await agent.get("/auth/me")).status).toBe(200);
    const user = Object.values(users).find(candidate => candidate.email === email);
    if (user) {
      const sessions = await prisma.session.findMany({ where: { userId: user.id }, select: { id: true } });
      fixtureIds.sessionIds.push(...sessions.map(session => session.id));
    }
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
    if (typeof response.body.data?.id === "string") productIds.push(response.body.data.id);
    expect(response.status).toBe(201);
    expect(response.body.data.priceInPaise).toBe(6_500_000);
    expect(response.body.data.originalPriceInPaise).toBe(10_000_000);
    return response.body.data.id as string;
  }

  beforeAll(async () => {
    const existingPrivilegedUsers = await prisma.user.count({ where: { role: { in: ["FOUNDER", "ADMIN"] } } });
    if (existingPrivilegedUsers > 0) {
      throw new Error("Backend integration tests require a test database without pre-existing Founder or Admin accounts.");
    }
    const passwordHash = await hashPassword(password);
    users.founder = await prisma.user.create({ data: { name: `${fixturePrefix} Founder`, email: `${fixturePrefix}-founder@example.test`, passwordHash, role: "FOUNDER" }, select: { id: true, email: true } });
    fixtureIds.userIds.push(users.founder.id);
    users.admin = await prisma.user.create({ data: { name: `${fixturePrefix} Admin`, email: `${fixturePrefix}-admin@example.test`, passwordHash, role: "ADMIN" }, select: { id: true, email: true } });
    fixtureIds.userIds.push(users.admin.id);
    users.staff = await prisma.user.create({ data: { name: `${fixturePrefix} Staff`, email: `${fixturePrefix}-staff@example.test`, passwordHash, role: "STAFF" }, select: { id: true, email: true } });
    fixtureIds.userIds.push(users.staff.id);
    users.customer = await prisma.user.create({ data: { name: `${fixturePrefix} Customer`, email: `${fixturePrefix}-customer@example.test`, passwordHash, role: "CUSTOMER" }, select: { id: true, email: true } });
    fixtureIds.userIds.push(users.customer.id);
    users.inactive = await prisma.user.create({ data: { name: `${fixturePrefix} Inactive`, email: `${fixturePrefix}-inactive@example.test`, passwordHash, role: "STAFF", isActive: false }, select: { id: true, email: true } });
    fixtureIds.userIds.push(users.inactive.id);
    users.lastAdmin = await prisma.user.create({ data: { name: `${fixturePrefix} Last Admin`, email: `${fixturePrefix}-last-admin@example.test`, passwordHash, role: "ADMIN" }, select: { id: true, email: true } });
    fixtureIds.userIds.push(users.lastAdmin.id);
  });

  afterAll(async () => {
    try {
      const dependents = await trackIntegrationFixtureDependents(prisma, fixtureIds);
      fixtureIds.sessionIds.push(...dependents.sessionIds);
      fixtureIds.activityLogIds.push(...dependents.activityLogIds);
      fixtureIds.inventoryAdjustmentIds.push(...dependents.inventoryAdjustmentIds);
      await cleanupIntegrationTestFixtures(prisma, fixtureIds);
    } finally {
      await prisma.$disconnect();
    }
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
        const catalogue = await request(app).get("/products");
        expect(catalogue.status).toBe(200);
        expect(catalogue.body.data.some((product: { id: string }) => product.id === productId)).toBe(true);
        const filteredCatalogue = await request(app).get("/products?category=Integration&sort=price_asc");
        expect(filteredCatalogue.status).toBe(200);
        expect(filteredCatalogue.body.data.some((product: { id: string }) => product.id === productId)).toBe(true);
        const publicProduct = await request(app).get(`/products/${published.body.data.slug}`);
        expect(publicProduct.status).toBe(200);
        expect(publicProduct.body.data).toMatchObject({ priceInPaise: 6_500_000, originalPriceInPaise: 10_000_000 });
        expect((await agent.patch(`/admin/products/${productId}/publish`).send({ isPublished: false })).status).toBe(200);
        expect((await agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 3, reason: `${role} stock receipt` })).status).toBe(200);
        const history = await agent.get("/admin/inventory/history");
        expect(history.status).toBe(200);
        expect(history.body.data.some((item: { product: { name: string } }) => item.product.name.includes(`${fixturePrefix} ${role}`))).toBe(true);
      }
    }, 20_000);

    it("applies inventory adjustments atomically and records the resulting stock", async () => {
      const agent = await login(users.founder.email);
      const productId = await createProduct(agent, "inventory-atomic");

      const increased = await agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 5, reason: "Stock receipt" });
      expect(increased.status).toBe(200);
      expect(increased.body.data).toMatchObject({ stockQuantity: 7, availability: "IN_STOCK" });

      const decreased = await agent.post(`/admin/products/${productId}/inventory`).send({ quantity: -4, reason: "Stock correction" });
      expect(decreased.status).toBe(200);
      expect(decreased.body.data).toMatchObject({ stockQuantity: 3, availability: "LOW_STOCK" });

      const rejected = await agent.post(`/admin/products/${productId}/inventory`).send({ quantity: -4, reason: "Invalid stock reduction" });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatchObject({ code: "INVALID_INVENTORY", message: "Inventory cannot become negative." });
      expect((await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQuantity: true } })).stockQuantity).toBe(3);

      const adjustments = await prisma.inventoryAdjustment.findMany({
        where: { productId },
        select: { quantity: true, stockQuantityAfter: true },
      });
      expect(adjustments).toHaveLength(2);
      expect(adjustments).toEqual(expect.arrayContaining([
        { quantity: 5, stockQuantityAfter: 7 },
        { quantity: -4, stockQuantityAfter: 3 },
      ]));
      const history = await agent.get(`/admin/inventory/history?productId=${productId}`);
      expect(history.status).toBe(200);
      expect(history.body.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ quantity: 5, stockQuantityAfter: 7 }),
        expect.objectContaining({ quantity: -4, stockQuantityAfter: 3 }),
      ]));
    }, 20_000);

    it("serializes concurrent inventory adjustments and keeps history consistent", async () => {
      const agent = await login(users.admin.email);
      const productId = await createProduct(agent, "inventory-concurrent");

      const responses = await Promise.all([
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: -1, reason: "Concurrent reduction" }),
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 3, reason: "Concurrent receipt" }),
      ]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect([
        [1, 4],
        [4, 5],
      ]).toContainEqual(responses.map(response => response.body.data.stockQuantity).sort((a: number, b: number) => a - b));

      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQuantity: true } });
      expect(product.stockQuantity).toBe(4);
      const adjustments = await prisma.inventoryAdjustment.findMany({
        where: { productId },
        select: { quantity: true, stockQuantityAfter: true },
      });
      expect(adjustments).toHaveLength(2);
      const recordedTransitions = adjustments.map(({ quantity, stockQuantityAfter }) => `${quantity}:${stockQuantityAfter}`).sort();
      expect([
        ["-1:1", "3:4"],
        ["-1:4", "3:5"],
      ]).toContainEqual(recordedTransitions);
    }, 20_000);

    it("preserves both simultaneous stock increases and their resulting balances", async () => {
      const agent = await login(users.admin.email);
      const productId = await createProduct(agent, "inventory-concurrent-increases");
      const responses = await Promise.all([
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 2, reason: "Concurrent receipt A" }),
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 3, reason: "Concurrent receipt B" }),
      ]);

      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQuantity: true } });
      expect(product.stockQuantity).toBe(7);
      const adjustments = await prisma.inventoryAdjustment.findMany({
        where: { productId },
        select: { quantity: true, stockQuantityAfter: true },
      });
      expect(adjustments).toHaveLength(2);
      expect(adjustments.map(item => item.quantity).sort((a, b) => a - b)).toEqual([2, 3]);
      const recordedBalances = adjustments.map(item => item.stockQuantityAfter).filter((value): value is number => value !== null);
      expect(recordedBalances).toHaveLength(2);
      expect([[4, 7], [5, 7]]).toContainEqual(recordedBalances.sort((a, b) => a - b));
      const recordedTransitions = adjustments
        .map(({ quantity, stockQuantityAfter }) => [quantity, stockQuantityAfter] as const)
        .sort(([quantityA], [quantityB]) => quantityA - quantityB);
      expect([
        [[2, 4], [3, 7]],
        [[2, 5], [3, 7]],
      ]).toContainEqual(recordedTransitions);
      expect(adjustments.reduce((total, item) => total + item.quantity, 2)).toBe(product.stockQuantity);
    });

    it("preserves simultaneous stock decreases when sufficient stock exists", async () => {
      const agent = await login(users.admin.email);
      const productId = await createProduct(agent, "inventory-concurrent-decreases");
      await agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 5, reason: "Prepare sufficient stock" });

      const responses = await Promise.all([
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: -2, reason: "Concurrent reduction A" }),
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: -3, reason: "Concurrent reduction B" }),
      ]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQuantity: true } });
      expect(product.stockQuantity).toBe(2);
      const adjustments = await prisma.inventoryAdjustment.findMany({
        where: { productId },
        select: { quantity: true, stockQuantityAfter: true },
      });
      const reductions = adjustments.filter(item => item.quantity < 0);
      expect(reductions).toHaveLength(2);
      expect(reductions.map(item => item.quantity).sort((a, b) => a - b)).toEqual([-3, -2]);
      const recordedBalances = reductions.map(item => item.stockQuantityAfter).filter((value): value is number => value !== null);
      expect(recordedBalances).toHaveLength(2);
      expect([
        [2, 5],
        [2, 4],
      ]).toContainEqual(recordedBalances.sort((a, b) => a - b));
      expect([
        ["-2:5", "-3:2"],
        ["-2:2", "-3:4"],
      ]).toContainEqual(reductions.map(item => `${item.quantity}:${item.stockQuantityAfter}`).sort());
      expect(product.stockQuantity).toBe(7 + reductions.reduce((total, item) => total + item.quantity, 0));
    }, 20_000);

    it("allows only valid concurrent reductions when requests compete for insufficient stock", async () => {
      const agent = await login(users.admin.email);
      const productId = await createProduct(agent, "inventory-concurrent-insufficient");

      const responses = await Promise.all([
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: -1, reason: "Concurrent reduction A" }),
        agent.post(`/admin/products/${productId}/inventory`).send({ quantity: -2, reason: "Concurrent reduction B" }),
      ]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
      const succeededIndex = responses.findIndex(response => response.status === 200);
      const rejected = responses.find(response => response.status === 400);
      expect(rejected?.body.error.code).toBe("INVALID_INVENTORY");

      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQuantity: true } });
      const adjustments = await prisma.inventoryAdjustment.findMany({
        where: { productId },
        select: { quantity: true, stockQuantityAfter: true },
      });
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0].quantity).toBe([-1, -2][succeededIndex]);
      expect(adjustments[0].stockQuantityAfter).toBe(2 + adjustments[0].quantity);
      expect(product.stockQuantity).toBe(adjustments[0].stockQuantityAfter);
      expect([0, 1]).toContain(product.stockQuantity);
      expect(adjustments.every(item => (item.stockQuantityAfter ?? -1) >= 0)).toBe(true);
    });

    it("keeps stock changes on product edits disabled while allowing unrelated edits", async () => {
      const agent = await login(users.founder.email);
      const productId = await createProduct(agent, "inventory-edit-guard");

      const stockEdit = await agent.patch(`/admin/products/${productId}`).send({ stockQuantity: 50 });
      expect(stockEdit.status).toBe(400);
      expect(stockEdit.body.error.code).toBe("INVALID_INVENTORY");
      expect((await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQuantity: true } })).stockQuantity).toBe(2);
      expect(await prisma.inventoryAdjustment.count({ where: { productId } })).toBe(0);

      const unrelatedEdit = await agent.patch(`/admin/products/${productId}`).send({ description: "Updated without changing stock." });
      expect(unrelatedEdit.status).toBe(200);
      expect(unrelatedEdit.body.data).toMatchObject({ description: "Updated without changing stock.", stockQuantity: 2 });
      expect(await prisma.inventoryAdjustment.count({ where: { productId } })).toBe(0);
    });

    it("deletes products without inventory history", async () => {
      const agent = await login(users.admin.email);
      const productId = await createProduct(agent, "delete-without-history");

      const deleted = await agent.delete(`/admin/products/${productId}`);

      expect(deleted.status).toBe(204);
      expect(await prisma.product.findUnique({ where: { id: productId } })).toBeNull();
      expect(await prisma.inventoryAdjustment.count({ where: { productId } })).toBe(0);
    });

    it("rejects product deletion with inventory history and preserves that history", async () => {
      const agent = await login(users.admin.email);
      const productId = await createProduct(agent, "delete-with-history");
      const adjustment = await agent.post(`/admin/products/${productId}/inventory`).send({ quantity: 3, reason: "Preserve deletion history" });
      expect(adjustment.status).toBe(200);
      const historyBefore = await prisma.inventoryAdjustment.findMany({
        where: { productId },
        orderBy: { createdAt: "asc" },
        select: { id: true, productId: true, userId: true, quantity: true, stockQuantityAfter: true, reason: true, createdAt: true },
      });

      const deleted = await agent.delete(`/admin/products/${productId}`);

      expect(deleted.status).toBe(409);
      expect(deleted.body.error).toMatchObject({
        code: "PRODUCT_HAS_INVENTORY_HISTORY",
        message: "Products with inventory adjustment history cannot be deleted.",
      });
      expect(await prisma.product.findUnique({ where: { id: productId } })).not.toBeNull();
      expect(await prisma.inventoryAdjustment.findMany({
        where: { productId },
        orderBy: { createdAt: "asc" },
        select: { id: true, productId: true, userId: true, quantity: true, stockQuantityAfter: true, reason: true, createdAt: true },
      })).toEqual(historyBefore);
    });

    it("rejects Staff product deletion", async () => {
      const admin = await login(users.admin.email);
      const productId = await createProduct(admin, "staff-delete-restriction");
      const agent = await login(users.staff.email);

      const deleted = await agent.delete(`/admin/products/${productId}`);

      expect(deleted.status).toBe(403);
      expect(await prisma.product.findUnique({ where: { id: productId } })).not.toBeNull();
    });

    it("persists enquiry status, notes, and activity records", async () => {
      const agent = await login(users.admin.email);
      const created = await request(app).post("/enquiries").send({ name: `${fixturePrefix} Customer`, email: `${fixturePrefix}@example.test`, phoneNumber: "9999999999", message: "Controlled integration enquiry." });
      if (typeof created.body.data?.id === "string") enquiryIds.push(created.body.data.id);
      expect(created.status).toBe(201);
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
        expect(await prisma.user.count({
          where: { role: { in: ["FOUNDER", "ADMIN"] }, isActive: true },
        })).toBe(1);
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
