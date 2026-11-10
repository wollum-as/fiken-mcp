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

describe("read_file", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const FILES = "https://api.fiken.no/api/v2/files";
  const attachment = (filename: string) => ({ filename, downloadUrl: `${FILES}/abc/${filename}`, downloadUrlWithFikenNormalUserCredentials: `https://fiken.no/filer/abc/${filename}` });

  /** Answers metadata from `table` by exact path, and every file download with `file`. */
  function fiken(table: Record<string, unknown>, file: (request: FikenHttpRequest) => Response = () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })) {
    return new MockTransport((request) => {
      const path = request.path.split("?")[0] ?? "";
      if (path.startsWith("/files/")) return file(request);
      return path in table ? json(table[path]) : json({ message: `no route for ${request.path}` }, { status: 404 });
    });
  }

  async function readFile(transport: MockTransport, args: Record<string, unknown>) {
    return run(transport, "read_file", { company: COMPANY, ...args });
  }

  it("downloads an inbox document's documentUrl and returns an image", async () => {
    const transport = fiken(
      { [`/companies/${COMPANY}/inbox/77`]: { documentId: 77, name: "kvittering.png", filename: "kvittering.png", documentUrl: `${FILES}/abc/kvittering.png` } },
      () => new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    const result = await readFile(transport, { type: "inbox", id: 77 });
    expect(result.isError).toBeFalsy();
    expect(transport.requests[1]).toMatchObject({ method: "GET", path: "/files/abc/kvittering.png" });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ file: { filename: "kvittering.png", mimeType: "image/png", bytes: 8 } }) },
      { type: "image", data: btoa(String.fromCharCode(...PNG)), mimeType: "image/png" },
    ]);
  });

  it("returns a PDF as an embedded resource, typed from the file name when Fiken sends octet-stream", async () => {
    const transport = fiken(
      { [`/companies/${COMPANY}/purchases/5/attachments`]: [attachment("kvittering.pdf")] },
      () => new Response("%PDF-1.4", { headers: { "content-type": "application/octet-stream" } }),
    );
    const result = await readFile(transport, { type: "purchase", id: 5 });
    expect(result.content).toContainEqual({
      type: "resource",
      resource: { uri: `${FILES}/abc/kvittering.pdf`, mimeType: "application/pdf", blob: btoa("%PDF-1.4") },
    });
  });

  it("lists the files when there are several, and downloads the one chosen", async () => {
    const invoice = { [`/companies/${COMPANY}/invoices/9`]: { invoicePdf: attachment("faktura.pdf"), attachments: [attachment("timeliste.pdf")] } };
    const listed = await readFile(fiken(invoice), { type: "invoice", id: 9 });
    expect(listed.structuredContent).toEqual({
      files: [
        { attachment: 1, filename: "faktura.pdf" },
        { attachment: 2, filename: "timeliste.pdf" },
      ],
      note: "Velg fil med attachment.",
    });

    const transport = fiken(invoice);
    const chosen = await readFile(transport, { type: "invoice", id: 9, attachment: 2 });
    expect(transport.requests.at(-1)?.path).toBe("/files/abc/timeliste.pdf");
    expect(chosen.structuredContent).toEqual({ file: { filename: "timeliste.pdf", mimeType: "application/pdf", bytes: 8, attachment: 2, of: 2 } });
  });

  it("treats the same file listed several times as one", async () => {
    const transport = fiken({ [`/companies/${COMPANY}/sales/6/attachments`]: [attachment("vipps.pdf"), attachment("vipps.pdf")] });
    const result = await readFile(transport, { type: "sale", id: 6 });
    expect(result.structuredContent).toEqual({ file: { filename: "vipps.pdf", mimeType: "application/pdf", bytes: 8 } });
  });

  it.each([
    ["ehf", `/companies/${COMPANY}/ehf/3`, { invoiceNumber: "1001", documentUrl: `${FILES}/abc/ehf.pdf` }, "ehf.pdf"],
    ["sale", `/companies/${COMPANY}/sales/3/attachments`, [attachment("vipps.pdf")], "vipps.pdf"],
    ["credit_note", `/companies/${COMPANY}/creditNotes/3`, { creditNotePdf: attachment("kreditnota.pdf") }, "kreditnota.pdf"],
    ["journal_entry", `/companies/${COMPANY}/journalEntries/3/attachments`, [attachment("bilag.pdf")], "bilag.pdf"],
  ])("reads the file of a %s", async (type, path, body, filename) => {
    const transport = fiken({ [path]: body });
    const result = await readFile(transport, { type, id: 3 });
    expect(result.isError).toBeFalsy();
    expect(transport.requests.map((request) => request.path)).toEqual([path, `/files/abc/${filename}`]);
  });

  it("says so when there is no file, or the chosen number does not exist", async () => {
    const none = await readFile(fiken({ [`/companies/${COMPANY}/sales/4/attachments`]: [] }), { type: "sale", id: 4 });
    expect(none.isError).toBe(true);
    const outOfRange = await readFile(fiken({ [`/companies/${COMPANY}/sales/4/attachments`]: [attachment("a.pdf")] }), { type: "sale", id: 4, attachment: 2 });
    expect(JSON.stringify(outOfRange.content)).toContain("Velg attachment fra 1 til 1");
  });

  it.each(["https://evil.example/api/v2/files/abc/x.pdf", "https://fiken.no/api/v2/files/abc/x.pdf", "https://api.fiken.no/other/x.pdf"])(
    "refuses %s without sending the request",
    async (url) => {
      const transport = fiken({ [`/companies/${COMPANY}/inbox/77`]: { filename: "x.pdf", documentUrl: url } });
      const result = await readFile(transport, { type: "inbox", id: 77 });
      expect(result.isError).toBe(true);
      expect(transport.requests).toHaveLength(1);
    },
  );

  it("names the redirect target instead of following it", async () => {
    const transport = fiken(
      { [`/companies/${COMPANY}/inbox/77`]: { filename: "x.pdf", documentUrl: `${FILES}/abc/x.pdf` } },
      () => new Response(null, { status: 302, headers: { location: "https://bucket.s3.amazonaws.com/x.pdf?sig=secret" } }),
    );
    const result = await readFile(transport, { type: "inbox", id: 77 });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("bucket.s3.amazonaws.com");
    expect(text).not.toContain("secret");
  });

  it("refuses files over 5 MB", async () => {
    const transport = fiken(
      { [`/companies/${COMPANY}/inbox/77`]: { filename: "stor.pdf", documentUrl: `${FILES}/abc/stor.pdf` } },
      () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { "content-type": "application/pdf" } }),
    );
    const result = await readFile(transport, { type: "inbox", id: 77 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("5 MB");
  });
});
