// OpenAPI 3.1.0 generated from the live Express route table plus the shared
// zod schemas, so the spec cannot drift from the code (C-OPENAPI). The route
// table is the single source of truth for what exists: every policyRouter
// registration and every explicitly registered ad-hoc route appears here.
//
// - scripts/generate-openapi.ts writes the committed snapshot files.
// - GET /api/docs serves this generator's output at runtime.
// - test/openapi.test.ts asserts the two-way route/spec correspondence and
//   that the committed snapshot matches the generated document.

import { z } from 'zod';
import { APP_VERSION } from '@voltlink/shared';
import { COMMAND_TYPES, COMMAND_PARAM_SCHEMAS } from '@voltlink/shared';
import { ROUTE_TABLE, type RoutePolicy } from '../authz/policy';

// ---------------------------------------------------------------------------
// Response envelope schemas shared by every route (guide 05 §1.2).
// ---------------------------------------------------------------------------

const userPublicSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string().optional(),
  createdAt: z.string().optional(),
});

const vehicleSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerVehicleId: z.string().optional(),
  displayName: z.string(),
  vin: z.string().optional(),
  state: z.string().optional(),
  demo: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
});

const commandSchema = z.object({
  id: z.string(),
  vehicleId: z.string(),
  type: z.string(),
  status: z.string(),
  createdAt: z.string().optional(),
});

const driveSchema = z.object({
  id: z.string(),
  vehicleId: z.string(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  distanceKm: z.number().optional(),
  costCents: z.number().optional(),
});

const chargingSessionSchema = z.object({
  id: z.string(),
  vehicleId: z.string(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  energyKwh: z.number().optional(),
});

const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: z.string().optional(),
  enabled: z.boolean().optional(),
});

const notificationPreferenceSchema = z.object({
  channel: z.string(),
  enabled: z.boolean().optional(),
});

const statusBundleSchema = z.object({
  pageTitle: z.string().optional(),
  overall: z.string(),
  components: z.array(z.record(z.string(), z.unknown())).optional(),
  incidents: z.array(z.record(z.string(), z.unknown())).optional(),
});

const paginationEnvelope = (item: z.ZodTypeAny) =>
  z.object({
    data: z.array(item),
    pagination: z
      .object({
        cursor: z.string().optional(),
        hasMore: z.boolean().optional(),
        total: z.number().optional(),
      })
      .optional(),
  });

const dataEnvelope = (item: z.ZodTypeAny) => z.object({ data: item });

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** A route-specific documentation entry; everything else gets derived defaults. */
interface RouteDoc {
  summary?: string;
  description?: string;
  requestBody?: z.ZodTypeAny;
  /** status code -> response payload schema (the `{ data: ... }` envelope is added automatically). */
  responses?: Record<string, z.ZodTypeAny>;
}

// ---------------------------------------------------------------------------
// Curated operation docs for the families where the wire contract matters.
// ---------------------------------------------------------------------------

const commandRequestBody = z.object({
  vehicleId: z.string().min(1),
  type: z.enum(COMMAND_TYPES),
  params: z
    .object({
      pin: z.string().regex(/^\d{4}$/).optional(),
    })
    .optional(),
});

const registerBody = z.object({
  email: z.string(),
  name: z.string(),
  password: z.string().min(10),
  setupToken: z.string().optional(),
  inviteToken: z.string().optional(),
});

const loginBody = z.object({
  email: z.string(),
  password: z.string(),
});

const ROUTE_DOCS: Record<string, RouteDoc> = {
  'POST /api/v1/commands': {
    summary: 'Issue a vehicle command',
    description:
      'Creates a command with the given type and parameters for the vehicle. ' +
      `Valid types: ${COMMAND_TYPES.join(', ')}.`,
    requestBody: commandRequestBody,
    responses: { '201': commandSchema },
  },
  'POST /api/v1/vehicles/:id/commands': {
    summary: 'Issue a command to a vehicle (per-vehicle alias)',
    description: 'Equivalent to POST /api/v1/commands with the vehicleId in the path.',
    requestBody: z.object({
      type: z.enum(COMMAND_TYPES),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    responses: { '201': commandSchema },
  },
  'POST /api/v1/auth/register': {
    summary: 'Register an account (first-run setup or invitation/open mode)',
    requestBody: registerBody,
    responses: { '201': userPublicSchema },
  },
  'POST /api/v1/auth/login': {
    summary: 'Password login',
    requestBody: loginBody,
    responses: { '200': userPublicSchema },
  },
  'GET /api/v1/auth/me': {
    summary: 'Current account',
    responses: { '200': userPublicSchema },
  },
  'GET /api/v1/vehicles': {
    summary: 'List vehicles visible to the actor',
    responses: { '200': paginationEnvelope(vehicleSchema) },
  },
  'GET /api/v1/vehicles/:id': {
    summary: 'One vehicle',
    responses: { '200': vehicleSchema },
  },
  'GET /api/v1/vehicles/:id/state': {
    summary: 'Live vehicle state',
    responses: { '200': vehicleSchema },
  },
  'POST /api/v1/vehicles/:id/refresh': {
    summary: 'Force a provider refresh',
    responses: { '200': vehicleSchema },
  },
  'GET /api/v1/drives': {
    summary: 'Drive history with totals',
    responses: { '200': paginationEnvelope(driveSchema) },
  },
  'GET /api/v1/charging/sessions': {
    summary: 'Charging session history',
    responses: { '200': paginationEnvelope(chargingSessionSchema) },
  },
  'GET /api/v1/automations': {
    summary: 'List automations',
    responses: { '200': paginationEnvelope(automationSchema) },
  },
  'GET /api/v1/notifications/preferences': {
    summary: 'Notification preferences',
    responses: { '200': paginationEnvelope(notificationPreferenceSchema) },
  },
  'GET /api/v1/status': {
    summary: 'Public status bundle',
    responses: { '200': statusBundleSchema },
  },
};

const DEFAULT_SUMMARIES: Array<[RegExp, string]> = [
  [/^GET .*\/export$/, 'Export data'],
  [/^GET .*\/report$/, 'Generate a report'],
  [/^GET .*\/settings$/, 'Read settings'],
  [/^PATCH .*\/settings$/, 'Update settings'],
  [/^GET .*\/audit$/, 'Audit log'],
  [/^GET .*\/readiness$/, 'Readiness check'],
  [/^GET .*\/health$/, 'Health'],
  [/^GET .*\/csrf$/, 'Issue a CSRF token'],
  [/^GET .*\/setup-status$/, 'Instance setup status'],
  [/^GET .*\/favorites$/, 'Favorites'],
  [/^PUT .*\/favorites$/, 'Replace favorites'],
  [/^GET .*\/onboarding$/, 'Onboarding progress'],
  [/^PUT .*\/onboarding$/, 'Save onboarding progress'],
  [/^POST .*\/demo-mode$/, 'Toggle demo mode'],
];

function defaultSummary(method: string, path: string): string {
  for (const [re, summary] of DEFAULT_SUMMARIES) {
    if (re.test(`${method} ${path}`)) return summary;
  }
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? 'resource';
  if (last.startsWith(':')) {
    const parent = segments[segments.length - 2] ?? 'resource';
    switch (method) {
      case 'GET':
        return `Get one ${singular(parent)}`;
      case 'PATCH':
      case 'PUT':
        return `Update one ${singular(parent)}`;
      case 'DELETE':
        return `Delete one ${singular(parent)}`;
      case 'POST':
        return `Act on one ${singular(parent)}`;
    }
  }
  switch (method) {
    case 'GET':
      return `List ${plural(last)}`;
    case 'POST':
      return `Create ${singular(last)}`;
    case 'PUT':
      return `Replace ${singular(last)}`;
    case 'PATCH':
      return `Update ${singular(last)}`;
    case 'DELETE':
      return `Delete ${singular(last)}`;
  }
  return path;
}

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('ches'))
    return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function plural(word: string): string {
  return word.endsWith('s') ? word : `${word}s`;
}

function tagFor(path: string): string {
  const segments = path.split('/').filter(Boolean);
  // /api/v1/<family>
  return segments[2] ?? 'api';
}

function pathParameters(path: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const segment of path.split('/')) {
    if (segment.startsWith(':')) {
      out.push({
        name: segment.slice(1),
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }
  }
  return out;
}

function operationId(method: string, path: string): string {
  const clean = path
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? `by_${seg.slice(1)}` : seg))
    .join('_')
    .replace(/[^a-zA-Z0-9_]/g, '_');
  return `${method.toLowerCase()}_${clean}`;
}

function securityFor(method: string, policy: RoutePolicy): Array<Record<string, string[]>> {
  if (policy.auth === 'public') return [];
  const schemes: Array<Record<string, string[]>> = [{ sessionCookie: [] }];
  if (policy.auth === 'any') schemes.push({ bearerApiKey: [] });
  if (method !== 'GET') schemes.push({ csrfHeader: [] });
  return schemes;
}

function zodToSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // zod v4's built-in conversion; drop the $schema keyword OpenAPI doesn't want.
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void $schema;
  return rest as Record<string, unknown>;
}

function operationFor(method: string, path: string, policy: RoutePolicy): Record<string, unknown> {
  const key = `${method} ${path}`;
  const doc = ROUTE_DOCS[key];
  const params = pathParameters(path);
  const op: Record<string, unknown> = {
    operationId: operationId(method, path),
    summary: doc?.summary ?? defaultSummary(method, path),
    tags: [tagFor(path)],
    security: securityFor(method, policy),
    responses: {
      '200': {
        description: 'Success',
        content: {
          'application/json': {
            schema: zodToSchema(doc?.responses?.['200'] ? dataEnvelope(doc.responses['200']) : z.object({ data: z.unknown() })),
          },
        },
      },
    },
  };
  if (doc?.description) op.description = doc.description;
  if (params.length > 0) op.parameters = params;
  if (doc?.responses?.['201']) {
    op.responses = {
      '201': {
        description: 'Created',
        content: {
          'application/json': { schema: zodToSchema(dataEnvelope(doc.responses['201'])) },
        },
      },
      '400': {
        description: 'Bad request',
        content: { 'application/json': { schema: zodToSchema(errorEnvelope) } },
      },
    };
  } else {
    (op.responses as Record<string, unknown>)['400'] = {
      description: 'Bad request',
      content: { 'application/json': { schema: zodToSchema(errorEnvelope) } },
    };
  }
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    op.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: doc?.requestBody ? zodToSchema(doc.requestBody) : { type: 'object' },
        },
      },
    };
  }
  return op;
}

export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const { method, path, policy } of ROUTE_TABLE) {
    const dedupe = `${method} ${path}`;
    if (seen.has(dedupe)) continue; // same op registered twice mounts once
    seen.add(dedupe);
    const item = (paths[path] ??= {});
    item[method.toLowerCase()] = operationFor(method, path, policy);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'VoltLink API',
      version: APP_VERSION,
      description:
        'Generated from the live route table and the shared zod schemas. ' +
        'Auth is a session cookie (`vl_session`) plus a CSRF header (`x-vl-csrf`) for mutating requests.',
    },
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'vl_session',
          description: 'Interactive session cookie set by /api/v1/auth/login.',
        },
        csrfHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'x-vl-csrf',
          description: 'CSRF token for mutating requests, issued by /api/v1/auth/csrf.',
        },
        bearerApiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key bearer token (keys start with vlk_).',
        },
      },
    },
  };
}

export const OPENAPI_SPEC_VERSION = APP_VERSION;
export { COMMAND_PARAM_SCHEMAS };
