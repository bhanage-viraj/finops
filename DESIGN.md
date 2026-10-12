# FinOps: Design Guide

How the app should look and behave. Follow this when building any screen. The visual mockups (overview dashboard, scan receipt, collection follow-up, payment matching) are the reference.

## 1. Principles

1. **Fast for the person holding a phone.** Scanning is one-handed, outdoors, on weak signal.
2. **Show what the AI is unsure about.** Never hide uncertainty. Highlight low-confidence fields.
3. **A person always decides.** Buttons say "Submit for approval" or "Approve", never silently finish.
4. **Calm and plain.** Neutral background, one accent color. Warm colors only for warnings and problems.
5. **Same pattern everywhere.** Status badges, confidence badges, tables and buttons look and behave the same on every screen.

## 2. Color tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#F5F7F6` | Page background |
| `--surface` | `#FFFFFF` | Cards, tables, inputs |
| `--ink` | `#16201D` | Main text |
| `--muted` | `#4F5B57` | Labels, helper text |
| `--border` | `#E1E5E3` | Card and table borders |
| `--border-input` | `#CBD2CF` | Input borders |
| `--accent` | `#0F5C5C` | Primary buttons, active nav, links |
| `--accent-soft` | `#DCEBEA` | Active nav background, selected row |
| `--ok-bg` / `--ok-ink` | `#DDF1E8` / `#14573B` | Success, matched, verified |
| `--warn-bg` / `--warn-ink` | `#FBE9C6` / `#6B4400` | Needs attention, low confidence, partial |
| `--bad-bg` / `--bad-ink` | `#F8DAD3` / `#8A2411` | Problem, overdue, unmatched, duplicate |
| `--neutral-bg` / `--neutral-ink` | `#E6EAE8` / `#34403C` | Pending, not contacted |

Rules:

- Color never carries meaning alone. Every colored badge also has a text label.
- Keep text contrast readable on every background above.
- Dark mode is not part of Phase 1.

## 3. Typography

- Font: **Public Sans**, with `Arial, sans-serif` as fallback.
- Page title 22 to 24px, weight 700.
- Section title 16px, weight 700.
- Body 14px. Table text 13px. Helper text 13px in `--muted`.
- Small label 11px, uppercase, letter-spacing 0.04em, weight 600, `--muted`.
- Big number on summary cards: 28px, weight 700.
- Numbers in tables are right-aligned. Format money as `Rp 1.200.000` in message text and `1,200,000` in tables (pick one and use it consistently across the UI; the default is thousands separators with a dot for Indonesian text).

## 4. Spacing, shape, layout

- Spacing scale: 4, 8, 12, 16, 20, 24, 32.
- Cards: white, 1px `--border`, radius 10px, padding 16 to 20px.
- Inputs and buttons: radius 8px.
- Pills (badges, chips): fully rounded.
- Desktop layout: left sidebar 200px (white, right border), content area with 24px padding, max content width about 1360px.
- Phone layout: single column, no sidebar, app bar on top in `--accent` with white title.
- Grids collapse to one column below about 700px. Wide tables scroll sideways inside their own container, never the whole page.

## 5. Components

**Button**
- Height at least 44px on every device.
- Primary: `--accent` fill, white text. Secondary: white fill, 1px `--accent` border, accent text.
- One primary button per screen area.
- Destructive actions (reject, delete) use a confirmation step.

**Status badge**
- Pill, 12px, weight 600, colored per section 2. Examples: Matched (ok), Partial (warn), Unmatched (bad), Pending (neutral).

**Confidence badge**
- Shows a percent or High, Medium, Low. 90% and above ok, 70 to 89% warn, below 70% bad.
- A field with warn or bad confidence also gets a tinted background and a one-line hint ("Could also read as 480,000. Please confirm.").

**Field row (review screens)**
- Small uppercase label above, input, confidence badge on the right.

**Tables**
- Header row 11px uppercase muted. Row padding 10px 8px. Subtext (invoice number, history) under the main text in `--muted`.
- Selected row uses `--accent-soft`.

**Chips (filters, message types)**
- Pill with border. Selected: `--accent` fill and white text.

**Checkboxes in tables**
- 20px square. Checked: `--accent` fill with a white tick.

**Empty states**
- One sentence and one button. Example: "No receipts waiting. Scan your first receipt."

**Loading and errors**
- Show progress for uploads. Show plain-language errors ("The photo did not upload. We will try again when the signal returns.").

## 6. Screens

### 6.1 Scan receipt (phone first)

- App bar: "Scan receipt".
- Camera area with a dashed guide frame and a "Photo OK" or "Retake: too blurry" chip.
- Helper line: "Lay the receipt flat, in good light, and fit all of it in the frame."
- Row: Retake, shutter button (64px ring), Gallery.
- Card "Read from receipt": Vendor, Date, Total, Category, each with a confidence badge. Warn fields are tinted with a hint.
- "No duplicate found" or "Possible duplicate" badge.
- Primary button: "Submit for approval". Footer line: who approves it.

### 6.2 Receipt review queue (accountant, desktop)

- Table of submitted receipts with vendor, total, uploader, confidence summary, status.
- Opening a row shows the photo beside the fields. Actions: Approve, Reject (reason required), Send back.

### 6.3 Payment matching (desktop)

- Header: title, "Approve selected (n)" primary button.
- Dashed upload zone with thumbnails of screenshots read.
- "Suggested matches" table: checkbox, from screenshot (sender, amount, time), matched invoice, confidence, bank statement status, result badge.
- "Needs your review" card for duplicates and unmatched items, each with an action button.
- Rule shown on screen: nothing is marked paid until the statement is checked and an accountant approves.

### 6.4 Collection follow-up (desktop)

- Filter chips: All, Overdue, Due soon, Promised.
- Left: ranked table (customer and invoice, outstanding, overdue, status).
- Right: selected customer panel with stats, message-type chips, editable draft text, Copy, Open WhatsApp, Mark as contacted.
- Note under the draft: "Draft by AI. Edit freely before sending."

### 6.5 Export screen

- List of approved, not-yet-exported entries with a count and total.
- One button "Download ERP import file". Shows a warning when the kill switch is off.
- History of past export batches.

### 6.6 Overview dashboard (later)

- Four summary cards: sales today, cash deposit gap, receivables outstanding, payables due.
- Panels in order of action: reconciliation, exceptions, follow-up, aging, bank matching, payables, monthly summary.

### 6.7 Admin

- Users and roles, expense categories (with ERP codes), settings (confidence thresholds, kill switch).

## 7. Interaction rules

- Every AI-filled value can be edited before submission.
- A corrected value keeps the original AI value in the record, shown on the accountant's review screen when different.
- Approve and reject actions record the user and time.
- Unsaved changes warn before leaving a screen.
- Uploads continue in the background and resume when the signal returns.

## 8. Accessibility

- Touch targets at least 44px.
- Labels on every input, not placeholder-only.
- Visible focus outline on every interactive element.
- Do not rely on color alone.
- Support browser zoom to 200% without horizontal scrolling of the page body.

## 9. Content and tone

- Short, plain, direct. "Submit for approval", not "Proceed to next step".
- Say what happens next ("The accountant approves it. The photo is saved with the entry.").
- Indonesian message drafts: polite and brief, greeting by name, invoice number, amount, due date, a clear request, thanks.
