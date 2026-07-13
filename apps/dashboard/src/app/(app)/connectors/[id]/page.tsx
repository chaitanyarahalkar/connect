'use client';

import { use, useState } from 'react';
import { useApi } from '@/lib/use-api';
import { apiFetch } from '@/lib/api';
import { TYPE_LABELS } from '@/lib/labels';
import type { Connector } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { Spinner, ErrorText } from '@/components/feedback';
import { useToast } from '@/components/toast';
import { ConnectorOverviewTab } from '@/components/connector/overview-tab';
import { InstallationsTab } from '@/components/connector/installations-tab';
import { LinksTab } from '@/components/connector/links-tab';
import { TriggersTab } from '@/components/connector/triggers-tab';
import { ConnectorSettingsTab } from '@/components/connector/settings-tab';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'installations', label: 'Installations' },
  { id: 'links', label: 'Links' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'settings', label: 'Settings' },
];

export default function ConnectorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { toast } = useToast();
  const [tab, setTab] = useState('overview');
  const [toggling, setToggling] = useState(false);

  const { data, loading, error, refetch } = useApi<{ connector: Connector }>(
    `/v1/connectors/${id}`,
  );
  const connector = data?.connector ?? null;

  const toggleStatus = async () => {
    if (!connector) return;
    setToggling(true);
    try {
      await apiFetch(`/v1/connectors/${connector.id}`, {
        method: 'PATCH',
        body: { status: connector.status === 'active' ? 'disabled' : 'active' },
      });
      toast(connector.status === 'active' ? 'Connector disabled' : 'Connector enabled');
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setToggling(false);
    }
  };

  if (loading) return <Spinner label="Loading connector…" />;
  if (error) return <ErrorText error={error} onRetry={refetch} />;
  if (!connector) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: connector.branding?.color ?? '#a1a1aa' }}
          />
          <h1 className="text-2xl font-semibold tracking-tight">{connector.name}</h1>
          <Badge variant="outline">{TYPE_LABELS[connector.type]}</Badge>
          <Badge variant={connector.status === 'active' ? 'success' : 'warning'}>
            {connector.status}
          </Badge>
        </div>
        <Button
          variant="outline"
          size="sm"
          loading={toggling}
          onClick={() => void toggleStatus()}
        >
          {connector.status === 'active' ? 'Disable' : 'Enable'}
        </Button>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      <TabPanel active={tab === 'overview'}>
        <ConnectorOverviewTab connector={connector} />
      </TabPanel>
      <TabPanel active={tab === 'installations'}>
        <InstallationsTab connector={connector} />
      </TabPanel>
      <TabPanel active={tab === 'links'}>
        <LinksTab connector={connector} />
      </TabPanel>
      <TabPanel active={tab === 'triggers'}>
        <TriggersTab connector={connector} />
      </TabPanel>
      <TabPanel active={tab === 'settings'}>
        <ConnectorSettingsTab connector={connector} onUpdated={refetch} />
      </TabPanel>
    </div>
  );
}
