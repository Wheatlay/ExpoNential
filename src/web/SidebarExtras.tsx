import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, useIssues, useMeta } from './api.ts';
import { StatusIcon, startedFraction } from './icons.tsx';
import { linkProps, usePath } from './router.ts';
import { timeAgo } from './time.ts';
import { getProjectKey, ident } from './project.ts';
import { t } from './i18n.ts';

const KEY = 'recentIssues';

/** Identyfikatory ("WEB-3"). */
function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as (string | number)[];
    return raw.filter((x): x is string => typeof x === 'string');
  } catch { return []; }
}

/** Zapamiętuje otwarte zadanie (ostatnie 15 ze wszystkich projektów) w przeglądarce. */
export function rememberIssue(number: number) {
  try {
    const id = ident(number);
    const next = [id, ...readRecent().filter((n) => n !== id)].slice(0, 15);
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('recent-issues'));
  } catch { /* prywatne okno */ }
}

/** Ostatnie zadania bieżącego projektu (numery). */
function useRecent() {
  const read = () => readRecent().filter((id) => id.startsWith(`${getProjectKey()}-`)).slice(0, 5).map((id) => Number(id.split('-')[1]));
  const [list, setList] = useState<number[]>(read);
  useEffect(() => {
    const on = () => setList(read());
    window.addEventListener('recent-issues', on);
    return () => window.removeEventListener('recent-issues', on);
  }, []);
  return list;
}

export function RecentIssues({ onNavigate }: { onNavigate: () => void }) {
  const recent = useRecent();
  const issues = useIssues().data ?? [];
  const meta = useMeta().data;
  const path = usePath();
  const rows = recent.map((n) => issues.find((i) => i.number === n)).filter((i) => !!i);
  if (!rows.length || !meta) return null;
  return (
    <>
      <div className="nav-section">{t('Recent')}</div>
      {rows.map((i) => {
        const st = meta.statuses.find((s) => s.id === i.statusId)!;
        return (
          <a key={i.number} className={`nav-item recent ${path === `/issue/${ident(i.number)}` ? 'active' : ''}`} {...linkProps(`/issue/${ident(i.number)}`)} onClickCapture={onNavigate} title={`${ident(i.number)} ${i.title}`}>
            <StatusIcon status={st} fraction={startedFraction(meta.statuses, st)} size={13} />
            <span className="recent-text">
              <span className="recent-title">{i.title}</span>
              <span className="recent-person">{ident(i.number)} · {meta.users.find((u) => u.id === i.assigneeId)?.name ?? t('Unassigned')}</span>
            </span>
          </a>
        );
      })}
    </>
  );
}

type Deploy = { status: string; startedAt: string | null; finishedAt: string | null; commit: string | null; message: string | null; author: string | null } | null;

/** Status deployu aplikacji bieżącego projektu: trwa / udany / nieudany, odświeżany na żywo przez SSE. */
export function DeployStatus() {
  const q = useQuery({ queryKey: ['deploy'], queryFn: () => api<{ enabled: boolean; deploy: Deploy }>('/api/deploy-status'), refetchInterval: 60_000 });
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 15_000); return () => clearInterval(t); }, []);
  const d = q.data?.deploy;
  if (!q.data?.enabled || !d) return null;
  const running = d.status === 'queued' || d.status === 'in_progress';
  const label = running ? (d.status === 'queued' ? t('Deploy queued') : t('Deploying…'))
    : d.status === 'finished' ? t('Deployed') : d.status === 'failed' ? t('Deploy failed') : t('Deploy cancelled');
  const when = running ? d.startedAt : d.finishedAt ?? d.startedAt;
  // Status mówi kolor (kropka i ramka), słowo zostaje w podpowiedzi i dla czytników ekranu.
  return (
    <div className={`deploy-status ${d.status}`} role="status" aria-label={label}
      title={[label, d.commit?.slice(0, 7), d.message].filter(Boolean).join(' · ')}>
      <span className="deploy-dot" />
      <span className="deploy-text">
        <span className="deploy-meta">{when ? timeAgo(when) : ''}{d.author && <> · <b>{d.author}</b></>}</span>
        {d.message && <span className="deploy-msg">{d.message}</span>}
      </span>
    </div>
  );
}
