import "dotenv/config";
import type { Server } from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { imageSize } from "image-size";
import { z } from "zod";
import { Prisma, ProductAvailability, UserRole } from "@prisma/client";
import { prisma } from "./lib/prisma.js";
import { cleanupExpiredSessions, createSession, createSessionInTransaction, destroySession, hashPassword, recordActivity, requireAuth, requireRoles, setSessionCookie, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const app = express();
app.set("trust proxy", config.trustProxy);
const port = config.port;
const MAX_PAGE_SIZE = 50;
const MAX_DATABASE_PRICE_IN_PAISE = 2_147_483_647;
const CLOUDINARY_UPLOAD_TIMEOUT_MS = 30_000;
const adminRoles = [UserRole.FOUNDER, UserRole.ADMIN];

export function isCloudinaryImageUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com";
  } catch {
    return false;
  }
}

export function generateCloudinarySignature(publicId: string, timestamp: number, apiSecret: string) {
  const signingInput = `folder=mobiedoor/products&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  return createHash("sha1").update(signingInput).digest("hex");
}

type CloudinaryErrorBody = {
  secure_url?: unknown;
  error?: unknown;
};

export function getCloudinaryErrorDetails(body: CloudinaryErrorBody, responseStatus: number) {
  const providerError = isRecord(body.error) ? body.error : {};
  const providerStatus = [providerError.http_code, providerError.status, providerError.statusCode]
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  return {
    cloudinaryErrorStatus: providerStatus ?? responseStatus,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const publicProductSelect = {
  id: true, name: true, slug: true, sku: true, brand: true, model: true, description: true,
  priceInPaise: true, originalPriceInPaise: true, condition: true, category: true,
  stockQuantity: true, availability: true, warrantyMonths: true, specifications: true, imageUrls: true,
} as const;

const enquirySchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254),
  phoneNumber: z.string().trim().min(7).max(25),
  message: z.string().trim().min(10).max(5000),
});
const tradeInSchema = z.object({
  customerName: z.string().trim().min(2).max(100), phoneNumber: z.string().trim().min(7).max(25),
  email: z.string().trim().email().max(254).optional(), city: z.string().trim().min(2).max(100),
  deviceBrand: z.string().trim().min(2).max(80), deviceModel: z.string().trim().min(1).max(120),
  deviceCondition: z.string().trim().min(2).max(80), purchaseYear: z.coerce.number().int().min(1980).max(new Date().getFullYear()).optional(),
  additionalDescription: z.string().trim().max(5000).optional(),
});
const partnershipSchema = z.object({
  companyName: z.string().trim().min(2).max(150), contactName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254), phoneNumber: z.string().trim().min(7).max(25),
  city: z.string().trim().min(2).max(100), message: z.string().trim().min(10).max(5000),
});
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(10).max(200) });
const setupSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(10).max(200),
  confirmPassword: z.string().min(10).max(200),
  setupSecret: z.string().min(1).max(500),
}).refine(input => input.password === input.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });
const registrationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(10).max(200),
  confirmPassword: z.string().min(10).max(200),
}).refine(input => input.password === input.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });
const productFieldsSchema = z.object({
  name: z.string().trim().min(2).max(150), sku: z.string().trim().min(1).max(80),
  brand: z.string().trim().min(2).max(80), model: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180),
  description: z.string().trim().min(10).max(10000), priceInPaise: z.number().int().min(0).max(MAX_DATABASE_PRICE_IN_PAISE),
  originalPriceInPaise: z.number().int().min(0).max(MAX_DATABASE_PRICE_IN_PAISE).nullable().optional(), condition: z.enum(["LIKE_NEW", "EXCELLENT", "GOOD", "FAIR"]),
  category: z.string().trim().min(2).max(80), stockQuantity: z.coerce.number().int().min(0).max(100000),
  warrantyMonths: z.coerce.number().int().min(0).max(120).optional(), specifications: z.record(z.string(), z.unknown()).default({}),
  imageUrls: z.array(z.string().url().refine(isCloudinaryImageUrl, "Product images must use Cloudinary HTTPS URLs.")).max(20).default([]), isPublished: z.boolean().default(false),
});
function validateProductPrices(input: { priceInPaise?: number; originalPriceInPaise?: number | null }, context: z.RefinementCtx) {
  if (input.priceInPaise !== undefined && input.originalPriceInPaise != null && input.originalPriceInPaise <= input.priceInPaise) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["originalPriceInPaise"], message: "Original price must be greater than the selling price." });
  }
}
const productSchema = productFieldsSchema.superRefine(validateProductPrices);
const productUpdateSchema = productFieldsSchema.partial().superRefine(validateProductPrices);
const statusSchema = z.object({ status: z.enum(["NEW", "IN_PROGRESS", "RESOLVED", "ARCHIVED"]).optional(), adminNotes: z.string().trim().max(5000).optional() }).refine(input => input.status !== undefined || input.adminNotes !== undefined, "A status or note is required.");
const staffSchema = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(254), password: z.string().min(10).max(200), role: z.enum(["ADMIN", "STAFF"]) });
const staffUpdateSchema = z.object({ name: z.string().trim().min(2).max(100).optional(), email: z.string().trim().email().max(254).optional(), password: z.string().min(10).max(200).optional(), role: z.enum(["ADMIN", "STAFF"]).optional(), isActive: z.boolean().optional() });
const categorySchema = z.object({ name: z.string().trim().min(2).max(80), isActive: z.boolean().default(true) });
const settingSchema = z.object({ value: z.string().trim().max(10000) });

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.use((request, response, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    next();
    return;
  }
  const origin = request.get("origin");
  if (origin && origin !== config.frontendUrl) {
    response.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." } });
    return;
  }
  if (config.isProduction && !origin) {
    response.status(403).json({ error: { code: "ORIGIN_REQUIRED", message: "A request origin is required for this operation." } });
    return;
  }
  next();
});

const publicMutationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Too many submissions. Please try again later." } } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
const setupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false });
const adminMutationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Too many admin changes. Please try again later." } } });
const productImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

const cleanupTimer = setInterval(() => { void cleanupExpiredSessions().catch(error => logger.error("Session cleanup failed", error)); }, 60 * 60 * 1000);
cleanupTimer.unref();
void cleanupExpiredSessions().catch(error => logger.error("Session cleanup failed", error));

app.get("/health", async (_request, response, next) => {
  try { await prisma.$queryRaw`SELECT 1`; response.json({ status: "ok", service: "mobiedoor-api", database: "ok" }); } catch (error) { next(error); }
});

app.get("/products", async (request, response, next) => {
  try {
    const query = z.object({
      search: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional(),
      sort: z.enum(["featured", "price_asc", "price_desc", "newest"]).default("featured"),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(12),
    }).parse(request.query);
    const where = { isPublished: true, ...(query.category && query.category !== "All devices" ? { category: query.category } : {}), ...(query.search ? { OR: [{ name: { contains: query.search } }, { brand: { contains: query.search } }, { model: { contains: query.search } }] } : {}) };
    const orderBy = query.sort === "price_asc" ? { priceInPaise: "asc" as const } : query.sort === "price_desc" ? { priceInPaise: "desc" as const } : { createdAt: "desc" as const };
    const [products, total] = await prisma.$transaction([prisma.product.findMany({ where, select: publicProductSelect, orderBy, skip: (query.page - 1) * query.limit, take: query.limit }), prisma.product.count({ where })]);
    response.json({ data: products, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) { next(error); }
});

app.get("/products/:id", async (request, response, next) => {
  try {
    const productId = getParam(request, "id");
    const product = await prisma.product.findFirst({ where: { isPublished: true, OR: [{ id: productId }, { slug: productId }] }, select: publicProductSelect });
    if (!product) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Product not found." } }); return; }
    response.json({ data: product });
  } catch (error) { next(error); }
});

app.get("/categories", async (_request, response, next) => {
  try {
    const [managed, legacy] = await prisma.$transaction([
      prisma.category.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { name: true } }),
      prisma.product.findMany({ where: { isPublished: true }, distinct: ["category"], orderBy: { category: "asc" }, select: { category: true } }),
    ]);
    response.json({ data: [...new Set([...managed.map(row => row.name), ...legacy.map(row => row.category)])] });
  } catch (error) { next(error); }
});

app.post("/enquiries", publicMutationLimiter, async (request, response, next) => {
  try { const data = await prisma.contactEnquiry.create({ data: enquirySchema.parse(request.body), select: { id: true, createdAt: true } }); response.status(201).json({ data, message: "Your enquiry has been received." }); } catch (error) { next(error); }
});
app.post("/trade-in", publicMutationLimiter, async (request, response, next) => {
  try { const data = await prisma.tradeInEnquiry.create({ data: tradeInSchema.parse(request.body), select: { id: true, createdAt: true } }); response.status(201).json({ data, message: "Your trade-in request has been received." }); } catch (error) { next(error); }
});
app.post("/partnerships", publicMutationLimiter, async (request, response, next) => {
  try { const data = await prisma.partnershipEnquiry.create({ data: partnershipSchema.parse(request.body), select: { id: true, createdAt: true } }); response.status(201).json({ data, message: "Your partnership enquiry has been received." }); } catch (error) { next(error); }
});

app.post("/auth/login", loginLimiter, async (request, response, next) => {
  try {
    const { email, password } = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) { response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } }); return; }
    if (!user.isActive) { response.status(403).json({ error: { code: "ACCOUNT_INACTIVE", message: "This account is inactive. Contact an administrator for assistance." } }); return; }
    const authUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    await createSession(authUser, response);
    response.json({ data: authUser });
  } catch (error) { next(error); }
});
app.get("/auth/setup-status", async (_request, response, next) => {
  try {
    if (!isSetupSecretConfigured()) {
      response.json({ data: { available: false } });
      return;
    }
    const state = await prisma.initialSetupState.findUnique({ where: { id: 1 }, select: { completedAt: true } });
    const privilegedCount = await prisma.user.count({ where: { role: { in: adminRoles } } });
    response.json({ data: { available: !state?.completedAt && privilegedCount === 0 } });
  } catch (error) { next(error); }
});
app.post("/auth/setup", setupLimiter, async (request, response, next) => {
  try {
    const input = setupSchema.parse(request.body);
    if (!isSetupSecretConfigured() || !secretsMatch(input.setupSecret, config.initialSetupSecret!)) {
      response.status(403).json({ error: { code: "SETUP_NOT_AUTHORIZED", message: "Initial setup is not authorized." } });
      return;
    }
    const passwordHash = await hashPassword(input.password);
    const user = await prisma.$transaction(async transaction => {
      const state = await transaction.$queryRaw<Array<{ id: number; completed_at: Date | null }>>`SELECT id, completed_at FROM initial_setup_state WHERE id = 1 FOR UPDATE`;
      if (state.length !== 1 || state[0].completed_at) throw new SetupUnavailableError();
      const privilegedCount = await transaction.user.count({ where: { role: { in: adminRoles } } });
      if (privilegedCount > 0) throw new SetupUnavailableError();
      const created = await transaction.user.create({
        data: { name: input.name, email: input.email, passwordHash, role: UserRole.FOUNDER },
        select: { id: true, name: true, email: true, role: true },
      });
      await transaction.initialSetupState.update({ where: { id: 1 }, data: { completedAt: new Date() } });
      return created;
    });
    response.status(201).json({ data: user, message: "Initial Founder account created. Please sign in." });
  } catch (error) {
    if (error instanceof SetupUnavailableError) {
      response.status(410).json({ error: { code: "SETUP_COMPLETED", message: "Initial setup is no longer available." } });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: { code: "EMAIL_ALREADY_REGISTERED", message: "An account with that email already exists." } });
      return;
    }
    next(error);
  }
});
app.post("/auth/register", publicMutationLimiter, async (request, response, next) => {
  try {
    const input = registrationSchema.parse(request.body);
    const passwordHash = await hashPassword(input.password);
    const { user, token } = await prisma.$transaction(async transaction => {
      const createdUser = await transaction.user.create({
        data: { name: input.name, email: input.email, passwordHash, role: UserRole.CUSTOMER },
        select: { id: true, name: true, email: true, role: true },
      });
      const authUser = { id: createdUser.id, name: createdUser.name, email: createdUser.email, role: createdUser.role };
      return { user: authUser, token: await createSessionInTransaction(authUser, transaction) };
    });
    setSessionCookie(response, token);
    response.status(201).json({ data: user, message: "Your customer account has been created." });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: { code: "EMAIL_ALREADY_REGISTERED", message: "An account with that email already exists." } });
      return;
    }
    next(error);
  }
});
app.post("/auth/logout", requireAuth, async (request, response, next) => {
  try { await destroySession(request, response); response.status(204).send(); } catch (error) { next(error); }
});
app.get("/auth/me", requireAuth, (request, response) => response.json({ data: request.user }));

app.post("/admin/product-images", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, productImageUpload.single("image"), async (request, response, next) => {
  try {
    const file = request.file;
    if (!file) {
      response.status(400).json({ error: { code: "IMAGE_REQUIRED", message: "Select a product image to upload." } });
      return;
    }
    const detected = await fileTypeFromBuffer(file.buffer);
    const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!detected || !allowedTypes.has(detected.mime)) {
      response.status(400).json({ error: { code: "UNSUPPORTED_IMAGE", message: "Only JPG, PNG, and WebP images are supported." } });
      return;
    }
    const dimensions = imageSize(file.buffer);
    if (!dimensions.width || !dimensions.height || dimensions.width < 200 || dimensions.height < 200 || dimensions.width > 10000 || dimensions.height > 10000) {
      response.status(400).json({ error: { code: "INVALID_IMAGE_DIMENSIONS", message: "Image dimensions must be between 200px and 10,000px." } });
      return;
    }
    const { cloudinaryCloudName, cloudinaryApiKey, cloudinaryApiSecret } = config;
    if (cloudinaryCloudName && cloudinaryApiKey && cloudinaryApiSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const publicId = `product-${randomUUID()}`;
      const signature = generateCloudinarySignature(publicId, timestamp, cloudinaryApiSecret);
      const form = new FormData();
      const fileBytes = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength) as ArrayBuffer;
      form.append("file", new Blob([fileBytes], { type: detected.mime }), file.originalname);
      form.append("api_key", cloudinaryApiKey);
      form.append("timestamp", String(timestamp));
      form.append("public_id", publicId);
      form.append("folder", "mobiedoor/products");
      form.append("signature", signature);
      let cloudinaryResponse: Response;
      let cloudinaryBody: CloudinaryErrorBody;
      try {
        cloudinaryResponse = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/image/upload`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(CLOUDINARY_UPLOAD_TIMEOUT_MS),
        });
        const responseBody: unknown = await cloudinaryResponse.json();
        cloudinaryBody = isRecord(responseBody)
          ? { secure_url: responseBody.secure_url, error: responseBody.error }
          : {};
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        logger.error("Cloudinary image upload request failed", undefined, { timedOut });
        response.status(502).json({ error: {
          code: timedOut ? "IMAGE_STORAGE_TIMEOUT" : "IMAGE_STORAGE_UNAVAILABLE",
          message: timedOut ? "The image upload timed out. Please try again." : "Cloudinary could not be reached. Please try again.",
        } });
        return;
      }
      if (!cloudinaryResponse.ok || typeof cloudinaryBody.secure_url !== "string" || !isCloudinaryImageUrl(cloudinaryBody.secure_url)) {
        const diagnostics = getCloudinaryErrorDetails(cloudinaryBody, cloudinaryResponse.status);
        logger.error("Cloudinary image upload failed", undefined, diagnostics);
        response.status(502).json({ error: { code: "IMAGE_STORAGE_FAILED", message: "Cloudinary rejected the image. Check the backend configuration and try again." } });
        return;
      }
      await recordActivity(request.user!.id, "UPLOAD", "PRODUCT_IMAGE", publicId);
      response.status(201).json({ data: { url: cloudinaryBody.secure_url, width: dimensions.width, height: dimensions.height } });
      return;
    }
    if (config.isProduction) {
      response.status(503).json({ error: { code: "IMAGE_STORAGE_NOT_CONFIGURED", message: "Cloud image storage is not configured. Set the Cloudinary environment variables before uploading images." } });
      return;
    }
    response.status(503).json({ error: { code: "IMAGE_STORAGE_NOT_CONFIGURED", message: "Cloud image storage is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET on the backend before uploading images." } });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/dashboard", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), async (_request, response, next) => {
  try {
    const [totalProducts, publishedProducts, inventory, newContacts, newTradeIns, newPartnerships, activity] = await prisma.$transaction([
      prisma.product.count(), prisma.product.count({ where: { isPublished: true } }), prisma.product.aggregate({ _sum: { stockQuantity: true } }),
      prisma.contactEnquiry.count({ where: { status: "NEW" } }), prisma.tradeInEnquiry.count({ where: { status: "NEW" } }), prisma.partnershipEnquiry.count({ where: { status: "NEW" } }),
      prisma.activityLog.findMany({ take: 10, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true, role: true } } } }),
    ]);
    response.json({ data: { totalProducts, publishedProducts, inventoryUnits: inventory._sum.stockQuantity ?? 0, newContacts, newTradeIns, newPartnerships, activity } });
  } catch (error) { next(error); }
});

app.get("/admin/products", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), async (request, response, next) => {
  try {
    const search = z.string().trim().max(100).optional().parse(request.query.search);
    const products = await prisma.product.findMany({ where: search ? { OR: [{ name: { contains: search } }, { sku: { contains: search } }, { brand: { contains: search } }] } : undefined, orderBy: { updatedAt: "desc" }, select: { ...publicProductSelect, isPublished: true, createdAt: true, updatedAt: true } });
    response.json({ data: products });
  } catch (error) { next(error); }
});
app.post("/admin/products", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => {
  try {
    const input = productSchema.parse(request.body);
    const availability = input.stockQuantity === 0 ? ProductAvailability.OUT_OF_STOCK : input.stockQuantity <= 3 ? ProductAvailability.LOW_STOCK : ProductAvailability.IN_STOCK;
    const product = await prisma.product.create({ data: { ...input, specifications: input.specifications as Prisma.InputJsonValue, imageUrls: input.imageUrls as Prisma.InputJsonValue, availability }, select: publicProductSelect });
    await recordActivity(request.user!.id, "CREATE", "PRODUCT", product.id);
    response.status(201).json({ data: product });
  } catch (error) { next(error); }
});
app.patch("/admin/products/:id", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => {
  try {
    const input = productUpdateSchema.parse(request.body);
    const productId = getParam(request, "id");
    const currentPrices = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { priceInPaise: true, originalPriceInPaise: true },
    });
    const sellingPrice = input.priceInPaise ?? currentPrices.priceInPaise;
    const originalPrice = Object.hasOwn(input, "originalPriceInPaise")
      ? input.originalPriceInPaise
      : currentPrices.originalPriceInPaise;
    if (originalPrice != null && originalPrice <= sellingPrice) {
      response.status(400).json({ error: { code: "INVALID_PRODUCT_PRICES", message: "Original price must be greater than the selling price." } });
      return;
    }
    const stock = input.stockQuantity;
    const availability = stock === undefined ? undefined : stock === 0 ? ProductAvailability.OUT_OF_STOCK : stock <= 3 ? ProductAvailability.LOW_STOCK : ProductAvailability.IN_STOCK;
    const { specifications, imageUrls, ...scalarInput } = input;
    const product = await prisma.product.update({ where: { id: productId }, data: { ...scalarInput, ...(specifications ? { specifications: specifications as Prisma.InputJsonValue } : {}), ...(imageUrls ? { imageUrls: imageUrls as Prisma.InputJsonValue } : {}), ...(availability ? { availability } : {}) }, select: publicProductSelect });
    await recordActivity(request.user!.id, "UPDATE", "PRODUCT", product.id);
    response.json({ data: product });
  } catch (error) { next(error); }
});
app.delete("/admin/products/:id", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => {
  try { const productId = getParam(request, "id"); await prisma.product.delete({ where: { id: productId } }); await recordActivity(request.user!.id, "DELETE", "PRODUCT", productId); response.status(204).send(); } catch (error) { next(error); }
});
app.patch("/admin/products/:id/publish", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => {
  try { const productId = getParam(request, "id"); const isPublished = z.object({ isPublished: z.boolean() }).parse(request.body).isPublished; const product = await prisma.product.update({ where: { id: productId }, data: { isPublished }, select: publicProductSelect }); await recordActivity(request.user!.id, isPublished ? "PUBLISH" : "UNPUBLISH", "PRODUCT", product.id); response.json({ data: product }); } catch (error) { next(error); }
});
app.post("/admin/products/:id/inventory", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => {
  try {
    const input = z.object({ quantity: z.coerce.number().int().min(-100000).max(100000), reason: z.string().trim().min(3).max(255) }).parse(request.body);
    const productId = getParam(request, "id");
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQuantity: true } });
    const stockQuantity = product.stockQuantity + input.quantity;
    if (stockQuantity < 0) { response.status(400).json({ error: { code: "INVALID_INVENTORY", message: "Inventory cannot become negative." } }); return; }
    const availability = stockQuantity === 0 ? ProductAvailability.OUT_OF_STOCK : stockQuantity <= 3 ? ProductAvailability.LOW_STOCK : ProductAvailability.IN_STOCK;
    const updated = await prisma.$transaction(async transaction => {
      const result = await transaction.product.update({ where: { id: productId }, data: { stockQuantity, availability }, select: publicProductSelect });
      await transaction.inventoryAdjustment.create({ data: { productId, userId: request.user!.id, quantity: input.quantity, reason: input.reason } });
      return result;
    });
    await recordActivity(request.user!.id, "INVENTORY_ADJUSTMENT", "PRODUCT", updated.id, { quantity: input.quantity });
    response.json({ data: updated });
  } catch (error) { next(error); }
});

app.get("/admin/inventory/history", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), async (request, response, next) => {
  try {
    const query = z.object({ productId: z.string().trim().max(100).optional() }).parse(request.query);
    const data = await prisma.inventoryAdjustment.findMany({
      where: query.productId ? { productId: query.productId } : undefined,
      take: 100,
      orderBy: { createdAt: "desc" },
      include: { product: { select: { name: true, sku: true } }, user: { select: { name: true, role: true } } },
    });
    response.json({ data });
  } catch (error) { next(error); }
});

async function enquiryList(request: express.Request, response: express.Response, next: express.NextFunction, type: "contact" | "trade" | "partnership") {
  try {
    const query = z.object({
      status: z.enum(["NEW", "IN_PROGRESS", "RESOLVED", "ARCHIVED"]).optional(),
      search: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(8),
    }).parse(request.query);
    const skip = (query.page - 1) * query.limit;
    const rows = type === "contact"
      ? await prisma.contactEnquiry.findMany({ where: { ...(query.status ? { status: query.status } : {}), ...(query.search ? { OR: [{ name: { contains: query.search } }, { email: { contains: query.search } }, { message: { contains: query.search } }] } : {}) }, orderBy: { createdAt: "desc" }, skip, take: query.limit })
      : type === "trade"
        ? await prisma.tradeInEnquiry.findMany({ where: { ...(query.status ? { status: query.status } : {}), ...(query.search ? { OR: [{ customerName: { contains: query.search } }, { email: { contains: query.search } }, { deviceModel: { contains: query.search } }] } : {}) }, orderBy: { createdAt: "desc" }, skip, take: query.limit })
        : await prisma.partnershipEnquiry.findMany({ where: { ...(query.status ? { status: query.status } : {}), ...(query.search ? { OR: [{ companyName: { contains: query.search } }, { contactName: { contains: query.search } }, { email: { contains: query.search } }, { message: { contains: query.search } }] } : {}) }, orderBy: { createdAt: "desc" }, skip, take: query.limit });
    const total = type === "contact"
      ? await prisma.contactEnquiry.count({ where: { ...(query.status ? { status: query.status } : {}), ...(query.search ? { OR: [{ name: { contains: query.search } }, { email: { contains: query.search } }, { message: { contains: query.search } }] } : {}) } })
      : type === "trade"
        ? await prisma.tradeInEnquiry.count({ where: { ...(query.status ? { status: query.status } : {}), ...(query.search ? { OR: [{ customerName: { contains: query.search } }, { email: { contains: query.search } }, { deviceModel: { contains: query.search } }] } : {}) } })
        : await prisma.partnershipEnquiry.count({ where: { ...(query.status ? { status: query.status } : {}), ...(query.search ? { OR: [{ companyName: { contains: query.search } }, { contactName: { contains: query.search } }, { email: { contains: query.search } }, { message: { contains: query.search } }] } : {}) } });
    response.json({ data: rows, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) { next(error); }
}
app.get("/admin/enquiries", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), (request, response, next) => enquiryList(request, response, next, "contact"));
app.get("/admin/trade-ins", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), (request, response, next) => enquiryList(request, response, next, "trade"));
app.get("/admin/partnerships", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), (request, response, next) => enquiryList(request, response, next, "partnership"));
app.patch("/admin/enquiries/:id", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => updateEnquiry(request, response, next, "contact"));
app.patch("/admin/trade-ins/:id", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => updateEnquiry(request, response, next, "trade"));
app.patch("/admin/partnerships/:id", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => updateEnquiry(request, response, next, "partnership"));

async function updateEnquiry(request: express.Request, response: express.Response, next: express.NextFunction, type: "contact" | "trade" | "partnership") {
  try {
    const input = statusSchema.parse(request.body);
    const enquiryId = getParam(request, "id");
    const data = type === "contact" ? await prisma.contactEnquiry.update({ where: { id: enquiryId }, data: input }) : type === "trade" ? await prisma.tradeInEnquiry.update({ where: { id: enquiryId }, data: input }) : await prisma.partnershipEnquiry.update({ where: { id: enquiryId }, data: input });
    await recordActivity(request.user!.id, input.status ? "UPDATE_STATUS" : "UPDATE_NOTE", `${type.toUpperCase()}_ENQUIRY`, enquiryId, input.status ? { status: input.status } : undefined);
    response.json({ data });
  } catch (error) { next(error); }
}

const staffSelect = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } as const;
const operationalStaffRoles: UserRole[] = [UserRole.ADMIN, UserRole.STAFF];
app.get("/admin/staff", requireAuth, requireRoles(...adminRoles), async (_request, response, next) => { try { response.json({ data: await prisma.user.findMany({ where: { role: { in: operationalStaffRoles } }, orderBy: { createdAt: "desc" }, select: staffSelect }) }); } catch (error) { next(error); } });
app.post("/admin/staff", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => {
  try { const input = staffSchema.parse(request.body); const user = await prisma.user.create({ data: { name: input.name, email: input.email, role: input.role, passwordHash: await hashPassword(input.password) }, select: staffSelect }); await recordActivity(request.user!.id, "CREATE", "STAFF", user.id); response.status(201).json({ data: user }); } catch (error) { next(error); }
});
app.patch("/admin/staff/:id", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => {
  try {
    const input = staffUpdateSchema.parse(request.body);
    const { password, ...rest } = input;
    const userId = getParam(request, "id");
    const passwordHash = password ? await hashPassword(password) : undefined;
    const user = await prisma.$transaction(async transaction => {
      const current = await transaction.user.findUnique({
        where: { id: userId },
        select: { role: true, isActive: true },
      });
      if (current?.role === UserRole.FOUNDER) {
        throw new StaffManagementError(403, "FOUNDER_PROTECTED", "Founder accounts cannot be changed through staff management.");
      }
      if (!current || !operationalStaffRoles.includes(current.role)) {
        throw new StaffManagementError(404, "STAFF_ACCOUNT_NOT_FOUND", "The operational staff account was not found.");
      }
      const removesLastPrivilegedAccount = current.role === UserRole.ADMIN && current.isActive &&
        (input.isActive === false || input.role === UserRole.STAFF);
      if (removesLastPrivilegedAccount) {
        const activePrivilegedUsers = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM users
          WHERE role IN ('FOUNDER', 'ADMIN') AND is_active = 1
          FOR UPDATE
        `;
        if (activePrivilegedUsers.length <= 1) {
          throw new StaffManagementError(409, "LAST_ACTIVE_ADMIN", "At least one active Founder or Admin account must remain.");
        }
      }
      return transaction.user.update({
        where: { id: userId },
        data: { ...rest, ...(passwordHash ? { passwordHash } : {}) },
        select: staffSelect,
      });
    });
    await recordActivity(request.user!.id, "UPDATE", "STAFF", user.id, { fields: Object.keys(input).filter(field => field !== "password") });
    response.json({ data: user });
  } catch (error) {
    if (error instanceof StaffManagementError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  }
});
app.get("/admin/activity", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), async (request, response, next) => {
  try {
    const query = z.object({ action: z.string().trim().max(100).optional(), userId: z.string().trim().max(100).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(request.query);
    const data = await prisma.activityLog.findMany({ where: { ...(query.action ? { action: { contains: query.action } } : {}), ...(query.userId ? { userId: query.userId } : {}), ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}) }, take: 100, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true, role: true } } } });
    response.json({ data });
  } catch (error) { next(error); }
});
app.get("/admin/categories", requireAuth, requireRoles(...adminRoles, UserRole.STAFF), async (_request, response, next) => { try { response.json({ data: await prisma.category.findMany({ orderBy: { name: "asc" } }) }); } catch (error) { next(error); } });
app.post("/admin/categories", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => { try { const data = await prisma.category.create({ data: categorySchema.parse(request.body) }); await recordActivity(request.user!.id, "CREATE", "CATEGORY", data.id); response.status(201).json({ data }); } catch (error) { next(error); } });
app.patch("/admin/categories/:id", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => { try { const data = await prisma.category.update({ where: { id: getParam(request, "id") }, data: categorySchema.partial().parse(request.body) }); await recordActivity(request.user!.id, "UPDATE", "CATEGORY", data.id); response.json({ data }); } catch (error) { next(error); } });
app.get("/admin/settings", requireAuth, requireRoles(...adminRoles), async (_request, response, next) => { try { response.json({ data: await prisma.websiteSetting.findMany({ orderBy: { key: "asc" } }) }); } catch (error) { next(error); } });
app.put("/admin/settings/:key", requireAuth, requireRoles(...adminRoles), adminMutationLimiter, async (request, response, next) => { try { const key = getParam(request, "key"); if (!/^[a-z0-9._-]+$/.test(key)) { response.status(400).json({ error: { code: "INVALID_SETTING_KEY", message: "Invalid setting key." } }); return; } const data = await prisma.websiteSetting.upsert({ where: { key }, update: settingSchema.parse(request.body), create: { key, ...settingSchema.parse(request.body) } }); await recordActivity(request.user!.id, "UPDATE", "SETTING", key); response.json({ data }); } catch (error) { next(error); } });

function getParam(request: express.Request, name: string) {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] : value;
}

class SetupUnavailableError extends Error {}
class StaffManagementError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function isSetupSecretConfigured() {
  return Boolean(config.initialSetupSecret && config.initialSetupSecret.length >= 32);
}

function secretsMatch(provided: string, expected: string) {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) { response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Please check the submitted details.", details: error.flatten().fieldErrors } }); return; }
  if (error instanceof multer.MulterError) {
    response.status(400).json({ error: { code: error.code === "LIMIT_FILE_SIZE" ? "IMAGE_TOO_LARGE" : "IMAGE_UPLOAD_INVALID", message: error.code === "LIMIT_FILE_SIZE" ? "Images must be 8MB or smaller." : "The image upload is invalid." } });
    return;
  }
  if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: number }).statusCode === 400) { response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } }); return; }
  logger.error("Unhandled request error", error);
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong while processing the request." } });
});

export { app };

let server: Server | undefined;
let shuttingDown = false;

export async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  logger.info("Shutdown started", { signal });

  await new Promise<void>(resolve => {
    if (!server) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      logger.error("Shutdown timeout reached; closing remaining resources");
      resolve();
    }, 10_000);
    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await prisma.$disconnect();
  logger.info("Shutdown complete");
}

if (process.env.NODE_ENV !== "test") {
  server = app.listen(port, () => logger.info("MobieDoor API listening", { port }));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown(signal).catch(error => {
        logger.error("Shutdown failed", error);
        process.exitCode = 1;
      });
    });
  }
}
