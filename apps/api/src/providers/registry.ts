// Provider registry and encrypted credential store.

import { prisma } from '../core/db';
import { openJson, sealJson } from '../core/crypto';
import { audit } from '../core/settings';
import type { ProviderAccount } from '@prisma/client';
import type { ProviderContext, VehicleProvider } from './types';
import { DemoProvider } from './demo';
import { MockProvider } from './mock';
import { TeslaProvider } from './tesla';
import { TessieProvider } from './tessie';

// ---------------------------------------------------------------------------
// Credential store (authenticated encryption at rest)
// ---------------------------------------------------------------------------

export interface StoredCredential {
  token?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenType?: string;
  expiresAt?: string;
  scopes?: string[];
  region?: string;
  [key: string]: unknown;
}

export class CredentialError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function saveCredentials(providerAccountId: string, payload: StoredCredential): Promise<void> {
  const sealed = sealJson(payload);
  await prisma.providerCredential.upsert({
    where: { providerAccountId },
    update: { keyVersion: sealed.keyVersion, algorithm: sealed.algorithm, ciphertext: sealed.ciphertext },
    create: { providerAccountId, keyVersion: sealed.keyVersion, algorithm: sealed.algorithm, ciphertext: sealed.ciphertext },
  });
}

export async function loadCredentials(providerAccountId: string): Promise<StoredCredential> {
  const row = await prisma.providerCredential.findUnique({ where: { providerAccountId } });
  if (!row) throw new CredentialError('No credentials stored for this provider account.', 404);
  return openJson<StoredCredential>(row.ciphertext);
}

export async function removeCredentials(providerAccountId: string): Promise<void> {
  await prisma.providerCredential.deleteMany({ where: { providerAccountId } });
}

/** Build a ProviderContext for an account, decrypting credentials just in time. */
export async function buildContext(account: ProviderAccount): Promise<ProviderContext> {
  let credentials: Record<string, unknown> = {};
  if (account.provider !== 'demo' && account.provider !== 'mock') {
    try {
      credentials = await loadCredentials(account.id);
    } catch {
      credentials = {};
    }
  }
  return {
    accountId: account.id,
    userId: account.connectedById ?? '',
    credentials,
    meta: {
      provider: account.provider,
      label: account.label,
      demo: account.demo,
      scopes: Array.isArray(account.scopes) ? (account.scopes as string[]) : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const providers: Record<string, VehicleProvider> = {
  demo: new DemoProvider(),
  mock: new MockProvider(),
  tesla: new TeslaProvider(),
  tessie: new TessieProvider(),
};

export function getProvider(providerId: string): VehicleProvider {
  const p = providers[providerId];
  if (!p) throw new CredentialError(`Unknown provider "${providerId}".`, 400);
  return p;
}

export function listProviders(): { id: string; label: string; enabled: boolean; requiresCredentials: boolean }[] {
  return [
    { id: 'tesla', label: 'Tesla (official API)', enabled: true, requiresCredentials: true },
    { id: 'tessie', label: 'Tessie API (optional)', enabled: true, requiresCredentials: true },
    { id: 'demo', label: 'Demo fleet', enabled: true, requiresCredentials: false },
    { id: 'mock', label: 'Mock (tests only)', enabled: false, requiresCredentials: false },
  ];
}

export async function connectDemoAccount(organizationId: string, connectedById: string): Promise<{ accountId: string; vehiclesImported: number }> {
  const existing = await prisma.providerAccount.findFirst({ where: { organizationId, provider: 'demo' } });
  if (existing) return { accountId: existing.id, vehiclesImported: await prisma.vehicle.count({ where: { providerAccountId: existing.id } }) };
  const account = await prisma.providerAccount.create({
    data: { organizationId, connectedById, provider: 'demo', label: 'Demo Fleet', status: 'connected', demo: true, scopes: JSON.parse('["demo"]') },
  });
  const ctx = await buildContext(account);
  const demoProvider = providers.demo;
  if (!demoProvider) throw new CredentialError('Demo provider unavailable.', 500);
  const descriptors = await demoProvider.listVehicles(ctx);
  for (const d of descriptors) {
    await prisma.vehicle.create({
      data: {
        organizationId,
        addedById: connectedById,
        providerAccountId: account.id,
        provider: 'demo',
        providerVehicleId: d.providerVehicleId,
        displayName: d.displayName,
        make: d.make,
        model: d.model,
        year: d.year,
        vehicleClass: d.vehicleClass,
        exteriorColor: d.exteriorColor ?? '#8b9bb4',
        wheelStyle: d.wheelStyle,
        vinLast4: d.vinLast4,
        capabilities: JSON.parse(JSON.stringify(d.capabilities)),
        demo: true,
      },
    });
  }
  await prisma.user.update({ where: { id: connectedById }, data: { demoEnabled: true } });
  await audit({ actorId: connectedById, action: 'provider.connect_demo', entityType: 'provider', entityId: account.id });
  return { accountId: account.id, vehiclesImported: descriptors.length };
}
