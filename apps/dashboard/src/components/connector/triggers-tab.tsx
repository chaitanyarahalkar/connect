'use client';

import { type FormEvent, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorText, Spinner } from '@/components/feedback';
import { SecretReveal } from '@/components/secret-reveal';
import { useToast } from '@/components/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { DELIVERY_BADGE } from '@/lib/labels';
import type {
  Connector,
  CreatedTrigger,
  Delivery,
  DeliveryDetail,
  DeliveryStatus,
  Trigger,
} from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { formatDateTime, relativeTime } from '@/lib/utils';

export function TriggersTab({ connector }: { connector: Connector }) {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi<{ triggers: Trigger[] }>(
    `/v1/connectors/${connector.id}/triggers`,
  );

  const [name, setName] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [eventFilter, setEventFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<CreatedTrigger | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Trigger | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<Trigger | null>(null);

  const createTrigger = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch<{ trigger: CreatedTrigger }>(
        `/v1/connectors/${connector.id}/triggers`,
        {
          method: 'POST',
          body: {
            name,
            destinationUrl,
            ...(eventFilter.trim() ? { eventFilter: eventFilter.trim() } : {}),
          },
        },
      );
      setName('');
      setDestinationUrl('');
      setEventFilter('');
      setCreatedSecret(res.trigger);
      refetch();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (trigger: Trigger) => {
    setTogglingId(trigger.id);
    try {
      await apiFetch(`/v1/triggers/${trigger.id}`, {
        method: 'PATCH',
        body: { active: !trigger.active },
      });
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setTogglingId(null);
    }
  };

  const deleteTrigger = async (trigger: Trigger) => {
    try {
      await apiFetch(`/v1/triggers/${trigger.id}`, { method: 'DELETE' });
      toast('Trigger deleted');
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  };

  const triggers = data?.triggers ?? [];

  return (
    <div className="space-y-4">
      {error ? (
        <ErrorText error={error} onRetry={refetch} />
      ) : loading ? (
        <Spinner label="Loading triggers…" />
      ) : triggers.length === 0 ? (
        <EmptyState
          title="No trigger destinations"
          description="Add a destination URL to fan incoming provider webhooks out to your services, signed with a per-trigger secret."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Filter</TableHead>
              <TableHead>Active</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {triggers.map((trigger) => (
              <TableRow key={trigger.id}>
                <TableCell className="font-medium text-zinc-900">{trigger.name}</TableCell>
                <TableCell
                  className="max-w-64 truncate font-mono text-xs"
                  title={trigger.destinationUrl}
                >
                  {trigger.destinationUrl}
                </TableCell>
                <TableCell className="font-mono text-xs">{trigger.eventFilter ?? '*'}</TableCell>
                <TableCell>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={trigger.active}
                    disabled={togglingId === trigger.id}
                    onClick={() => void toggleActive(trigger)}
                    className={`relative h-5 w-9 rounded-full transition-colors ${
                      trigger.active ? 'bg-emerald-500' : 'bg-zinc-300'
                    } disabled:opacity-50`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                        trigger.active ? 'left-4.5' : 'left-0.5'
                      }`}
                    />
                  </button>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setDeliveriesFor(trigger)}>
                      Deliveries
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(trigger)}>
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add trigger destination</CardTitle>
          <CardDescription>
            Webhooks received on the ingest URL are delivered to this endpoint with an HMAC
            signature.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createTrigger(e)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="trig-name">Name</Label>
                <Input
                  id="trig-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ci-notifier"
                />
              </div>
              <div>
                <Label htmlFor="trig-filter">Event filter (optional)</Label>
                <Input
                  id="trig-filter"
                  value={eventFilter}
                  onChange={(e) => setEventFilter(e.target.value)}
                  placeholder="push"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="trig-url">Destination URL</Label>
              <Input
                id="trig-url"
                required
                type="url"
                value={destinationUrl}
                onChange={(e) => setDestinationUrl(e.target.value)}
                placeholder="https://myapp.example.com/hooks/connect"
              />
            </div>
            {createError ? <p className="text-sm text-red-700">{createError}</p> : null}
            <Button type="submit" loading={creating}>
              Create trigger
            </Button>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={createdSecret !== null}
        onClose={() => setCreatedSecret(null)}
        title="Trigger created"
        description="This signing secret is shown only once. Use it to verify delivery signatures."
      >
        {createdSecret ? (
          <div className="space-y-4">
            <SecretReveal value={createdSecret.signingSecret} />
            <div className="flex justify-end">
              <Button onClick={() => setCreatedSecret(null)}>Done</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await deleteTrigger(deleteTarget);
        }}
        title="Delete trigger"
        description={`Delete "${deleteTarget?.name ?? ''}"? Pending deliveries will be dropped.`}
      />

      {deliveriesFor ? (
        <DeliveriesDialog trigger={deliveriesFor} onClose={() => setDeliveriesFor(null)} />
      ) : null}
    </div>
  );
}

function DeliveriesDialog({ trigger, onClose }: { trigger: Trigger; onClose: () => void }) {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<DeliveryStatus | 'all'>('all');
  const { data, loading, error, refetch } = useApi<{ deliveries: Delivery[] }>(
    `/v1/triggers/${trigger.id}/deliveries${statusFilter === 'all' ? '' : `?status=${statusFilter}`}`,
  );
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const [inspecting, setInspecting] = useState<Delivery | null>(null);

  const redeliver = async (delivery: Delivery) => {
    setRedelivering(delivery.id);
    try {
      await apiFetch(`/v1/deliveries/${delivery.id}/redeliver`, { method: 'POST', body: {} });
      toast('Redelivery queued');
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setRedelivering(null);
    }
  };

  const drain = async () => {
    setDraining(true);
    try {
      const res = await apiFetch<{ drained: number }>(`/v1/triggers/${trigger.id}/drain`, {
        method: 'POST',
        body: {},
      });
      toast(
        res.drained === 0
          ? 'No dead-letter deliveries to drain'
          : `Re-queued ${res.drained} dead ${res.drained === 1 ? 'delivery' : 'deliveries'}`,
      );
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDraining(false);
    }
  };

  const deliveries = data?.deliveries ?? [];
  const deadCount = deliveries.filter((d) => d.status === 'dead').length;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Deliveries — ${trigger.name}`}
      description="Recent webhook fan-out attempts for this destination."
      wide
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as DeliveryStatus | 'all')}
          className="max-w-40"
        >
          <option value="all">All statuses</option>
          <option value="dead">Dead</option>
          <option value="failed">Failed</option>
          <option value="succeeded">Succeeded</option>
          <option value="pending">Pending</option>
          <option value="delivering">Delivering</option>
        </Select>
        <Button variant="outline" size="sm" loading={draining} onClick={() => void drain()}>
          Drain dead letters{deadCount > 0 && statusFilter === 'all' ? ` (${deadCount})` : ''}
        </Button>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {error ? (
          <ErrorText error={error} onRetry={refetch} />
        ) : loading ? (
          <Spinner label="Loading deliveries…" />
        ) : deliveries.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            {statusFilter === 'all'
              ? 'No deliveries yet. Send a webhook to the ingest URL to see them here.'
              : `No ${statusFilter} deliveries.`}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Response</TableHead>
                <TableHead>When</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-xs">{d.eventType ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={DELIVERY_BADGE[d.status]}>{d.status}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">{d.attempts}</TableCell>
                  <TableCell className="max-w-40">
                    {d.responseStatus ?? ''}
                    {d.lastError ? (
                      <span className="block truncate text-xs text-red-600" title={d.lastError}>
                        {d.lastError}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell title={formatDateTime(d.deliveredAt ?? d.createdAt)}>
                    {relativeTime(d.deliveredAt ?? d.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setInspecting(d)}>
                        Inspect
                      </Button>
                      {d.status === 'failed' || d.status === 'dead' || d.status === 'succeeded' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={redelivering === d.id}
                          onClick={() => void redeliver(d)}
                        >
                          Redeliver
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={refetch}>
          Refresh
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
      {inspecting ? (
        <DeliveryDetailDialog
          delivery={inspecting}
          onClose={() => setInspecting(null)}
          onRedeliver={() => {
            setInspecting(null);
            void redeliver(inspecting);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function DeliveryDetailDialog({
  delivery,
  onClose,
  onRedeliver,
}: {
  delivery: Delivery;
  onClose: () => void;
  onRedeliver: () => void;
}) {
  const { data, loading, error, refetch } = useApi<{ delivery: DeliveryDetail }>(
    `/v1/deliveries/${delivery.id}`,
  );
  const detail = data?.delivery;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delivery detail"
      description={`Delivery ${delivery.id}`}
      wide
    >
      {error ? (
        <ErrorText error={error} onRetry={refetch} />
      ) : loading || !detail ? (
        <Spinner label="Loading delivery…" />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={DELIVERY_BADGE[detail.status]}>{detail.status}</Badge>
            <span className="text-zinc-500">
              {detail.attempts} attempt{detail.attempts === 1 ? '' : 's'}
              {detail.responseStatus ? ` · last response ${detail.responseStatus}` : ''}
              {detail.event.signatureValid ? '' : ' · provider signature invalid'}
            </span>
          </div>
          <div className="font-mono text-xs text-zinc-600">
            {detail.event.type ?? 'unknown event'} → {detail.destinationUrl}
          </div>
          {detail.lastError ? <p className="text-xs text-red-600">{detail.lastError}</p> : null}
          <div>
            <p className="mb-1 font-medium text-zinc-900">Payload</p>
            <pre className="max-h-64 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs">
              {JSON.stringify(detail.event.payload, null, 2)}
            </pre>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onRedeliver}>
              Redeliver
            </Button>
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
