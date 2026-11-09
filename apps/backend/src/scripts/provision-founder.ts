import "dotenv/config";
import { createInterface } from "node:readline";
import { UserRole } from "@prisma/client";
import { hashPassword } from "../auth.js";
import { prisma } from "../lib/prisma.js";

function databaseName(databaseUrl: string) {
  try {
    return new URL(databaseUrl).pathname.replace(/^\/+/, "").toLowerCase();
  } catch {
    throw new Error("DATABASE_URL is invalid.");
  }
}

function assertLocalDevelopmentDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be provided.");
  if (process.env.NODE_ENV === "production") throw new Error("Founder provisioning is disabled in production.");
  if (process.env.TEST_DATABASE_URL && databaseUrl === process.env.TEST_DATABASE_URL) {
    throw new Error("Founder provisioning is disabled for the isolated test database.");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is invalid.");
  }

  const database = databaseName(databaseUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const unsafeDatabaseName = /(^|[-_])(test|prod|production|live|staging)([-_]|$)/i.test(database);
  if (!localHosts.has(parsed.hostname) || parsed.port !== "3306" || database !== "mobiedoor" || unsafeDatabaseName) {
    throw new Error("Founder provisioning requires a local development MySQL database.");
  }
}

function ask(question: string) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>(resolve => input.question(question, answer => {
    input.close();
    resolve(answer.trim());
  }));
}

async function askHidden(question: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Founder password must be entered interactively from a terminal.");
  }

  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      const character = chunk.toString("utf8");
      if (character === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        reject(new Error("Founder provisioning cancelled."));
      } else if (character === "\r" || character === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (character === "\u0008" || character === "\u007f") {
        value = value.slice(0, -1);
      } else if (character >= " ") {
        value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

try {
  assertLocalDevelopmentDatabase();
  const name = await ask("Founder full name: ");
  const email = (await ask("Founder email: ")).toLowerCase();
  if (!name || !email) throw new Error("Founder name and email are required. No changes were made.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("FOUNDER_EMAIL must be a valid email address.");

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new Error("An account with that email already exists. No changes were made.");

  const password = await askHidden("Founder password (input hidden): ");
  const confirmation = await askHidden("Repeat Founder password (input hidden): ");
  if (password.length < 10 || password.length > 200) throw new Error("Founder password must be between 10 and 200 characters.");
  if (password !== confirmation) throw new Error("Founder passwords do not match.");

  const approval = await ask('Type "CREATE FOUNDER" to create this local account: ');
  if (approval !== "CREATE FOUNDER") throw new Error("Confirmation not received. No changes were made.");

  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: { name, email, passwordHash, role: UserRole.FOUNDER },
    select: { id: true },
  });
  console.log(`Founder account created for ${email}. Password value was not displayed.`);
} finally {
  await prisma.$disconnect();
}
