# FinOps: Architecture

## 1. Overview

One web app and one backend, running beside the ERP, not inside it. Phones and computers open the same website. Everything is stored in the app's own MongoDB database. The ERP is represented only by files.

```
Phone / Computer (React website)
        |  HTTPS
        v
Express API  ---->  MongoDB (data, audit log)
   |   |
   |   +----------> S3-compatible storage (photos, screenshots)
   |
   +--------------> AI vision model (server only, via visionClient.js)

ERP  --(CSV files, by hand)-->  Imports
ERP  <--(CSV file, by hand)--   Export (approved receipts)
```

No arrow goes to or from the ERP automatically in Phase 1.

Deliveries add an optional Cartrack Fleet API arrow (status and optional job create) behind `settings.cartrackEnabled`. Sheet upload/export stays in FinOps MongoDB and does not use the ERP kill switch.

## 2. Folder structure

```
finops/
├─ README.md
├─ CLAUDE.md
├─ PRD.md
├─ DESIGN.md
├─ ARCHITECTURE.md
├─ .env.example
├─ docker-compose.yml
├─ client/
│  ├─ public/ (manifest.json, icons/)
│  └─ src/
│     ├─ api/ (client.js, auth.js, receipts.js, payments.js, collections.js)
│     ├─ auth/ (AuthContext.jsx, ProtectedRoute.jsx)
│     ├─ components/ (Layout, Sidebar, StatusBadge, ConfidenceBadge, FieldRow, UploadDropzone)
│     ├─ pages/
│     │  ├─ Login.jsx, Dashboard.jsx
│     │  ├─ receipts/ (ScanReceipt, ReceiptReview, ReceiptQueue)
│     │  ├─ payments/ (UploadScreenshots, MatchResults, ExceptionList)
│     │  ├─ collections/ (FollowUpList, MessageDraft)
│     │  ├─ export/ (ExportScreen)
│     │  └─ admin/ (Users, Categories, Settings)
│     ├─ hooks/ (useUploadQueue.js)
│     ├─ utils/ (compressImage.js, formatRupiah.js)
│     └─ styles/
├─ server/
│  ├─ src/
│  │  ├─ index.js, app.js
│  │  ├─ config/ (env.js, db.js)
│  │  ├─ models/ (User, Receipt, Category, Customer, Invoice, BankPayment,
│  │  │           FollowUp, MessageTemplate, ExportBatch, AuditLog, Setting)
│  │  ├─ routes/ (auth, receipts, payments, collections, imports, exports, admin)
│  │  ├─ controllers/
│  │  ├─ services/
│  │  │  ├─ ai/ (visionClient, qualityCheck, receiptReader, paymentReader, messageDrafter)
│  │  │  ├─ matching/ (matcher, rules)
│  │  │  ├─ ranking/ (followUpRanker)
│  │  │  ├─ imports/ (csvImporter)
│  │  │  ├─ export/ (erpExportFile)
│  │  │  ├─ storage/ (fileStorage)
│  │  │  └─ audit/ (auditLogger)
│  │  ├─ middleware/ (auth, requireRole, upload, killSwitch, errorHandler)
│  │  ├─ prompts/ (receipt.prompt.txt, payment.prompt.txt, message.prompt.txt)
│  │  ├─ jobs/ (dailyFollowUpList.js)
│  │  ├─ integrations/erp/zohoBooks.js (create expense only)
│  │  └─ utils/
│  └─ tests/
├─ samples/ (receipts, screenshots, erp-exports)
├─ scripts/ (seed.js, backup.sh)
└─ docs/ (erp-notes.md, plan.md)
```

## 3. Data model (MongoDB)

All money fields are integer rupiah. All documents have `createdAt` and `updatedAt`.

**users**
- name, email (unique), passwordHash, role (`staff` | `accountant` | `admin`), active

**categories**
- name, erpCode, active

**receipts**
- uploadedBy (user), imageKey, status (`draft` | `submitted` | `approved` | `rejected` | `exported`)
- ai: { vendor, date, total, tax, category, confidence: { vendor, date, total, tax, category }, quality: { ok, issue }, model, readAt }
- confirmed: { vendor, date, total, tax, categoryId }
- duplicateOf (receipt id or null)
- approvedBy, approvedAt, rejectReason
- exportBatchId

**customers**
- name, aliases [string], erpCustomerId, paymentTermsDays, deliveryFeeRule, phone

**invoices** (copied from ERP exports)
- invoiceNo (unique), customerId, amount, paidAmount, issueDate, dueDate, status (`open` | `partial` | `paid`), importedAt

**bankPayments**
- uploadedBy, imageKey, status (`read` | `matched` | `verified` | `approved` | `rejected`)
- ai: { sender, amount, paidAt, reference, confidence, model, readAt }
- matchedInvoiceId, matchType (`exact` | `partial` | `over` | `none`), matchConfidence (`high` | `medium` | `low`)
- flags [`possibleDuplicate`, `unidentified`]
- statementVerified (bool), verifiedBy, verifiedAt
- approvedBy, approvedAt, overpaymentReason

**followUps**
- customerId, invoiceIds [ ], priorityScore, messageType (`upcoming` | `overdue` | `partial` | `plan`)
- draftText, finalText, contactedBy, contactedAt
- outcome (`none` | `contacted` | `promised` | `paid`), promisedDate

**messageTemplates**
- type, language, text

**exportBatches**
- createdBy, receiptIds [ ], count, totalAmount, filename, createdAt

**auditLogs**
- userId, action, entity, entityId, before, after, at

**settings**
- erpFeaturesEnabled (bool), cartrackEnabled (bool), confidenceThresholds: { warn, bad }, duplicateWindowDays

**deliveryCustomers / areas / vehicles / drivers / products / deliveryDays / deliveryRoutes / deliveryStops**
- Delivery operations models. Stops keep `ai` and `confirmed` separate for nota reading. Money is integer rupiah.

### Indexes

- `users.email` unique
- `invoices.invoiceNo` unique
- `receipts`: `status`, `uploadedBy`, and a compound on `confirmed.vendor`, `confirmed.date`, `confirmed.total` for duplicate checks
- `bankPayments`: `status`, `ai.amount`, `ai.paidAt`
- `followUps`: `customerId`, `outcome`
- `auditLogs`: `entity` + `entityId`, `at`

## 4. API (first version)

All routes require login except `/auth/login`. Role in brackets.

**Auth**
- `POST /auth/login`
- `GET /auth/me`

**Receipts**
- `POST /receipts` upload an image, run quality check and AI reading, save draft [staff, accountant]
- `GET /receipts?status=` list [staff: own, accountant: all]
- `GET /receipts/:id`
- `PATCH /receipts/:id` update confirmed fields [staff: own drafts, accountant]
- `POST /receipts/:id/submit` [staff]
- `POST /receipts/:id/approve` [accountant]
- `POST /receipts/:id/reject` body: reason [accountant]

**Payments**
- `POST /payments` upload screenshot, AI reading, matching [staff, accountant]
- `GET /payments?status=`
- `PATCH /payments/:id/match` change the matched invoice [accountant]
- `POST /payments/:id/verify` statement check ticked [accountant]
- `POST /payments/:id/approve` requires verified [accountant]

**Collections**
- `GET /collections/today` ranked list [accountant]
- `POST /collections/:customerId/draft` generate a message draft [accountant]
- `POST /collections/:customerId/contact` save final text and status [accountant]

**Imports** (blocked by kill switch)
- `POST /imports/invoices`, `POST /imports/customers`, `POST /imports/categories` CSV upload [accountant, admin]

**Exports** (blocked by kill switch)
- `GET /exports/receipts/preview` approved, not yet exported
- `POST /exports/receipts` create batch and download file, marks entries exported [accountant]
- `GET /exports/batches`

**Admin**
- `GET/POST/PATCH /admin/users`, `/admin/categories`, `/admin/settings` [admin]

**Deliveries** [delivery, accountant, admin]
- `POST /deliveries/import`, `POST /deliveries/import-history`
- `GET /deliveries`, `GET /deliveries/:dayId`, routes/stops/status/location/message/export/report
- `POST /deliveries/routes/:id/cartrack/send` and sync (blocked when `cartrackEnabled` is off)
- `POST /deliveries/stops/:id/nota` (AI draft only until confirm)

## 5. Key flows

### Receipt
1. Phone uploads a compressed image (retry queue if offline).
2. Server stores the file, runs the quality check. If poor, returns a retake message and saves nothing as a draft.
3. Server calls the AI reader. Validates the strict JSON result. Saves `receipts.ai` and a draft record.
4. Staff review and confirm fields (`confirmed`), then submit. Duplicate check runs.
5. Accountant approves or rejects. Approval is audited.
6. Export builds a CSV of approved, not-yet-exported receipts, marks them exported in the same operation, and saves a batch record.

### Bank payment
1. Upload screenshot, AI reads sender, amount, time, reference.
2. Matcher searches open invoices: customer name similarity (including aliases), exact amount, date window. Returns match type and confidence.
3. Possible duplicate: same amount and sender within a short window of an earlier payment.
4. Accountant checks the bank statement and ticks "verified".
5. Accountant approves. Invoice paid amount is updated in this app only. The accountant records it in the ERP by hand.

### Follow-up
1. Daily job (or on demand) ranks open invoices: overdue days, balance, history.
2. Accountant opens a customer, picks a message type, AI drafts text, accountant edits and sends through WhatsApp.
3. Status is stored. A verified payment updates the status to paid.

## 6. Matching rules (starting point)

- Normalize names: uppercase, remove titles and punctuation, compare with customer name and aliases.
- High: strong name match and exact amount equal to one open invoice.
- Medium: strong name match and amount equal to a sum of invoices or a partial amount; or exact amount with a weak name match.
- Low or none: anything else.
- Never auto-link a low or none result.
- Overpayment: amount above the invoice. Needs a reason and approval.
- Learn aliases: when an accountant assigns an unmatched sender to a customer, offer to save the sender name as an alias.

## 7. Ranking rules (starting point)

Priority score combines: days overdue (largest weight), outstanding balance, payment history (late payers rank higher), and whether a promise date has passed. Customers with a promise date in the future are held back until that date. The weights live in settings so the accountant can adjust them.

## 8. AI service design

- One client file: `visionClient.js`. Inputs: image, prompt name, expected schema. Output: validated JSON or an error.
- Prompts in `server/src/prompts/`. Strict JSON output only.
- Reject and retry once on invalid JSON. After that, save the record with an "AI could not read" flag and let a person enter the values.
- Log the model name, prompt version and time on every AI result.
- Never send more data than needed. Do not include customer lists in receipt reading requests.

## 9. Environments

- **local:** docker compose MongoDB, fake data from `samples/` and `seed.js`.
- **test:** hosted copy with its own database and storage, used for pilots and ERP test-copy imports.
- **live:** separate database, storage and keys. Nothing from test is shared with live.

## 10. Security

- Passwords hashed with a strong algorithm (bcrypt or argon2).
- Short-lived access tokens, role claims verified on the server for every request.
- File uploads limited by type and size. Files stored with random keys.
- Images served through short-lived signed links, not public URLs.
- Rate limits on login and upload.
- HTTPS everywhere. Secrets only in environment variables.
- Backups on a schedule. Restore tested before wider use.

## 11. Build order

M0 setup → M1 login and layout → M2 receipt upload → M3 AI reading → M4 review and approval → M5 pilot → M6 export → M7 bank matching → M8 follow-up → M9 hardening. Phase 5 (ERP link) only after a clean month and with a test copy.
