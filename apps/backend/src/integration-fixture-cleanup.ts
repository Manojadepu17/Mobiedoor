import type { PrismaClient } from "@prisma/client";

export type IntegrationFixtureIds = {
  productIds: string[];
  userIds: string[];
  enquiryIds: string[];
  sessionIds: string[];
  activityLogIds: string[];
  inventoryAdjustmentIds: string[];
};

function uniqueIds(ids: string[]) {
  return [...new Set(ids)];
}

export async function trackIntegrationFixtureDependents(
  prisma: PrismaClient,
  fixtureIds: Pick<IntegrationFixtureIds, "productIds" | "userIds" | "enquiryIds">,
) {
  const productIds = uniqueIds(fixtureIds.productIds);
  const userIds = uniqueIds(fixtureIds.userIds);
  const entityIds = uniqueIds([...productIds, ...fixtureIds.enquiryIds]);
  const [sessions, activityLogs, inventoryAdjustments] = await prisma.$transaction([
    prisma.session.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    }),
    prisma.activityLog.findMany({
      where: { OR: [{ userId: { in: userIds } }, { entityId: { in: entityIds } }] },
      select: { id: true },
    }),
    prisma.inventoryAdjustment.findMany({
      where: { OR: [{ productId: { in: productIds } }, { userId: { in: userIds } }] },
      select: { id: true },
    }),
  ]);

  return {
    sessionIds: sessions.map(record => record.id),
    activityLogIds: activityLogs.map(record => record.id),
    inventoryAdjustmentIds: inventoryAdjustments.map(record => record.id),
  };
}

export async function cleanupIntegrationTestFixtures(prisma: PrismaClient, fixtureIds: IntegrationFixtureIds) {
  const productIds = uniqueIds(fixtureIds.productIds);
  const userIds = uniqueIds(fixtureIds.userIds);
  const enquiryIds = uniqueIds(fixtureIds.enquiryIds);

  await prisma.$transaction(async transaction => {
    await transaction.activityLog.deleteMany({ where: { id: { in: uniqueIds(fixtureIds.activityLogIds) } } });
    await transaction.session.deleteMany({ where: { id: { in: uniqueIds(fixtureIds.sessionIds) } } });
    await transaction.inventoryAdjustment.deleteMany({ where: { id: { in: uniqueIds(fixtureIds.inventoryAdjustmentIds) } } });
    await transaction.contactEnquiry.deleteMany({ where: { id: { in: enquiryIds } } });
    await transaction.product.deleteMany({ where: { id: { in: productIds } } });
    await transaction.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

export async function cleanupSetupIntegrationTestFixtures(
  prisma: PrismaClient,
  fixtureIds: Pick<IntegrationFixtureIds, "userIds" | "sessionIds" | "activityLogIds" | "inventoryAdjustmentIds">,
) {
  await prisma.$transaction(async transaction => {
    await transaction.activityLog.deleteMany({ where: { id: { in: uniqueIds(fixtureIds.activityLogIds) } } });
    await transaction.session.deleteMany({ where: { id: { in: uniqueIds(fixtureIds.sessionIds) } } });
    await transaction.inventoryAdjustment.deleteMany({ where: { id: { in: uniqueIds(fixtureIds.inventoryAdjustmentIds) } } });
    await transaction.user.deleteMany({ where: { id: { in: uniqueIds(fixtureIds.userIds) } } });
  });
}
