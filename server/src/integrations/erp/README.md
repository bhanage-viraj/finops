# ERP integration

`zohoBooks.js` is the only file that calls Zoho. It can:

- refresh an OAuth token
- create one expense (`POST /books/v3/expenses`)
- list overdue invoices (`GET /books/v3/invoices?status=overdue`) for Follow-up
- list unpaid invoices (`GET /books/v3/invoices?status=unpaid`) for Payments matching
- download one invoice PDF (`GET /books/v3/invoices/{id}?accept=pdf`)
- create a customer payment (`POST /books/v3/customerpayments`) for Payments approve

It does not update or delete invoices directly, and it does not call bills, contacts, or organizations.

OAuth scope: `ZohoBooks.expenses.CREATE,ZohoBooks.invoices.READ,ZohoBooks.customerpayments.CREATE`. After changing scope, Connect Zoho again from the overview.

Payments is separate from Documents (expenses) and Follow-up (reminders). Set `ZOHO_PAYMENT_DEPOSIT_ACCOUNT_ID` for the deposit bank account used when recording payments.

Other files must not be added here unless a later phase explicitly starts them.
