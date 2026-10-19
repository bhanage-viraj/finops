import { loadSyncState, runInvoiceSync, zohoConnection } from './invoiceStore.js';

const TICK_MS = 60 * 1000;
const FIRST_TICK_MS = 15 * 1000;
export const CHANGES_EVERY_MS = 10 * 60 * 1000;
const ERROR_BACKOFF_MS = 10 * 60 * 1000;
// Full read at 02:00 Bali time (WITA, UTC+8), when nobody is matching payments.
const NIGHT_HOUR_WITA = 2;
const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The most recent 02:00 WITA at or before now. */
export function lastNightlyMark(now = new Date()) {
  const local = new Date(now.getTime() + WITA_OFFSET_MS);
  const mark = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), NIGHT_HOUR_WITA)
    - WITA_OFFSET_MS;
  return new Date(mark <= now.getTime() ? mark : mark - 86_400_000);
}

/** 'full', 'changes', or null when nothing is due. */
export function nextInvoiceJob(state, now = new Date()) {
  const time = (value) => (value ? new Date(value).getTime() : 0);
  if (state?.lastErrorAt && now.getTime() - time(state.lastErrorAt) < ERROR_BACKOFF_MS) return null;
  if (!state?.lastFullOkAt || state.needsFull) return 'full';
  if (time(state.lastFullStartedAt) < lastNightlyMark(now).getTime()) return 'full';
  if (now.getTime() - time(state.lastChangesRunAt) >= CHANGES_EVERY_MS) return 'changes';
  return null;
}

/** Starts the background sync. Returns a stop function. */
export function startInvoiceSync(env) {
  if (env.zoho?.invoiceSync === false) return () => {};
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const conn = await zohoConnection(env);
      if (!conn.ready) return;
      const kind = nextInvoiceJob(await loadSyncState(), new Date());
      if (kind) await runInvoiceSync(kind, env, conn);
    } catch (error) {
      console.error('Zoho invoice sync failed', error.message);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, FIRST_TICK_MS);
  const timer = setInterval(tick, TICK_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
