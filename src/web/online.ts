import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

type Online = { online: number[]; lastSeen: Record<string, string> };
const RECENT_MS = 15 * 60 * 1000;

/** Zielona kropka: ma otwarty tracker. Żółta: był w ciągu ostatnich 15 minut. */
export function useOnlineStatus(userId: number | undefined): 'online' | 'recent' | null {
  const q = useQuery({ queryKey: ['online'], queryFn: () => api<Online>('/api/online'), staleTime: 60_000, refetchInterval: 60_000 });
  if (!userId || !q.data) return null;
  if (q.data.online.includes(userId)) return 'online';
  const seen = q.data.lastSeen[userId];
  return seen && Date.now() - new Date(seen).getTime() < RECENT_MS ? 'recent' : null;
}
