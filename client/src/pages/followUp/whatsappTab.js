export const WHATSAPP_TAB = 'finops-whatsapp';
export const PDF_TAB = 'finops-invoice';

/** WhatsApp Web in the browser — avoids opening the native WhatsApp app. */
export function whatsappUrl(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const q = encodeURIComponent(text || '');
  if (digits) return `https://web.whatsapp.com/send?phone=${digits}&text=${q}`;
  return `https://web.whatsapp.com/send?text=${q}`;
}

/**
 * What to put on the clipboard.
 * Once WhatsApp is already open, the number is what they paste into search.
 * The reminder text stays in the box so it is not sent to the previous chat.
 */
export function clipboardPlan(result, phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (result?.status === 'same' && digits) return { text: digits, kind: 'number' };
  return { text: text || '', kind: 'message' };
}

function focus(tab) {
  try {
    tab?.focus();
  } catch {
    // The tab can be cross-origin. Focusing is optional.
  }
}

/**
 * One WhatsApp tab for the whole Follow-up session.
 *
 * WhatsApp Web sends Cross-Origin-Opener-Policy: same-origin, so after that
 * tab loads, another window.open cannot navigate it — it starts a second
 * WhatsApp and reloads. That reload is the slow part. The first share opens
 * the tab. Later shares keep it and tell the caller to paste.
 */
export function createWhatsAppOpener() {
  let tab = null;
  let opened = false;

  function remember(next) {
    tab = next;
    opened = true;
  }

  function navigate(target, url, first) {
    try {
      target.location.href = url;
      focus(target);
      remember(target);
      return { status: 'opened', url, first };
    } catch {
      remember(target);
      return { status: 'same', url, first: false };
    }
  }

  return {
    /** Call in the click, before any await, when the phone and text are known. */
    open(phone, text) {
      const url = whatsappUrl(phone, text);
      const first = !opened;
      if (tab && !tab.closed) return navigate(tab, url, first);
      if (opened) return { status: 'same', url, first: false };
      const next = window.open(url, WHATSAPP_TAB);
      if (!next) return { status: 'blocked', url, first: false };
      remember(next);
      focus(next);
      return { status: 'opened', url, first };
    },

    /**
     * Call in the click when the phone is not known yet (summary PDF).
     * Reserves the tab so the browser does not block it after the download.
     */
    begin() {
      if (tab && !tab.closed) return { mode: 'live', tab };
      if (opened) return { mode: 'existing' };
      const next = window.open('', WHATSAPP_TAB);
      if (!next) return { mode: 'blocked' };
      tab = next;
      return { mode: 'reserved', tab: next };
    },

    finish(begun, phone, text) {
      const url = whatsappUrl(phone, text);
      const first = !opened;
      if (!begun || begun.mode === 'blocked') {
        return { status: begun?.mode === 'blocked' ? 'blocked' : 'same', url, first: false };
      }
      if (begun.mode === 'existing') return { status: 'same', url, first: false };
      const target = begun.tab;
      if (target && !target.closed) return navigate(target, url, first);
      if (opened) return { status: 'same', url, first: false };
      const next = window.open(url, WHATSAPP_TAB);
      if (!next) return { status: 'blocked', url, first: false };
      remember(next);
      focus(next);
      return { status: 'opened', url, first };
    },

    /** Close a blank tab reserved by begin() when we never navigated it. */
    cancel(begun) {
      if (begun?.mode !== 'reserved' || opened || tab !== begun.tab) return;
      const reserved = begun.tab;
      if (!reserved || reserved.closed) {
        tab = null;
        return;
      }
      let href = '';
      try {
        href = reserved.location.href || '';
      } catch {
        return;
      }
      if (href && href !== 'about:blank') return;
      try {
        reserved.close();
      } catch {
        // Already gone.
      }
      tab = null;
    },

    reset() {
      tab = null;
      opened = false;
    },
  };
}

export const whatsappOpener = createWhatsAppOpener();
