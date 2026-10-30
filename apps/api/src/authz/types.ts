// Actor and access-context types. An Actor is a session, an API key, an
// automation or the system; authorization never looks at a bare role string.

import type { ApiScope, VehiclePermission } from '@voltlink/shared';

export type StepUpMethod = 'password' | 'totp' | 'recovery_code' | 'passkey';

export type SessionActor = {
  kind: 'session';
  userId: string;
  sessionId: string;
  isInstanceAdmin: boolean;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  stepUpAt: Date | null;
  stepUpMethod: StepUpMethod | null;
};

export type ApiKeyActor = {
  kind: 'apiKey';
  userId: string;
  apiKeyId: string;
  organizationId: string;
  scopes: readonly ApiScope[];
  isInstanceAdmin: false;
  emailVerified: boolean;
};

export type AutomationActor = {
  kind: 'automation';
  userId: string;
  automationId: string;
  organizationId: string;
};

export type SystemActor = {
  kind: 'system';
  job: 'retention' | 'privacy-redaction' | 'account-deletion' | 'ingest';
};

export type Actor = SessionActor | ApiKeyActor | AutomationActor | SystemActor;

export interface AccessContext {
  vehicle?: { id: string; organizationId: string; [key: string]: unknown };
  vehicleIds?: string[];
  organizationId?: string;
  permissions?: Set<string>;
  resource?: { id: string; vehicleId?: string; organizationId?: string; ownerUserId?: string; [key: string]: unknown };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      access?: AccessContext;
    }
  }
}

export type EffectiveVehiclePerms = Set<VehiclePermission>;
