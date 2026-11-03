import { isNotNull, lt, or, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { agentJobs, agentPairings } from '../db/schema.ts';

const HOUR = 60 * 60 * 1000;

/** Raz na godzinę: stare zlecenia agenta (pobrane albo starsze niż doba) i wygasłe parowania. */
export async function runCleanup() {
  await db.delete(agentJobs).where(or(isNotNull(agentJobs.claimedAt), lt(agentJobs.createdAt, dsql`now() - interval '1 day'`)));
  await db.delete(agentPairings).where(lt(agentPairings.expiresAt, dsql`now()`));
}

export function startCleanup(): () => void {
  const tick = () => { runCleanup().catch((e) => console.error('cleanup failed', e)); };
  const timer = setInterval(tick, HOUR);
  timer.unref?.();
  return () => clearInterval(timer);
}
