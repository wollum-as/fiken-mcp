import { createJournalEntry } from "./create-journal-entry.ts";
import { createUploadLink } from "./create-upload-link.ts";
import { creditInvoice } from "./credit-invoice.ts";
import { deleteDraft } from "./delete-draft.ts";
import { exploreApi } from "./explore-api.ts";
import { findAccounts } from "./find-accounts.ts";
import { findContacts } from "./find-contacts.ts";
import { findInbox } from "./find-inbox.ts";
import { findInvoices } from "./find-invoices.ts";
import { findJournalEntries } from "./find-journal-entries.ts";
import { findProducts } from "./find-products.ts";
import { findPurchases } from "./find-purchases.ts";
import { findSales } from "./find-sales.ts";
import { finalizeDraft } from "./finalize-draft.ts";
import { getReport } from "./get-report.ts";
import { listCompanies } from "./list-companies.ts";
import { readApi } from "./read-api.ts";
import { readFile } from "./read-file.ts";
import { registerPayment } from "./register-payment.ts";
import { saveContact } from "./save-contact.ts";
import { saveInvoiceDraft } from "./save-invoice-draft.ts";
import { saveProduct } from "./save-product.ts";
import { savePurchaseDraft, saveSaleDraft } from "./save-sale-purchase-draft.ts";
import { sendDocument } from "./send-document.ts";
import type { ToolDefinition } from "./tool.ts";

export const TOOLS: readonly ToolDefinition[] = [
  listCompanies,
  findContacts,
  findProducts,
  findInvoices,
  findSales,
  findPurchases,
  findAccounts,
  findJournalEntries,
  findInbox,
  readFile,
  getReport,
  exploreApi,
  readApi,
  saveContact,
  saveProduct,
  saveInvoiceDraft,
  savePurchaseDraft,
  saveSaleDraft,
  createUploadLink,
  finalizeDraft,
  deleteDraft,
  registerPayment,
  createJournalEntry,
  creditInvoice,
  sendDocument,
];
