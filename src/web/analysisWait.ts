import type { AnalysisWaitReason } from './api.ts';
import { t } from './i18n.ts';

/** Powód, dla którego zlecona analiza jeszcze nie ruszyła (podpowiedź przy pigułce). */
export function waitReasonText(r: AnalysisWaitReason | null | undefined): string | undefined {
  switch (r) {
    case 'queue_off': return t('Team queue is off');
    case 'no_pc_online': return t('No PC online');
    case 'no_repo_pc': return t("No PC has this project's repo");
    case 'awaiting_consent': return t("Waiting for the PC owner's consent");
    default: return undefined;
  }
}
