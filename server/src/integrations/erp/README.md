# ERP integration

`zohoBooks.js` is the only file that calls Zoho. It can:

- refresh an OAuth token
- create one expense (`POST /books/v3/expenses`)
- list overdue invoices (`GET /books/v3/invoices?status=overdue`) for Follow-up
- list unpaid invoices (`GET /books/v3/invoices?status=unpaid`) for Payments matching
- list unpaid invoices in a date range (`date_start` and `date_end` on that same invoices URL) for the receivable summary PDF
- read every unpaid invoice into the stored copy in MongoDB (`zohoInvoices`), using that same invoices URL with `status`, `customer_id`, `date_start`, `date_end` or `last_modified_time`. A full read runs each night at 02:00 Bali time, changed invoices are read every 2 minutes, and one customer is read again when a payment for that customer is opened. Zoho stays the source of truth; the copy is read-only.
- download one invoice PDF (`GET /books/v3/invoices/{id}?accept=pdf`)
- create a customer payment (`POST /books/v3/customerpayments`) for Payments approve

It does not update or delete invoices directly, and it does not call bills, contacts, organizations, or Zoho's reports. The receivable summary PDF is built in the app from unpaid invoices. Credit notes are not included.

OAuth scope: `ZohoBooks.expenses.CREATE,ZohoBooks.invoices.READ,ZohoBooks.customerpayments.CREATE`. After changing scope, Connect Zoho again from the overview.

Payments is separate from Documents (expenses) and Follow-up (reminders). Set `ZOHO_PAYMENT_DEPOSIT_ACCOUNT_ID` for the deposit bank account used when recording payments.

Other files must not be added here unless a later phase explicitly starts them.
