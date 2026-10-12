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

## Zoho Books expenses

The only Zoho call is creating an expense from an approved fuel receipt, supplier receipt, supplier invoice, or expense receipt. Approving a document does not send it. Purchase orders, work orders, and unknown documents cannot be sent. Invoices, bills, contacts, and bank transactions are not implemented. Payment confirmation still updates this app only.

The document preview stays simulated. `server/src/services/accounting/` does not call Zoho.

Set these in `.env`. Use placeholders in git, never real values. `ZOHO_DC` must match the Zoho site: `books.zoho.com` uses `com`, `books.zoho.in` uses `in`, and the same pattern applies to eu, au, jp, ca, sa, and ae. Copy the organization id from Zoho Books (Manage Organizations). The Zoho organization must use Indonesian rupiah, because the amount sent is a whole number of rupiah.

Expense accounts are saved on Overview, one row per Zoho account. A petrol account matches the car number on the fuel receipt, including a Zoho name such as `PETROL DK 8094 HF`. Freelance and supplier accounts match the supplier or description. The payment method picks the paid-through account, and `default` is used when the method is blank or not listed. Copy each numeric id from the Zoho chart of accounts. This app does not look them up. If the car or name matches more than one account, or none, the accountant chooses the account on that receipt before it can be sent.

The Zoho client is a Server-based Application. Homepage URL `http://localhost:4000`. Authorized redirect URI `http://localhost:4000/auth/zoho/callback`.

Restart the API after editing `.env`. Sign in as an admin, open Overview, and choose Connect Zoho. The consent screen asks only for `ZohoBooks.expenses.CREATE`. Connecting does not turn export on. Choose Turn expense export on when you want accountants to send. While that switch is off, the send route refuses and nothing is posted.

An accountant then opens an approved receipt and chooses Send expense to Zoho. The supplier name is the description, the confirmed date is the expense date, and the confirmed total is the amount. The original JPEG, PNG, or PDF is attached on that same request. WebP is created without a file. The Zoho expense id is stored on the document. A second click does not post again.

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
