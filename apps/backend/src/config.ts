import "dotenv/config";

const nodeEnv = process.env.NODE_ENV ?? "development";
if (!["development", "test", "production"].includes(nodeEnv)) {
  throw new Error("NODE_ENV must be development, test, or production.");
}
const isProduction = nodeEnv === "production";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parsePort(value: string | undefined) {
  const port = Number(value ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseTrustProxy(value: string | undefined): false | number {
  if (!value || value === "false" || value === "0") return false;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0) return hops;
  throw new Error("TRUST_PROXY must be false or a positive integer.");
}

const databaseUrl = isProduction ? required("DATABASE_URL") : process.env.DATABASE_URL;
const frontendUrl = isProduction ? required("FRONTEND_URL") : (process.env.FRONTEND_URL ?? "http://localhost:5173");
const parsedFrontendUrl = new URL(frontendUrl);

if (!["http:", "https:"].includes(parsedFrontendUrl.protocol)) {
  throw new Error("FRONTEND_URL must use http or https.");
}
if (isProduction && parsedFrontendUrl.protocol !== "https:") {
  throw new Error("FRONTEND_URL must use HTTPS in production.");
}
if (isProduction && databaseUrl && !databaseUrl.startsWith("mysql://")) {
  throw new Error("DATABASE_URL must be a MySQL connection URL in production.");
}

export const config = {
  isProduction,
  databaseUrl,
  frontendUrl: parsedFrontendUrl.origin,
  port: parsePort(process.env.PORT),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  initialSetupSecret: process.env.INITIAL_SETUP_SECRET?.trim(),
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME?.trim(),
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY?.trim(),
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET?.trim(),
  uploadDirectory: process.env.UPLOAD_DIRECTORY?.trim() || "uploads",
};

if (isProduction && (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret)) {
  throw new Error("CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required in production.");
}
