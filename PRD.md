# FinOps: Product Requirements Document

Version 0.1 · Phase 1 · Status: draft for review

## 1. Summary

FinOps is an internal web app that reduces manual accounting work for a water-distribution business (gallons, bottles, cans). In Phase 1 it automates three things: reading expense receipts from photos, matching bank transfer screenshots to invoices, and preparing daily customer collection follow-ups. AI prepares drafts and suggestions. A person always approves. The app never connects to the ERP in Phase 1.

## 2. Problem

- Expense receipts are photographed, sent through WhatsApp, downloaded and re-uploaded, then typed into the ERP by hand.
- Bank transfer proofs are checked one by one against internet banking and matched to invoices manually.
- Collection follow-up depends on someone remembering which customers to contact and what to say.
- Errors (wrong amounts, duplicates, missed follow-ups) are found late.

## 3. Goals

1. Cut the time from receipt photo to approved entry.
2. Cut the time to match a bank payment to the right invoice.
3. Give the collector a ranked daily list with ready-to-edit messages.
4. Keep every action traceable (who did what, when, what the AI read).
5. Protect the ERP: no automatic changes, tested exports only.

## 4. Non-goals (Phase 1)

- Any live connection to, login to, or write access to the ERP.
- Automatic posting, approval, payment marking or message sending.
- A native phone app.
- Driver sales collection and invoice entry (documented in the process map, planned later).
- Accounts payable workflows beyond expense receipts.
- Customer-facing screens.
- Full financial reporting. The overview dashboard comes after the three workflows are stable.

## 5. Users and roles

| Role | Who | Can do |
|---|---|---|
| Staff | Drivers, admin staff | Upload receipts and screenshots, confirm what the AI read |
| Accountant | Finance/accounting | Approve or reject, verify payments, export, handle exceptions, send follow-ups |
| Admin | Owner or manager | Manage users, categories, settings, the kill switch |

## 6. Workflow A: Expense receipts

**Story:** As staff, I photograph a receipt on my phone so that I do not have to send it on WhatsApp and re-enter it.

Requirements:

- A1. Upload from phone camera or gallery, and from desktop.
- A2. Compress large photos before upload. Retry automatically when the signal is weak. Show a clear "saved" confirmation.
- A3. Quality check immediately after capture (blur, cut-off edges, glare). If poor, ask for a retake at once.
- A4. AI extracts vendor, date, total, tax and suggests a category, each with a confidence score.
- A5. Save AI output as a draft. The AI output is never overwritten.
- A6. Review screen shows the photo beside the fields. Low-confidence fields are highlighted. Staff confirm or correct.
- A7. Duplicate check on vendor, date and total.
- A8. Accountant queue: approve, reject with reason, or send back.
- A9. Export screen produces a file of approved, not-yet-exported entries in the ERP's import format. Exported entries are marked and cannot be exported twice.

Acceptance:

- A full receipt can travel from phone photo to approved with every change in the audit log.
- Total errors by the AI are flagged by the confidence warning in the pilot test set.
- The export file imports correctly into a test copy of the ERP three times in a row before any live import.

## 7. Workflow B: Bank payment matching

**Story:** As an accountant, I upload transfer screenshots and see which invoice each belongs to, so that I only handle the exceptions.

Requirements:

- B1. Upload ERP exports for open invoices and customers (files, no connection).
- B2. Upload one or more bank screenshots (paste or drag and drop on desktop, camera or gallery on phone).
- B3. AI extracts sender, amount, date and time, and reference.
- B4. Matching suggests customer and invoice using name similarity (including saved aliases), exact amount, open invoices and a date window. Show a confidence level.
- B5. Result types: exact match, partial, overpayment, no match, possible duplicate.
- B6. Exception list for partial, over, unmatched and duplicate items.
- B7. A payment is "verified" only after a person ticks the bank statement check. A screenshot alone is never proof.
- B8. Accountant approves verified matches. In Phase 1 the accountant then records the payment in the ERP by hand.
- B9. Partial payments leave the invoice open with the remaining balance. Overpayments need authorized approval and a recorded reason.

Acceptance:

- On the sample data, no wrong invoice is ever shown as a high-confidence match.
- Results agree with the manual process over a two-week side-by-side run.

## 8. Workflow C: Collection follow-up

**Story:** As a collector, I open one list each morning that tells me who to contact and what to say.

Requirements:

- C1. Upload the aging export from the ERP.
- C2. Daily list ranked by overdue days, outstanding balance and payment history.
- C3. Message drafts by situation: due soon, overdue, partial payment, agreed payment plan. Drafts are in Indonesian and always editable.
- C4. Copy button and open-in-WhatsApp button. Staff send the message themselves.
- C5. Status per customer: not contacted, contacted, promised date, paid.
- C6. A payment confirmed in Workflow B updates the status automatically.
- C7. Contact history is stored (who, when, final text).

Acceptance:

- A collector agrees the ranked list matches their own judgement on most days.
- Messages need only small edits.

## 9. Rules that apply everywhere

1. AI creates drafts and suggestions only.
2. Nothing is approved, paid or exported without an accountant.
3. No code in Phase 1 connects to the ERP.
4. A kill switch (`erpFeaturesEnabled`) turns off imports and exports.
5. Every important action is written to the audit log.
6. Money is stored as integer rupiah.
7. Real customer data stays out of the code repository.

## 10. Non-functional requirements

- **Devices:** works on current phones and desktop browsers. Phone screens used for scanning, desktop for review.
- **Speed:** upload shows progress. Screens stay usable on weak mobile signal.
- **Security:** login required, roles enforced on the API and screens, HTTPS only, secrets in environment variables, AI keys only on the server.
- **Privacy:** receipts and bank screenshots contain business and personal data. Limit who can see them, and check the AI provider's data handling terms before using real documents.
- **Reliability:** automatic database and file backups. A restore is rehearsed before wider use.
- **Language and formats:** Indonesian and English UI text as needed. Handle `Rp 1.200.000` and `09/10/2026` formats.

## 11. Success measures

To be set after the pilot. Starting targets:

- Vendor and date correct without edits on at least 9 of 10 test receipts.
- Every wrong total flagged by a confidence warning.
- Average handling time per receipt, payment and follow-up lower than the old method (measured in the pilot).
- No duplicate entry reaches the ERP.

## 12. Milestones

- M0 Setup · M1 Login and layout · M2 Receipt upload · M3 AI reading · M4 Review and approval · M5 Receipt pilot
- M6 Export screen · M7 Bank matching · M8 Collection follow-up · M9 Hardening

Details are in the architecture plan document.

## 13. Risks

| Risk | Handling |
|---|---|
| AI misreads a number | Confidence flags, human confirmation, accountant approval |
| Fake or edited screenshots | Bank statement check required before "verified" |
| Duplicate ERP entries | Unique IDs, exported-once marker, duplicate checks |
| Wrong ERP field mapping | Repeated test-copy imports before live |
| Weak mobile signal | Compression and retry queue |
| Staff skip the app | Keep screens short and faster than the old way |
| Privacy of customer data | Roles, limited access, provider terms review |

## 14. Open questions

1. Which ERP and version? Does it import files or offer an API? Is there a test company?
2. Who builds it (in-house, freelancer, tool)?
3. One accountant for all three workflows, or different approvers?
4. How do bank screenshots arrive: customers on WhatsApp, or the team from internet banking?
5. Weekly volume of receipts, payments and follow-ups?
6. Monthly budget range for hosting and AI usage?
7. Which AI provider will be used?
