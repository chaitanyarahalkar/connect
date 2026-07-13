import { z } from 'zod';

export const environmentSchema = z.enum(['production', 'preview', 'development']);
export type Environment = z.infer<typeof environmentSchema>;

export const connectorTypeSchema = z.enum(['oauth2', 'api_key', 'github', 'slack']);
export type ConnectorType = z.infer<typeof connectorTypeSchema>;

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof roleSchema>;

export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase letters, digits and hyphens');

// ---------------------------------------------------------------------------
// Connector configuration
// ---------------------------------------------------------------------------

export const oauthConfigSchema = z.object({
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url().optional(),
  userinfoEndpoint: z.string().url().optional(),
  issuer: z.string().url().optional(),
  scopesDefault: z.array(z.string()).default([]),
  pkce: z.boolean().default(true),
  tokenEndpointAuth: z.enum(['basic', 'post']).default('post'),
  /** Key into the provider quirks registry (e.g. 'slack', 'github', 'mock'). */
  quirksKey: z.string().optional(),
});
export type OAuthConfig = z.infer<typeof oauthConfigSchema>;

/**
 * Per-connector token policy, enforced on every POST /v1/tokens:
 * subject/scope allow-lists, a cap on returned token lifetime, and an
 * installation-scoped fixed-window rate limit.
 */
export const tokenPolicySchema = z.object({
  /** Cap on returned token lifetime (seconds); longer-lived results are clamped. */
  maxTtlSeconds: z.number().int().min(30).max(86_400).optional(),
  /** Scopes a caller may request. Absent = no restriction. */
  allowedScopes: z.array(z.string()).optional(),
  /** Subject types a caller may use. Absent = no restriction. */
  allowedSubjects: z.array(z.enum(['app', 'user', 'jwt-bearer'])).optional(),
  /**
   * Token requests allowed per installation per window (cache hits count).
   * Requests without an installation (api_key, bare jwt-bearer) share one
   * connector-wide bucket.
   */
  rateLimit: z
    .object({
      limit: z.number().int().min(1),
      windowSeconds: z.number().int().min(1).max(3600),
    })
    .optional(),
});
export type TokenPolicy = z.infer<typeof tokenPolicySchema>;

export const brandingSchema = z.object({
  iconUrl: z.string().url().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type Branding = z.infer<typeof brandingSchema>;

export const createConnectorSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  type: connectorTypeSchema,
  oauthConfig: oauthConfigSchema.optional(),
  branding: brandingSchema.optional(),
  tokenPolicy: tokenPolicySchema.optional(),
  /** Write-only secrets supplied at create time. Never returned. */
  secrets: z
    .object({
      oauthClientId: z.string().optional(),
      oauthClientSecret: z.string().optional(),
      apiKey: z.string().optional(),
      webhookSecret: z.string().optional(),
      githubAppId: z.string().optional(),
      githubAppPrivateKey: z.string().optional(),
      slackSigningSecret: z.string().optional(),
    })
    .optional(),
});
export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;

// ---------------------------------------------------------------------------
// Token requests
// ---------------------------------------------------------------------------

export const tokenSubjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('app') }),
  z.object({ type: z.literal('user'), userId: z.string().min(1) }),
  z.object({
    type: z.literal('jwt-bearer'),
    assertion: z.string().min(1),
  }),
]);
export type TokenSubject = z.infer<typeof tokenSubjectSchema>;

export const tokenRequestSchema = z.object({
  connector: z.string().min(1),
  installationId: z.string().optional(),
  subject: tokenSubjectSchema.default({ type: 'app' }),
  scopes: z.array(z.string()).optional(),
  resource: z.string().optional(),
  authorizationDetails: z.array(z.record(z.unknown())).optional(),
});
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export const tokenResponseSchema = z.object({
  token: z.string(),
  tokenType: z.enum(['bearer', 'api_key']),
  expiresAt: z.string().datetime(),
  scopes: z.array(z.string()),
  connectorId: z.string(),
  installationId: z.string().nullable(),
  cached: z.boolean(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

// ---------------------------------------------------------------------------
// Misc API shapes shared by SDK/CLI/dashboard
// ---------------------------------------------------------------------------

export const projectLinkSchema = z.object({
  projectId: z.string(),
  connectorId: z.string(),
  environments: z.array(environmentSchema).min(1),
  defaultInstallationId: z.string().nullable().optional(),
});
export type ProjectLinkInput = z.infer<typeof projectLinkSchema>;

export const oidcTokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});
