import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

export * from './auth-schema.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['owner', 'admin', 'member']);
export const environmentEnum = pgEnum('environment', ['production', 'preview', 'development']);
export const connectorTypeEnum = pgEnum('connector_type', ['oauth2', 'api_key', 'github', 'slack']);
export const connectorStatusEnum = pgEnum('connector_status', ['active', 'disabled']);
export const secretKindEnum = pgEnum('secret_kind', [
  'oauth_client_secret',
  'api_key',
  'webhook_secret',
  'github_app_private_key',
  'slack_signing_secret',
]);
export const installationStatusEnum = pgEnum('installation_status', [
  'pending',
  'active',
  'revoked',
]);
export const grantTypeEnum = pgEnum('grant_type', [
  'refresh_token',
  'access_token',
  'api_key',
  'github_app_installation',
]);
export const subjectTypeEnum = pgEnum('subject_type', ['app', 'user', 'jwt_bearer']);
export const requesterEnum = pgEnum('requester', ['oidc', 'pat', 'session']);
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'delivering',
  'succeeded',
  'failed',
  'dead',
]);
export const usageKindEnum = pgEnum('usage_kind', ['token_request', 'webhook_delivery']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'access_token', 'workload', 'system']);

// ---------------------------------------------------------------------------
// Orgs / projects / identity
// ---------------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('member'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId)],
);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_org_slug_uq').on(t.orgId, t.slug)],
);

/** Workload identity: client-credentials pair a deployment uses to mint OIDC JWTs. */
export const projectClients = pgTable('project_clients', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash').notNull(),
  environment: environmentEnum('environment').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
});

export const accessTokens = pgTable(
  'access_tokens',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    expiresAt: timestamp('expires_at'),
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('access_tokens_prefix_idx').on(t.tokenPrefix)],
);

/** ES256 signing keys for the OIDC issuer; private key is envelope-encrypted. */
export const signingKeys = pgTable('signing_keys', {
  id: text('id').primaryKey(), // kid
  privateKeyCiphertext: jsonb('private_key_ciphertext').notNull(),
  publicKeyPem: text('public_key_pem').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export const connectors = pgTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    type: connectorTypeEnum('type').notNull(),
    status: connectorStatusEnum('status').notNull().default('active'),
    branding: jsonb('branding'),
    /** OAuthConfig from @connect/shared for oauth2/github/slack types. */
    oauthConfig: jsonb('oauth_config'),
    /** Public OAuth client id (not secret). */
    clientId: text('client_id'),
    /** Random path token for the webhook ingest URL. */
    ingestKey: text('ingest_key').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connectors_org_slug_uq').on(t.orgId, t.slug)],
);

export const connectorSecrets = pgTable(
  'connector_secrets',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    kind: secretKindEnum('kind').notNull(),
    /** EncryptedBlob from @connect/crypto. AAD = connector_secrets:<id>:<kind> */
    ciphertext: jsonb('ciphertext').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connector_secrets_connector_kind_uq').on(t.connectorId, t.kind)],
);

// ---------------------------------------------------------------------------
// Installations & grants
// ---------------------------------------------------------------------------

export const installations = pgTable(
  'installations',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    status: installationStatusEnum('status').notNull().default('active'),
    /** Provider-side account: Slack team id, GitHub org login, OAuth sub… */
    externalAccountId: text('external_account_id'),
    externalAccountName: text('external_account_name'),
    /** For user-subject grants: the end-user id this installation belongs to. */
    subjectUserId: text('subject_user_id'),
    installedByUserId: text('installed_by_user_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('installations_connector_idx').on(t.connectorId)],
);

export const installationGrants = pgTable(
  'installation_grants',
  {
    id: text('id').primaryKey(),
    installationId: text('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    grantType: grantTypeEnum('grant_type').notNull(),
    /** EncryptedBlob. AAD = installation_grants:<installationId>:<grantType> */
    ciphertext: jsonb('ciphertext').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    expiresAt: timestamp('expires_at'),
    rotatedAt: timestamp('rotated_at'),
    /** Rotation history: the grant row that replaced this one. Null = current. */
    supersededById: text('superseded_by_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('installation_grants_installation_idx').on(t.installationId)],
);

// ---------------------------------------------------------------------------
// Project links
// ---------------------------------------------------------------------------

export const projectLinks = pgTable(
  'project_links',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    environments: environmentEnum('environments').array().notNull(),
    defaultInstallationId: text('default_installation_id').references(() => installations.id, {
      onDelete: 'set null',
    }),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_links_project_connector_uq').on(t.projectId, t.connectorId)],
);

// ---------------------------------------------------------------------------
// Triggers / webhooks
// ---------------------------------------------------------------------------

export const triggers = pgTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    destinationUrl: text('destination_url').notNull(),
    /** Optional provider event-type filter (exact match, e.g. "push"). */
    eventFilter: text('event_filter'),
    /** EncryptedBlob: HMAC key used to sign forwarded requests. */
    signingSecretCiphertext: jsonb('signing_secret_ciphertext').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('triggers_connector_idx').on(t.connectorId)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    providerEventType: text('provider_event_type'),
    signatureValid: boolean('signature_valid').notNull(),
    /** Provider delivery id when present (dedup). */
    dedupKey: text('dedup_key'),
    payload: jsonb('payload').notNull(),
    /** Redacted headers. */
    headers: jsonb('headers').notNull(),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
  },
  (t) => [
    index('webhook_events_connector_idx').on(t.connectorId, t.receivedAt),
    uniqueIndex('webhook_events_dedup_uq').on(t.connectorId, t.dedupKey),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookEventId: text('webhook_event_id')
      .notNull()
      .references(() => webhookEvents.id, { onDelete: 'cascade' }),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at'),
    deliveredAt: timestamp('delivered_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('webhook_deliveries_trigger_idx').on(t.triggerId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Metering / audit
// ---------------------------------------------------------------------------

/** One row per token issuance. Audit + metering; never stores token material. */
export const tokenIssuances = pgTable(
  'token_issuances',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id'),
    connectorId: text('connector_id').notNull(),
    installationId: text('installation_id'),
    subjectType: subjectTypeEnum('subject_type').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    cacheHit: boolean('cache_hit').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    requestedBy: requesterEnum('requested_by').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('token_issuances_org_idx').on(t.orgId, t.createdAt)],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id'),
    connectorId: text('connector_id'),
    kind: usageKindEnum('kind').notNull(),
    quantity: integer('quantity').notNull().default(1),
    occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('usage_events_org_time_idx').on(t.orgId, t.occurredAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_logs_org_time_idx').on(t.orgId, t.createdAt)],
);
