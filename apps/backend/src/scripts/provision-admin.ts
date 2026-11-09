import "dotenv/config";
import { UserRole } from "@prisma/client";
import { hashPassword } from "../auth.js";
import { prisma } from "../lib/prisma.js";

const name = process.env.ADMIN_NAME;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!name || !email || !password) {
  throw new Error("ADMIN_NAME, ADMIN_EMAIL, and ADMIN_PASSWORD must be provided as environment variables.");
}
if (password.length < 10) throw new Error("ADMIN_PASSWORD must be at least 10 characters.");

const passwordHash = await hashPassword(password);
await prisma.user.upsert({
  where: { email },
  update: { name, passwordHash, role: UserRole.ADMIN },
  create: { name, email, passwordHash, role: UserRole.ADMIN },
});
console.log(`Admin account provisioned for ${email}. Password value was not displayed.`);
await prisma.$disconnect();
