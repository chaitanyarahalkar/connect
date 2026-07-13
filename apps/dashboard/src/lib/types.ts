import type {
  Branding,
  ConnectorType,
  Environment,
  OAuthConfig,
  Role,
  TokenPolicy,
  TokenResponse,
} from '@connect/shared';

export type { Branding, ConnectorType, Environment, OAuthConfig, Role, TokenPolicy, TokenResponse };

export interface Org {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface Me {
  principal: { kind: string; actorId: string; role: Role };
  organization: { id: string; name: string; slug: string } | null;
}

export type ConnectorStatus = 'active' | 'disabled';

export interface Connector {
  id: string;
  slug: string;
  name: string;
  type: ConnectorType;
  status: ConnectorStatus;
  branding: Branding | null;
  oauthConfig: Partial<OAuthConfig> | null;
  tokenPolicy: TokenPolicy | null;
  clientId: string | null;
  ingestKey: string;
  createdAt: string;
}

export type InstallationStatus = 'pending' | 'active' | 'revoked';

export interface Installation {
  id: string;
  status: InstallationStatus;
  externalAccountId: string;
  externalAccountName: string | null;
  subjectUserId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ProjectLink {
  id: string;
  projectId: string;
  connectorId: string;
  environments: Environment[];
  defaultInstallationId: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface ProjectClient {
  clientId: string;
  environment: Environment;
  createdAt: string;
}

export interface CreatedProjectClient {
  clientId: string;
  clientSecret: string;
  environment: Environment;
  projectId: string;
}

export interface AccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface Member {
  userId: string;
  role: Role;
  name: string | null;
  email: string;
  createdAt: string;
}

export interface UsageRow {
  day: string;
  kind: 'token_request' | 'webhook_delivery';
  connectorId: string;
  total: number;
}

export interface AuditLog {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Trigger {
  id: string;
  name: string;
  destinationUrl: string;
  eventFilter: string | null;
  active: boolean;
  createdAt: string;
}

export interface CreatedTrigger extends Trigger {
  signingSecret: string;
}

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dead';

export interface Delivery {
  id: string;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  eventType: string | null;
}
