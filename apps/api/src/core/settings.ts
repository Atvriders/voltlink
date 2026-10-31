// Audit logging and application settings.

import { prisma } from './db';

export interface AuditInput {
  actorId?: string | null;
  organizationId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: unknown;
  ip?: string;
  requestId?: string;
}

/** Write a sanitized audit record. Never include credentials or precise GPS. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        organizationId: input.organizationId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: input.details === undefined ? undefined : (input.details as object),
        ip: input.ip,
        requestId: input.requestId,
      },
    });
  } catch {
    // auditing must never break the request
  }
}

// ---- Settings ----

const DEFAULT_SETTINGS: Record<string, string> = {
  orgName: 'VoltLink',
  telemetryRetentionDays: '365',
  locationRetentionDays: '90',
  globalReadOnly: 'false',
  commandsEnabled: 'true',
  providerCommandsEnabled: 'true',
  vehicleCommandsEnabled: 'true',
};

export async function getSetting(key: string): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) {
    const fallback = DEFAULT_SETTINGS[key];
    if (fallback !== undefined) {
      await prisma.appSetting.upsert({
        where: { key },
        update: {},
        create: { key, value: fallback },
      });
      return fallback;
    }
    return '';
  }
  return row.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export async function getSettingsBundle(): Promise<Record<string, string>> {
  const keys = [...Object.keys(DEFAULT_SETTINGS), 'orgLogoUrl'];
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = await getSetting(k);
  return out;
}

export async function commandsGloballyEnabled(): Promise<boolean> {
  return (
    (await getSetting('commandsEnabled')) === 'true' &&
    (await getSetting('globalReadOnly')) !== 'true'
  );
}
