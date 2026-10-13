# FinOps

Internal finance app for a small water-distribution business. People upload receipts, invoices, work orders and purchase orders. A vision model drafts a type and fields. A person reviews, corrects and approves. Nothing is sent to an accounting system.

## Requirements

- Node.js 22 or newer (Active LTS is Node.js 24)
- Docker Desktop, running, with `docker compose`

## Run from a fresh clone

```bash
cp .env.example .env
# Edit .env and replace JWT_SECRET. Leave the SEED_* passwords blank to print them once.

docker compose up -d

cd server
npm install
npm test
npm run seed
npm run dev
```

In a second terminal:

```bash
cd client
npm install
npm run dev
```

- API: http://localhost:4000/health
- Website: http://localhost:5173

`GET /health` returns `"status": "ok"` and `"database": "connected"` when MongoDB is up.

Sign in with a seeded user, upload a JPEG, PNG, WebP or PDF, then open it from Documents. Fuel, work orders, supplier receipts, invoices, purchase orders and other expenses each keep their own fields. Approval is blocked while a required field or a critical check is unresolved. Purchase orders and work orders can be approved without becoming an expense.

Set `AI_PROVIDER`, `AI_API_KEY` and `AI_MODEL` in `.env`. The checked default model is `gemini-2.5-flash`. A newer model name can be set when it answers reliably. The only network call to a model is in `server/src/services/ai/visionClient.js`. Without a key, the file is still saved and the document is marked failed so you can retry. A busy model is retried twice before the document is marked failed.

A sample you can photograph or upload is generated with `node scripts/makeSampleImages.js` from `server/` after dependencies are installed. The pictures are invented. They are not measured accuracy scores.

## Payment reconciliation

Open Payments at http://localhost:5173/payments. Upload a bank screenshot. The model reads the recipient, the transfer amount and the transaction date, then compares them with open sample invoices and approved expenses. A unique match stays a proposal. An accountant ticks the bank statement check and confirms before that record is marked paid. Pending, failed, uncertain and duplicate screenshots do not change other records. Confirmation updates this application only. Zoho Books is not called.

Sample invoices, including three open PT Tigris Inovatif Solusi amounts, are fixtures loaded by `npm run seed`. They are not extracted from a screenshot in advance.

## Zoho Books

Two Zoho calls are allowed:

1. **Create expense** from an approved fuel receipt, supplier receipt, supplier invoice, or expense receipt (with photo). Approving does not send. Purchase orders and work orders are not sent.
2. **Read overdue invoices** for the Follow-up page (`GET` invoices with status overdue only). FinOps does not write, update, or delete invoices.

Bills, contacts, bank transactions, and other Zoho modules are not called.

Set these in `.env`. Use placeholders in git, never real values. `ZOHO_DC` must match the Zoho site: `books.zoho.com` uses `com`, `books.zoho.in` uses `in`, and the same pattern applies to eu, au, jp, ca, sa, and ae. Copy the organization id from Zoho Books (Manage Organizations). The Zoho organization must use Indonesian rupiah.

The Zoho client is a Server-based Application. Production homepage `https://finops-jaan.onrender.com`. Authorized redirect URI `https://finops-jaan.onrender.com/auth/zoho/callback`.

Sign in as an admin, open Overview, and choose **Connect Zoho**. The consent screen asks for `ZohoBooks.expenses.CREATE` and `ZohoBooks.invoices.READ`. After any scope change, connect again. Connecting does not turn export on. Choose **Turn expense export on** when you want Send expense and Follow-up to work. While that switch is off, those routes refuse.

**Follow-up** lists overdue invoices from Zoho, grouped by due date (oldest due date first; within a day, larger balance first). Open a row to edit a WhatsApp reminder, then **Share on WhatsApp** (pulls the invoice PDF from Zoho and attaches it when the phone allows) or Download PDF. Staff send the message themselves. Nothing is written back to Zoho.

An accountant opens an approved receipt and chooses Send expense and photo to Zoho. The Zoho expense id is stored on the document. A second click does not post again.

## Scripts

From `server/`:

- `npm run dev` starts the API with auto-reload
- `npm start` starts the API once
- `npm test` runs validation, upload, approval, accounting-mock, and Zoho expense tests
- `npm run seed` creates the staff, accountant, and admin users, sample categories, and one settings document (`erpFeaturesEnabled` is false)

From `client/`:

- `npm run dev` starts the website
- `npm run build` writes the production build to `client/dist`

## Safety

- Do not commit `.env`, `uploads/`, or anything under `samples/real/`.
- Files in `samples/` are invented. Do not add real receipts, screenshots, customer names, or bank details.
- `server/src/integrations/erp/zohoBooks.js` is the only Zoho caller, and it only creates an expense.
- The seed passwords are test passwords. If they were left blank, the seed prints them once in that terminal.
