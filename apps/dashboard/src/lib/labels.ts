import type { ConnectorType, DeliveryStatus, InstallationStatus } from './types';

export const TYPE_LABELS: Record<ConnectorType, string> = {
  oauth2: 'OAuth 2.0',
  api_key: 'API key',
  github: 'GitHub',
  slack: 'Slack',
};

export const INSTALLATION_BADGE: Record<
  InstallationStatus,
  'success' | 'warning' | 'destructive'
> = {
  active: 'success',
  pending: 'warning',
  revoked: 'destructive',
};

export const DELIVERY_BADGE: Record<
  DeliveryStatus,
  'success' | 'warning' | 'destructive' | 'secondary'
> = {
  succeeded: 'success',
  pending: 'secondary',
  delivering: 'warning',
  failed: 'destructive',
  dead: 'destructive',
};
