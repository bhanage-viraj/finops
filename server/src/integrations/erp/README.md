# ERP integration

`zohoBooks.js` is the only file that calls Zoho. It can:

- refresh an OAuth token
- create one expense (`POST /books/v3/expenses`)
- list overdue invoices (`GET /books/v3/invoices?status=overdue`)
- download one invoice PDF (`GET /books/v3/invoices/{id}?accept=pdf`)

It does not update or delete invoices, and it does not call bills, contacts, bank transactions, or organizations.

OAuth scope: `ZohoBooks.expenses.CREATE,ZohoBooks.invoices.READ`. After changing scope, Connect Zoho again from the overview so the refresh token includes invoice read.

Other files must not be added here unless a later phase explicitly starts them.
