// Seeds a login-ready user for the local Tesla e2e run (fresh DB, no invite).
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

async function main() {
  // Fresh provider state each e2e run (test DB only).
  await prisma.providerAccount.deleteMany({ where: { provider: 'tesla' } });
  const email = process.env.E2E_USER_EMAIL ?? 'tesla-e2e-user@voltlink.test';
  const password = process.env.E2E_USER_PASSWORD ?? 'e2e-password-123';
  const hash = await argon2.hash(password);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: hash } });
    console.log(`user ready: ${email}`);
    return;
  }
  const user = await prisma.user.create({
    data: {
      email,
      name: 'Tesla E2E',
      passwordHash: hash,
      webauthnUserId: 'teslae2e-00000000000000000001',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: 'Tesla E2E org',
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  console.log(`user created: ${email}`);
}

void main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
