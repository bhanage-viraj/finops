# CLAUDE.md

Instructions for working in this repository. Read this file first, then `PRD.md`, `DESIGN.md` and `ARCHITECTURE.md`.

## Project

FinOps is an internal finance automation web app for a small water-distribution business in Indonesia. Phase 1 has three workflows: expense receipt scanning, bank payment matching from screenshots, and collection follow-up. AI prepares drafts. A person approves. **The app never connects to the ERP in Phase 1.**

## Stack

- Frontend: React + Vite (JavaScript), responsive, installable as a PWA.
- Backend: Node.js + Express (JavaScript).
- Database: MongoDB with Mongoose.
- Files: S3-compatible storage. MongoDB stores only the file key.
- AI: vision-capable model, called only from the backend through `server/src/services/ai/visionClient.js`.

## Commands

These scripts should exist in the package.json files. Add them if missing.

```
# local database
docker compose up -d

# server (from /server)
npm install
npm run dev        # start with auto-reload
npm test           # run tests
npm run seed       # create test users and categories

# client (from /client)
npm install
npm run dev        # start the website locally
npm run build
```

## Hard rules (never break these)

1. **No ERP connection.** Do not write code that logs in to, calls, or writes to any ERP. `server/src/integrations/erp/` stays empty (README only) until Phase 5 is explicitly started by the user.
2. **AI creates drafts only.** Nothing is automatically approved, marked paid, exported or sent.
3. **Bank screenshot is not proof.** A payment becomes "verified" only after a person ticks the bank statement check.
4. **Export once.** Exports include only approved, not-yet-exported receipts, and mark them exported in the same operation.
5. **Kill switch.** All import and export routes must check `settings.erpFeaturesEnabled` and refuse when it is off.
6. **Keep AI and human values separate.** Store AI output in `ai`, never overwrite it. Store the person's values in `confirmed`.
7. **Audit everything important.** Create, submit, approve, reject, verify, export, import, role change, setting change: each writes an `auditLogs` entry through `auditLogger`.
8. **Money is integer rupiah.** No floats for money anywhere.
9. **Secrets stay out of git.** Use `.env`. Keep `.env.example` up to date. Never commit real receipts, screenshots, customer names or bank details. Use `samples/` with fake data only.
10. **AI calls go through one file.** Only `visionClient.js` talks to the AI provider. The API key is server-side only.

## Conventions

- Plain JavaScript, ES modules, async/await. Small files, small functions, short comments explaining why.
- One route file and one controller per area. Routes stay thin, logic lives in `services/`.
- Validate all request input and all AI output (strict JSON schema) before saving.
- Role checks on every protected route with `requireRole`, and in the UI with `ProtectedRoute`.
- Errors: return clear messages, never stack traces, to the client. Log details on the server.
- Names: files `camelCase.js` for logic, `PascalCase.jsx` for React components, routes `*.routes.js`, models singular `Receipt.js`.
- Dates stored as ISO dates (UTC). Display in Indonesian local format. Parse `09/10/2026` as day/month/year.
- Money display follows `DESIGN.md`. Parse `Rp 1.200.000` into the integer `1200000`.
- UI follows `DESIGN.md` tokens and components. Do not invent new colors or button styles.
- AI prompts live in `server/src/prompts/*.txt`, not inline in code.
- Add a dependency only when it clearly saves work, and say why.

## How to work

1. Work one milestone at a time (M0 to M9 in `PRD.md`). Do not start a later milestone unless asked.
2. Before coding a milestone, list the files you will create or change and any questions. Wait for confirmation if anything is unclear about money, dates, roles or the ERP.
3. After coding, say how to run and test it, and what to check by hand on a real phone.
4. Write tests for logic that can lose or corrupt money or data: AI output validation, duplicate check, matching rules, export file, role checks.
5. Do not refactor unrelated code while doing a task.
6. If a request conflicts with a hard rule above, stop and explain instead of doing it.

## Testing

- Unit tests with the Node test runner or Jest in `server/tests/`.
- Use sample data from `samples/` (fake). Include awkward cases: blurry text, handwritten totals, Rp formats with dots, two payments within minutes, partial and over payments.
- Matching tests must prove that no wrong invoice is ever returned as high confidence on the sample set.
- Export tests must prove a receipt cannot be exported twice.

## Where things are

```
client/src/pages/receipts|payments|collections|export|admin
server/src/models        Mongoose schemas
server/src/services/ai   the only place that calls the AI
server/src/services/matching, ranking, imports, export, storage, audit
server/src/middleware    auth, requireRole, killSwitch, upload, errorHandler
server/src/prompts       AI prompt text files
samples/                 fake test data only
docs/erp-notes.md        ERP import format and field mapping (fill in Phase 0)
```

## Definition of done for any task

- It runs locally and the steps to test it are written down.
- Tests for the risky logic pass.
- Roles are enforced.
- Audit entries are written for important actions.
- No secrets, no real data, no ERP calls.
- The screen matches `DESIGN.md`.
