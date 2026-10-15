/** Starting match thresholds. Keep conservative so wrong invoices never get high. */
export const STRONG_NAME = 0.82;
export const WEAK_NAME = 0.45;
/** Prefer invoices whose issue/due window is near the transfer date. */
export const DATE_WINDOW_DAYS = 45;
/** Same sender + amount within this window → possibleDuplicate. */
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
/**
 * Largest gap above the invoice balance treated as a bank transfer fee
 * (BI-FAST Rp2.500, RTOL Rp6.500). Above this it is a real overpayment.
 */
export const MAX_BANK_FEE = 6500;
