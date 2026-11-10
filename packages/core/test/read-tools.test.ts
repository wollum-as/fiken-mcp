import { describe, expect, it } from "vitest";
import type { FikenHttpRequest } from "../src/fiken/transport.ts";
import { connect, json, MockTransport } from "./helpers.ts";

const COMPANY = "test-as";
const TODAY = "2026-10-16";

/** Answers by path prefix (query string ignored), most specific first. */
type Route = unknown;

function routes(table: Record<string, Route>, headers: Record<string, string> = {}) {
  return new MockTransport((request) => {
    const path = request.path.split("?")[0] ?? "";
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.endsWith(prefix));
    if (key === undefined) return json({ message: `no route for ${request.path}` }, { status: 404 });
    const value = table[key];
    return json(typeof value === "function" ? (value as (r: FikenHttpRequest) => unknown)(request) : value, { headers });
  });
}

const query = (request: FikenHttpRequest | undefined) => new URL(`https://x${request?.path ?? ""}`).searchParams;

async function run(transport: MockTransport, name: string, args: Record<string, unknown>) {
  const client = await connect(transport, { today: () => TODAY });
  return client.callTool({ name, arguments: args });
}

describe("company resolution", () => {
  it("uses the only company when none is given", async () => {
    const transport = routes({ "/companies": [{ slug: "only-as", name: "Only AS" }], "/contacts": [] });
    const result = await run(transport, "find_contacts", {});
    expect(result.isError).toBeFalsy();
    expect(transport.requests[1]?.path).toMatch(/^\/companies\/only-as\/contacts\?/);
  });

  it("asks which company when there are several", async () => {
    const transport = routes({ "/companies": [{ slug: "a", name: "A AS" }, { slug: "b", name: "B AS" }] });
    const result = await run(transport, "find_contacts", {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("A AS (a), B AS (b)");
  });
});

describe("company slug", () => {
  it("refuses a slug that is not one", async () => {
    for (const company of [".", "..", "a/b", "A B"]) {
      const transport = routes({});
      const result = await run(transport, "find_contacts", { company });
      expect(result.isError, company).toBe(true);
      expect(transport.requests, company).toHaveLength(0);
    }
  });
});

describe("find_contacts", () => {
  it("maps role and hides inactive contacts by default", async () => {
    const transport = routes({ "/contacts": [] });
    await run(transport, "find_contacts", { company: COMPANY, role: "supplier", query: "ola" });
    const params = query(transport.requests[0]);
    expect(params.get("supplier")).toBe("true");
    expect(params.get("customer")).toBeNull();
    expect(params.get("inactive")).toBe("false");
    expect(params.get("name")).toBe("ola");
  });

  it("shows the bank account number in the detail, for paying suppliers", async () => {
    const transport = routes({
      "/contacts/5": { contactId: 5, name: "Ola Nordmann", supplier: true, bankAccountNumber: "11112233334" },
      "/contactPerson": [],
    });
    const result = await run(transport, "find_contacts", { company: COMPANY, id: 5 });
    expect(result.structuredContent).toMatchObject({ contact: { id: 5, name: "Ola Nordmann", bankAccountNumber: "11112233334" } });
  });
});

describe("find_products", () => {
  it("filters on part of the name here, since Fiken only matches whole names", async () => {
    const transport = routes({
      "/products": [
        { productId: 1, name: "Konsulenttime", unitPrice: 120000, active: true },
        { productId: 2, name: "Reisekostnader", unitPrice: 5000, active: true },
      ],
    });
    const result = await run(transport, "find_products", { company: COMPANY, query: "TIME" });
    expect(result.structuredContent).toMatchObject({ products: [{ id: 1, name: "Konsulenttime", unitPrice: 1200 }] });
    expect(query(transport.requests[0]).get("name")).toBeNull();
  });
});

describe("find_invoices", () => {
  it("treats overdue as unsettled with a due date before today", async () => {
    const transport = routes({ "/invoices": [] });
    await run(transport, "find_invoices", { company: COMPANY, status: "overdue" });
    const params = query(transport.requests[0]);
    expect(params.get("settled")).toBe("false");
    expect(params.get("dueDateLt")).toBe(TODAY);
  });

  it("refuses overdue for credit notes", async () => {
    const result = await run(routes({}), "find_invoices", { company: COMPANY, type: "credit_note", status: "overdue" });
    expect(result.isError).toBe(true);
  });

  it("converts amounts to kroner and sums the page", async () => {
    const transport = routes({
      "/invoices": [
        { invoiceId: 1, gross: 12500, net: 10000, vat: 2500, customer: { contactId: 5, name: "Kunde AS" }, sale: { settled: false, outstandingBalance: 12500 } },
        { invoiceId: 2, gross: 25050, net: 20040, vat: 5010 },
      ],
    });
    const result = await run(transport, "find_invoices", { company: COMPANY });
    expect(result.structuredContent).toMatchObject({
      // Newest first: Fiken's last item comes first.
      invoices: [{ id: 2, gross: 250.5 }, { id: 1, gross: 125, outstanding: 125, settled: false, customer: { id: 5, name: "Kunde AS" } }],
      sumGross: 375.5,
    });
  });

  it("refuses a period that ends before it starts", async () => {
    const result = await run(routes({}), "find_invoices", { company: COMPANY, from: "2026-02-01", to: "2026-01-01" });
    expect(result.isError).toBe(true);
  });
});

describe("find_purchases", () => {
  it("finds booked purchases without a receipt across Fiken's pages, newest first", async () => {
    const page = (offset: number) =>
      Array.from({ length: 100 }, (_, index) => ({ purchaseId: offset + index, purchaseAttachments: [{ filename: "kvittering.pdf" }] }));
    const lastPage = [
      { purchaseId: 200, date: "2026-09-02", purchaseAttachments: [] },
      { purchaseId: 201, deleted: true },
      { purchaseId: 202, date: "2026-09-01" },
    ];
    const transport = routes({ "/purchases": (request: FikenHttpRequest) => [page(0), page(100), lastPage][Number(query(request).get("page"))] }, { "Fiken-Api-Result-Count": "203" });
    const result = await run(transport, "find_purchases", { company: COMPANY, missing_receipt: true, from: "2026-01-01" });
    expect(result.structuredContent).toMatchObject({ purchases: [{ id: 200, attachments: 0 }, { id: 202, attachments: 0 }], paging: { total: 2, more: false } });
    expect(transport.requests).toHaveLength(3);
    expect(query(transport.requests[0]).get("sortBy")).toBe("date desc");
    expect(query(transport.requests[0]).get("dateGe")).toBe("2026-01-01");
  });
});

describe("find_journal_entries", () => {
  const entries = [
    { journalEntryId: 1, date: "2026-01-02", description: "a", lines: [{ account: "1500:10001", amount: 100 }, { account: "3000", amount: -100 }] },
    { journalEntryId: 2, date: "2026-01-03", description: "b", lines: [{ account: "1920:10001", amount: 50 }, { account: "7770", amount: -50 }] },
  ];

  it("finds entries on a main account, including its sub-ledger accounts, this year by default", async () => {
    const transport = routes({ "/journalEntries": entries });
    const result = await run(transport, "find_journal_entries", { company: COMPANY, account: "1500" });
    expect((result.structuredContent as { items: { id: number }[] }).items.map((entry) => entry.id)).toEqual([1]);
    const params = query(transport.requests[0]);
    expect(params.get("dateGe")).toBe("2026-01-01");
    expect(params.get("dateLe")).toBe(TODAY);
  });

  it("says so when the period has more entries than it scans", async () => {
    const page = Array.from({ length: 100 }, () => entries[1]);
    const transport = routes({ "/journalEntries": page }, { "Fiken-Api-Result-Count": "5000" });
    const result = await run(transport, "find_journal_entries", { company: COMPANY, account: "3000" });
    // The first call reads the total, then the scan goes from the newest page backwards.
    expect(transport.requests).toHaveLength(11);
    expect(query(transport.requests[1]).get("page")).toBe("49");
    expect((result.structuredContent as { note: string }).note).toContain("kortere periode");
  });
});

describe("find_accounts", () => {
  it("narrows a sub-ledger account to its main account and then matches it exactly", async () => {
    const transport = routes({
      "/accountBalances": [
        { code: "1500:10001", name: "Kunde A", balance: 12500 },
        { code: "1500:10002", name: "Kunde B", balance: 5000 },
      ],
    });
    const result = await run(transport, "find_accounts", { company: COMPANY, number: "1500:10002", balance_date: TODAY });
    expect(result.structuredContent).toMatchObject({ items: [{ code: "1500:10002", balance: 50 }] });
    const params = query(transport.requests[0]);
    expect([params.get("fromAccount"), params.get("toAccount")]).toEqual(["1500", "1500"]);
  });
});

describe("get_report", () => {
  it("computes the result as the balance at the end minus the balance the day before the start", async () => {
    const transport = routes({
      "/accountBalances": (request: FikenHttpRequest) =>
        query(request).get("date") === "2026-10-16"
          ? [
              { code: "3000", name: "Salg", balance: -500000 },
              { code: "4300", name: "Varekjøp", balance: 100000 },
            ]
          : [
              { code: "3000", name: "Salg", balance: -200000 },
              { code: "4300", name: "Varekjøp", balance: 50000 },
            ],
    });
    const result = await run(transport, "get_report", { company: COMPANY, type: "result", from: "2026-07-01" });
    expect(query(transport.requests[1]).get("date")).toBe("2026-06-30");
    expect(result.structuredContent).toMatchObject({
      period: { from: "2026-07-01", to: TODAY },
      operatingResult: 2500,
      result: 2500,
      groups: [
        { name: "Driftsinntekter", total: 3000 },
        { name: "Varekostnad", total: -500 },
      ],
    });
  });

  it("needs only the end balance for a period from 1 January", async () => {
    const transport = routes({ "/accountBalances": [{ code: "3000", name: "Salg", balance: -100 }] });
    await run(transport, "get_report", { company: COMPANY, type: "result" });
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses a result period across years, because Fiken restarts result accounts each year", async () => {
    const result = await run(routes({}), "get_report", { company: COMPANY, type: "result", from: "2025-12-01", to: "2026-01-31" });
    expect(result.isError).toBe(true);
  });

  it("balances by counting this year's result as equity", async () => {
    const transport = routes({
      "/accountBalances": (request: FikenHttpRequest) =>
        query(request).get("fromAccount") === "1000"
          ? [
              { code: "1500:10001", name: "Kunde", balance: 12500 },
              { code: "1920:10001", name: "Bank", balance: 87500 },
              { code: "2000", name: "Aksjekapital", balance: -30000 },
              { code: "2701", name: "Utgående mva", balance: -20000 },
            ]
          : [{ code: "3000", name: "Salg", balance: -50000 }],
    });
    const result = await run(transport, "get_report", { company: COMPANY, type: "balance" });
    expect(result.structuredContent).toMatchObject({
      totalAssets: 1000,
      resultNotYetClosed: 500,
      totalEquityAndLiabilities: 1000,
      balanced: true,
      assets: [{ name: "Omløpsmidler", accounts: [{ code: "1500", amount: 125 }, { code: "1920", amount: 875 }] }],
    });
  });

  it("lists receivables per customer and payables as positive amounts owed", async () => {
    const transport = routes({
      "/accountBalances": (request: FikenHttpRequest) =>
        query(request).get("fromAccount") === "1500"
          ? [
              { code: "1500", name: "Kundefordringer", balance: 17500 },
              { code: "1500:10001", name: "Kunde A", balance: 12500 },
              { code: "1500:10002", name: "Kunde B", balance: 5000 },
              { code: "1500:10003", name: "Kunde C", balance: 0 },
            ]
          : [{ code: "2400:20001", name: "Leverandør", balance: -50000 }],
    });
    const receivables = await run(transport, "get_report", { company: COMPANY, type: "receivables" });
    expect(receivables.structuredContent).toMatchObject({
      total: 175,
      customers: [
        { account: "1500:10001", amount: 125 },
        { account: "1500:10002", amount: 50 },
      ],
    });
    const payables = await run(transport, "get_report", { company: COMPANY, type: "payables" });
    expect(payables.structuredContent).toMatchObject({ total: 500, suppliers: [{ name: "Leverandør", amount: 500 }] });
  });
});

describe("newest first", () => {
  /** A Fiken list of `total` items with IDs 0..total-1, oldest first, honouring page and pageSize. */
  function oldestFirst(total: number) {
    return new MockTransport((request) => {
      const params = query(request);
      const page = Number(params.get("page"));
      const size = Number(params.get("pageSize"));
      const ids = Array.from({ length: total }, (_, id) => id).slice(page * size, (page + 1) * size);
      return json(
        ids.map((id) => ({ invoiceId: id, gross: 100 })),
        { headers: { "Fiken-Api-Result-Count": String(total) } },
      );
    });
  }
  const ids = (result: Awaited<ReturnType<typeof run>>) => (result.structuredContent as { invoices: { id: number }[] }).invoices.map((i) => i.id);

  it("returns the newest items first, from the two Fiken pages that hold them", async () => {
    const transport = oldestFirst(45);
    const result = await run(transport, "find_invoices", { company: COMPANY, limit: 20 });
    expect(ids(result)).toEqual(Array.from({ length: 20 }, (_, i) => 44 - i));
    expect(result.structuredContent).toMatchObject({ paging: { page: 0, limit: 20, total: 45, more: true } });
    expect(transport.requests.map((r) => query(r).get("page"))).toEqual(["0", "1", "2"]);
  });

  it("reuses Fiken's first page for the oldest items", async () => {
    const transport = oldestFirst(45);
    const result = await run(transport, "find_invoices", { company: COMPANY, limit: 20, page: 2 });
    expect(ids(result)).toEqual([4, 3, 2, 1, 0]);
    expect(result.structuredContent).toMatchObject({ paging: { page: 2, more: false } });
    expect(transport.requests).toHaveLength(1);
  });

  it("needs one call when everything fits on a page", async () => {
    const transport = oldestFirst(6);
    const result = await run(transport, "find_invoices", { company: COMPANY });
    expect(ids(result)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(transport.requests).toHaveLength(1);
  });

  it("returns an empty page beyond the oldest item", async () => {
    const result = await run(oldestFirst(6), "find_invoices", { company: COMPANY, page: 3 });
    expect(ids(result)).toEqual([]);
  });
});
