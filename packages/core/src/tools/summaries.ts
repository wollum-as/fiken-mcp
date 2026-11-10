import type { components } from "../fiken/types.gen.ts";
import { compact, kr } from "./common.ts";

/**
 * Compact views of Fiken objects. Fiken's responses embed whole contacts, sales and PDF links, so
 * lists carry only what answers the question, and amounts are converted to kroner.
 */

type S = components["schemas"];

export function counterparty(contact: S["contact"] | undefined) {
  return contact ? compact({ id: contact.contactId, name: contact.name, organizationNumber: contact.organizationNumber }) : undefined;
}

export function contactSummary(contact: S["contact"]) {
  return compact({
    id: contact.contactId,
    name: contact.name,
    organizationNumber: contact.organizationNumber,
    email: contact.email,
    customer: contact.customer,
    supplier: contact.supplier,
    customerNumber: contact.customerNumber,
    supplierNumber: contact.supplierNumber,
    inactive: contact.inactive || undefined,
  });
}

export function contactDetail(contact: S["contact"], persons: S["contactPerson"][]) {
  return compact({
    ...contactSummary(contact),
    phoneNumber: contact.phoneNumber,
    address: contact.address ? compact({ ...contact.address }) : undefined,
    bankAccountNumber: contact.bankAccountNumber,
    customerAccount: contact.customerAccountCode,
    supplierAccount: contact.supplierAccountCode,
    currency: contact.currency,
    language: contact.language,
    daysUntilInvoicingDueDate: contact.daysUntilInvoicingDueDate,
    contactPersons: persons.map((person) =>
      compact({ id: person.contactPersonId, name: person.name, email: person.email, phoneNumber: person.phoneNumber }),
    ),
  });
}

export function productSummary(product: S["product"]) {
  return compact({
    id: product.productId,
    name: product.name,
    productNumber: product.productNumber,
    unitPrice: kr(product.unitPrice),
    vatType: product.vatType,
    incomeAccount: product.incomeAccount,
    active: product.active,
    stock: product.stock,
  });
}

export function invoiceSummary(invoice: S["invoiceResult"]) {
  return compact({
    id: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    customer: counterparty(invoice.customer),
    net: kr(invoice.net),
    vat: kr(invoice.vat),
    gross: kr(invoice.gross),
    currency: invoice.currency === "NOK" ? undefined : invoice.currency,
    settled: invoice.sale?.settled,
    outstanding: kr(invoice.sale?.outstandingBalance),
    creditNotes: invoice.associatedCreditNotes?.length || undefined,
  });
}

export function invoiceDetail(invoice: S["invoiceResult"]) {
  return compact({
    ...invoiceSummary(invoice),
    kid: invoice.kid,
    saleId: invoice.sale?.saleId,
    yourReference: invoice.yourReference,
    ourReference: invoice.ourReference,
    orderReference: invoice.orderReference,
    invoiceText: invoice.invoiceText,
    lines: invoice.lines?.map(invoiceLine),
    payments: invoice.sale?.salePayments?.map(paymentSummary),
    pdf: invoice.invoicePdf?.downloadUrlWithFikenNormalUserCredentials,
    attachments: invoice.attachments?.map(attachmentSummary),
  });
}

export function creditNoteSummary(note: S["creditNoteResult"]) {
  return compact({
    id: note.creditNoteId,
    creditNoteNumber: note.creditNoteNumber,
    issueDate: note.issueDate,
    customer: counterparty(note.customer),
    net: kr(note.net),
    vat: kr(note.vat),
    gross: kr(note.gross),
    currency: note.currency === "NOK" ? undefined : note.currency,
    settled: note.settled,
    invoiceId: note.associatedInvoiceId,
  });
}

export function creditNoteDetail(note: S["creditNoteResult"]) {
  return compact({
    ...creditNoteSummary(note),
    creditNoteText: note.creditNoteText,
    lines: note.lines?.map(invoiceLine),
    pdf: note.creditNotePdf?.downloadUrlWithFikenNormalUserCredentials,
  });
}

function invoiceLine(line: S["invoiceLineResult"]) {
  return compact({
    description: line.description ?? line.productName,
    productId: line.productId,
    quantity: line.quantity,
    unitPrice: kr(line.unitPrice),
    discount: line.discount || undefined,
    net: kr(line.net),
    vat: kr(line.vat),
    gross: kr(line.gross),
    vatType: line.vatType,
    incomeAccount: line.incomeAccount,
  });
}

/** Invoice, credit note and offer drafts. */
export function invoiceishDraftSummary(draft: S["invoiceishDraftResult"]) {
  return compact({
    id: draft.draftId,
    type: draft.type,
    issueDate: draft.issueDate,
    daysUntilDueDate: draft.daysUntilDueDate,
    customer: counterparty(draft.customers?.[0]),
    net: kr(draft.net),
    gross: kr(draft.gross),
    currency: draft.currency === "NOK" ? undefined : draft.currency,
  });
}

export function invoiceishDraftDetail(draft: S["invoiceishDraftResult"]) {
  return compact({
    ...invoiceishDraftSummary(draft),
    uuid: draft.uuid,
    invoiceText: draft.invoiceText,
    yourReference: draft.yourReference,
    ourReference: draft.ourReference,
    orderReference: draft.orderReference,
    createdFromInvoiceId: draft.createdFromInvoiceId,
    lines: draft.lines?.map((line) =>
      compact({
        description: line.description,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: kr(line.unitPrice),
        discount: line.discount || undefined,
        vatType: line.vatType,
        incomeAccount: line.incomeAccount,
      }),
    ),
    attachments: draft.attachments?.map(attachmentSummary),
  });
}

/** Sale and purchase drafts. */
export function draftSummary(draft: S["draftResult"]) {
  const net = draft.lines?.reduce((sum, line) => sum + (line.net ?? 0), 0);
  const gross = draft.lines?.reduce((sum, line) => sum + (line.gross ?? 0), 0);
  return compact({
    id: draft.draftId,
    date: draft.invoiceIssueDate,
    dueDate: draft.dueDate,
    invoiceNumber: draft.invoiceNumber,
    counterparty: counterparty(draft.contact),
    cash: draft.cash,
    paid: draft.paid,
    net: kr(net),
    gross: kr(gross),
    currency: draft.currency === "NOK" ? undefined : draft.currency,
  });
}

export function draftDetail(draft: S["draftResult"]) {
  return compact({
    ...draftSummary(draft),
    uuid: draft.uuid,
    kid: draft.kid,
    lines: draft.lines?.map((line) =>
      compact({ description: line.text, net: kr(line.net), gross: kr(line.gross), vatType: line.vatType, account: line.incomeAccount }),
    ),
    payments: draft.payments?.map(paymentSummary),
    attachments: draft.attachments?.map(attachmentSummary),
  });
}

export function saleSummary(sale: S["saleResult"]) {
  return compact({
    id: sale.saleId,
    saleNumber: sale.saleNumber,
    date: sale.date,
    kind: sale.kind,
    customer: counterparty(sale.customer),
    net: kr(sale.netAmount),
    vat: kr(sale.vatAmount),
    gross: kr((sale.netAmount ?? 0) + (sale.vatAmount ?? 0)),
    currency: sale.currency === "NOK" ? undefined : sale.currency,
    dueDate: sale.dueDate,
    settled: sale.settled,
    settledDate: sale.settledDate,
    outstanding: kr(sale.outstandingBalance),
    writeOff: sale.writeOff || undefined,
  });
}

export function saleDetail(sale: S["saleResult"]) {
  return compact({
    ...saleSummary(sale),
    transactionId: sale.transactionId,
    kid: sale.kid,
    totalPaid: kr(sale.totalPaid),
    lines: sale.lines?.map(orderLine),
    payments: sale.salePayments?.map(paymentSummary),
    attachments: sale.saleAttachments?.map(attachmentSummary),
  });
}

export function purchaseSummary(purchase: S["purchaseResult"]) {
  const net = purchase.lines?.reduce((sum, line) => sum + (line.netPrice ?? 0), 0);
  const vat = purchase.lines?.reduce((sum, line) => sum + (line.vat ?? 0), 0);
  return compact({
    id: purchase.purchaseId,
    identifier: purchase.identifier,
    date: purchase.date,
    dueDate: purchase.dueDate,
    kind: purchase.kind,
    supplier: counterparty(purchase.supplier),
    net: kr(net),
    vat: kr(vat),
    gross: net === undefined ? undefined : kr(net + (vat ?? 0)),
    currency: purchase.currency === "NOK" ? undefined : purchase.currency,
    paid: purchase.paid,
    settledDate: purchase.settledDate,
    attachments: purchase.purchaseAttachments?.length ?? 0,
  });
}

export function purchaseDetail(purchase: S["purchaseResult"]) {
  return compact({
    ...purchaseSummary(purchase),
    transactionId: purchase.transactionId,
    kid: purchase.kid,
    paymentAccount: purchase.paymentAccount,
    paymentDate: purchase.paymentDate,
    lines: purchase.lines?.map(orderLine),
    payments: purchase.payments?.map(paymentSummary),
    attachments: purchase.purchaseAttachments?.map(attachmentSummary),
  });
}

function orderLine(line: S["orderLine"]) {
  return compact({
    description: line.description,
    net: kr(line.netPrice),
    vat: kr(line.vat),
    vatType: line.vatType,
    account: line.account,
    projectId: line.projectId,
  });
}

export function paymentSummary(payment: S["payment"]) {
  return compact({
    id: payment.paymentId,
    date: payment.date,
    amount: kr(payment.amount),
    account: payment.account,
    fee: kr(payment.fee) || undefined,
    currency: payment.currency === "NOK" ? undefined : payment.currency,
    amountInNok: payment.currency && payment.currency !== "NOK" ? kr(payment.amountInNok) : undefined,
  });
}

export function attachmentSummary(attachment: S["attachment"]) {
  return compact({ filename: attachment.filename, type: attachment.type, url: attachment.downloadUrlWithFikenNormalUserCredentials });
}

export function journalEntrySummary(entry: S["journalEntry"]) {
  return compact({
    id: entry.journalEntryId,
    number: entry.journalEntryNumber,
    date: entry.date,
    description: entry.description,
    type: entry.transactionType,
    transactionId: entry.transactionId,
    lines: entry.lines.map((line) => compact({ account: line.account, amount: kr(line.amount), vatCode: line.vatCode })),
    attachments: entry.attachments?.length ?? 0,
  });
}

export function inboxSummary(document: S["inboxResult"]) {
  return compact({
    id: document.documentId,
    name: document.name,
    filename: document.filename,
    description: document.description,
    createdAt: document.createdAt,
    used: document.status,
    url: document.documentUrlWithFikenNormalUserCredentials,
  });
}
