import * as z from "zod";
import type { FikenClient } from "../fiken/client.ts";
import type { components } from "../fiken/types.gen.ts";
import { companyInput, fikenId, resolveCompany, ToolError } from "./common.ts";
import { defineTool, jsonResult, READ_ONLY } from "./tool.ts";

/** Claude takes images up to 5 MB. PDFs may be larger, but a bigger file is rarely a receipt. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The file types Fiken accepts as attachments. */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

export const FILE_TYPES = ["inbox", "ehf", "purchase", "sale", "invoice", "credit_note", "journal_entry"] as const;

/** A file Fiken lets API clients download. */
interface FileRef {
  filename: string;
  url: string | undefined;
}

type Attachment = components["schemas"]["attachment"];
type FileSource = (fiken: FikenClient, companySlug: string, id: number) => Promise<FileRef[]>;

/** Where each type keeps its files: inbox and EHF documents are one file, the rest have attachments. */
const SOURCES: Record<(typeof FILE_TYPES)[number], FileSource> = {
  async inbox(fiken, companySlug, id) {
    const { data } = await fiken.api.GET("/companies/{companySlug}/inbox/{inboxDocumentId}", {
      params: { path: { companySlug, inboxDocumentId: id } },
    });
    return [{ filename: data?.filename ?? data?.name ?? "dokument", url: data?.documentUrl }];
  },
  async ehf(fiken, companySlug, id) {
    const { data } = await fiken.api.GET("/companies/{companySlug}/ehf/{ehfDocumentId}", { params: { path: { companySlug, ehfDocumentId: id } } });
    // The EHF result has no file name; the URL ends with it (faktura_2026_1945060.pdf, measured).
    const name = data?.documentUrl ? decodeURIComponent(new URL(data.documentUrl).pathname.split("/").at(-1) ?? "") : "";
    return [{ filename: name || `EHF ${data?.invoiceNumber ?? id}.pdf`, url: data?.documentUrl }];
  },
  async purchase(fiken, companySlug, id) {
    const { data } = await fiken.api.GET("/companies/{companySlug}/purchases/{purchaseId}/attachments", {
      params: { path: { companySlug, purchaseId: id } },
    });
    return attachmentFiles(data);
  },
  async sale(fiken, companySlug, id) {
    const { data } = await fiken.api.GET("/companies/{companySlug}/sales/{saleId}/attachments", { params: { path: { companySlug, saleId: id } } });
    return attachmentFiles(data);
  },
  async invoice(fiken, companySlug, id) {
    const { data } = await fiken.api.GET("/companies/{companySlug}/invoices/{invoiceId}", { params: { path: { companySlug, invoiceId: id } } });
    return attachmentFiles([...(data?.invoicePdf ? [data.invoicePdf] : []), ...(data?.attachments ?? [])]);
  },
  async credit_note(fiken, companySlug, id) {
    const { data } = await fiken.api.GET("/companies/{companySlug}/creditNotes/{creditNoteId}", {
      params: { path: { companySlug, creditNoteId: String(id) } },
    });
    return attachmentFiles(data?.creditNotePdf ? [data.creditNotePdf] : []);
  },
  async journal_entry(fiken, companySlug, id) {
    const { data } = await fiken.api.GET("/companies/{companySlug}/journalEntries/{journalEntryId}/attachments", {
      params: { path: { companySlug, journalEntryId: id } },
    });
    return attachmentFiles(data);
  },
};

export const readFile = defineTool({
  name: "read_file",
  access: "read",
  title: "Les fil fra Fiken",
  description: "Les filen (PDF eller bilde, maks 5 MB) til et innboksdokument, en EHF, eller vedlegg og PDF på kjøp, salg, faktura, kreditnota og bilag. Flere filer: velg attachment.",
  inputSchema: z.object({
    company: companyInput,
    type: z.enum(FILE_TYPES),
    id: fikenId("ID fra find_* eller read_api"),
    attachment: z.number().int().min(1).max(100).optional().describe("Nummer fra listen"),
  }),
  annotations: READ_ONLY,
  async handler(input, { fiken }) {
    const companySlug = await resolveCompany(fiken, input.company);
    // Fiken can list one file several times on a document (one Vipps report five times on a sale, measured).
    const files = (await SOURCES[input.type](fiken, companySlug, input.id)).filter(
      (file, index, all) => file.url && all.findIndex((other) => other.url === file.url) === index,
    );
    if (files.length === 0) throw new ToolError("Fiken har ingen fil for dette dokumentet.");
    if (input.attachment === undefined && files.length > 1) {
      return jsonResult({ files: files.map((file, index) => ({ attachment: index + 1, filename: file.filename })), note: "Velg fil med attachment." });
    }
    const file = files[(input.attachment ?? 1) - 1];
    if (!file?.url) throw new ToolError(`Dokumentet har ${files.length} ${files.length === 1 ? "fil" : "filer"}. Velg attachment fra 1 til ${files.length}.`);

    const response = await fiken.download(file.url);
    const mimeType = mimeTypeOf(response.headers.get("content-type"), file.filename);
    if (mimeType === undefined) throw new ToolError(`Filtypen til ${file.filename} kan ikke leses her. Åpne den i Fiken.`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ToolError(`${file.filename} er større enn 5 MB. Åpne den i Fiken.`);

    const summary = { filename: file.filename, mimeType, bytes: bytes.byteLength, ...(files.length > 1 ? { attachment: input.attachment ?? 1, of: files.length } : {}) };
    const base64 = toBase64(bytes);
    const content =
      mimeType === "application/pdf"
        ? { type: "resource" as const, resource: { uri: file.url, mimeType, blob: base64 } }
        : { type: "image" as const, data: base64, mimeType };
    return { content: [{ type: "text", text: JSON.stringify({ file: summary }) }, content], structuredContent: { file: summary } };
  },
});

function attachmentFiles(attachments: Attachment[] | undefined): FileRef[] {
  return (attachments ?? []).map((attachment) => ({ filename: attachment.filename ?? "vedlegg", url: attachment.downloadUrl }));
}

/** The type Fiken sends, when it is one we can pass on; otherwise the type the file name says. */
function mimeTypeOf(contentType: string | null, filename: string): string | undefined {
  const known = new Set(Object.values(MIME_BY_EXTENSION));
  const sent = contentType?.split(";")[0]?.trim().toLowerCase();
  if (sent && known.has(sent)) return sent;
  return MIME_BY_EXTENSION[filename.split(".").at(-1)?.toLowerCase() ?? ""];
}

/** Web-standard base64, in chunks so large files do not overflow the argument list. */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let start = 0; start < view.length; start += 0x8000) {
    binary += String.fromCharCode(...view.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
