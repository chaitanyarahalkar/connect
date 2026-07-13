'use client';

import Link from 'next/link';
import { EmptyState, ErrorText, Spinner } from '@/components/feedback';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { TYPE_LABELS } from '@/lib/labels';
import type { Connector } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { formatDate } from '@/lib/utils';

export default function ConnectorsPage() {
  const { data, loading, error, refetch } = useApi<{ connectors: Connector[] }>('/v1/connectors');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
          <p className="text-sm text-zinc-500">
            Third-party integrations your projects can request tokens for.
          </p>
        </div>
        <Link href="/connectors/new">
          <Button>New connector</Button>
        </Link>
      </div>

      {error ? (
        <ErrorText error={error} onRetry={refetch} />
      ) : loading ? (
        <Spinner label="Loading connectors…" />
      ) : (data?.connectors.length ?? 0) === 0 ? (
        <EmptyState
          title="No connectors yet"
          description="Create your first connector to start brokering credentials for GitHub, Slack, or any OAuth / API-key provider."
          action={
            <Link href="/connectors/new">
              <Button>Create connector</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.connectors.map((connector) => (
            <Link key={connector.id} href={`/connectors/${connector.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="p-5">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: connector.branding?.color ?? '#a1a1aa' }}
                    />
                    <span className="truncate font-medium text-zinc-900">{connector.name}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-zinc-500">{connector.slug}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <Badge variant="outline">{TYPE_LABELS[connector.type]}</Badge>
                    <Badge variant={connector.status === 'active' ? 'success' : 'warning'}>
                      {connector.status}
                    </Badge>
                  </div>
                  <p className="mt-3 text-xs text-zinc-400">
                    Created {formatDate(connector.createdAt)}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
