import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActiveRun,
  AnswerResult,
  FlakeStat,
  Flow,
  FlowListItem,
  FlowOne,
  ImportableSpec,
  ImportResultBody,
  LlmCosts,
  PendingEscalation,
  PromotePreview,
  PromoteResult,
  RecorderSaveResult,
  RecorderStatus,
  RunDetailResponse,
  RunOverview,
  SummaryData,
} from './types';

async function getJson<T>(pathname: string): Promise<T> {
  const res = await fetch(pathname, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function sendJson<T>(pathname: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  const res = await fetch(pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `${pathname} → HTTP ${res.status}`);
  return data;
}

/** Polling cadence for the live-ish dashboard (a run writes to the DB we read). */
const POLL_MS = 4000;

export function useSummary() {
  return useQuery({
    queryKey: ['summary'],
    queryFn: () => getJson<SummaryData>('/api/summary'),
    refetchInterval: POLL_MS,
  });
}

export function useRuns() {
  return useQuery({
    queryKey: ['runs'],
    queryFn: () => getJson<RunOverview[]>('/api/runs'),
    refetchInterval: POLL_MS,
  });
}

export function useRun(id: string | null) {
  return useQuery({
    queryKey: ['run', id],
    enabled: id != null,
    queryFn: () => getJson<RunDetailResponse>(`/api/runs/${id}`),
    // Poll fast while the run is still in flight, then relax.
    refetchInterval: (query) => (query.state.data?.running ? 1500 : POLL_MS),
  });
}

export function useFlake() {
  return useQuery({
    queryKey: ['flake'],
    queryFn: () => getJson<FlakeStat[]>('/api/flake'),
    refetchInterval: POLL_MS,
  });
}

export function useLlmCosts() {
  return useQuery({
    queryKey: ['llm-costs'],
    queryFn: () => getJson<LlmCosts>('/api/llm-costs'),
    refetchInterval: POLL_MS,
  });
}

export function useEscalations() {
  return useQuery({
    queryKey: ['escalations'],
    queryFn: () => getJson<PendingEscalation[]>('/api/escalations'),
    refetchInterval: POLL_MS,
  });
}

export function useActiveRun() {
  return useQuery({
    queryKey: ['active-run'],
    queryFn: () => getJson<ActiveRun>('/api/runs/active'),
    refetchInterval: 1500,
  });
}

/** Trigger a suite run. Refreshes the active-run + runs views on success. */
export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts: { grep?: string; project?: string; heal?: string }) => {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
      return body as { runId: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['active-run'] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
}

export function usePromotePreview(includeUnverified: boolean) {
  return useQuery({
    queryKey: ['promote-preview', includeUnverified],
    queryFn: () =>
      getJson<PromotePreview>(`/api/promote/preview?includeUnverified=${includeUnverified}`),
  });
}

/** Apply reviewed heals into specs → branch → commit → (push + PR if a token is set). */
export function useApplyPromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts: { includeUnverified?: boolean; push?: boolean }) => {
      const res = await fetch('/api/promote/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
      return body as PromoteResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['promote-preview'] });
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['summary'] });
    },
  });
}

// ---- Flows (block editor) ----------------------------------------------------

export function useFlows() {
  return useQuery({
    queryKey: ['flows'],
    queryFn: () => getJson<FlowListItem[]>('/api/flows'),
    refetchInterval: POLL_MS,
  });
}

export function useFlow(path: string | null) {
  return useQuery({
    queryKey: ['flow', path],
    enabled: path != null,
    queryFn: () => getJson<FlowOne>(`/api/flows/one?path=${encodeURIComponent(path!)}`),
  });
}

export function useCreateFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string }) =>
      sendJson<{ path: string; title: string }>('/api/flows', 'POST', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flows'] }),
  });
}

export function useSaveFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; flow: Flow }) =>
      sendJson<{ path: string; title: string; rekeyedRows: number }>('/api/flows', 'PUT', body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['flows'] });
      qc.invalidateQueries({ queryKey: ['flow', vars.path] });
    },
  });
}

export function useImportables() {
  return useQuery({
    queryKey: ['importables'],
    queryFn: () => getJson<ImportableSpec[]>('/api/flows/importable'),
  });
}

export function useImportSpec() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { specPath: string }) =>
      sendJson<ImportResultBody>('/api/flows/import', 'POST', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flows'] });
      qc.invalidateQueries({ queryKey: ['importables'] });
    },
  });
}

// ---- Recorder ------------------------------------------------------------------

export function useRecorderStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['recorder'],
    enabled,
    queryFn: () => getJson<RecorderStatus>('/api/recorder/status'),
    refetchInterval: 1000,
  });
}

export function useStartRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string }) =>
      sendJson<RecorderStatus>('/api/recorder/start', 'POST', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recorder'] }),
  });
}

export function useStopRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => sendJson<RecorderStatus>('/api/recorder/stop', 'POST', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recorder'] }),
  });
}

export function useSaveRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string }) =>
      sendJson<RecorderSaveResult>('/api/recorder/save', 'POST', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recorder'] });
      qc.invalidateQueries({ queryKey: ['flows'] });
    },
  });
}

/** Answer an escalation (candidate label or REDESIGN); refreshes affected views. */
export function useAnswerEscalation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, choice }: { id: number; choice: string }) => {
      const res = await fetch(`/api/escalations/${id}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choice }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
      return body as AnswerResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['escalations'] });
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['summary'] });
    },
  });
}
