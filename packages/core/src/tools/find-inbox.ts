import * as z from "zod";
import { companyInput, idInput, limitInput, pageInput, paging, resolveCompany } from "./common.ts";
import { inboxSummary } from "./summaries.ts";
import { defineTool, jsonResult, READ_ONLY } from "./tool.ts";

export const findInbox = defineTool({
  name: "find_inbox",
  access: "read",
  title: "Innboksen i Fiken",
  description:
    "Innboksen i Fiken, nyeste først: kvitteringer og fakturaer som venter på bokføring. status: unused (standard), used, all. Selve filen: read_file.",
  inputSchema: z.object({
    company: companyInput,
    id: idInput("Dokument"),
    status: z.enum(["unused", "used", "all"]).default("unused"),
    query: z.string().min(1).optional().describe("Dokumentnavn"),
    limit: limitInput,
    page: pageInput,
  }),
  annotations: READ_ONLY,
  async handler(input, { fiken }) {
    const companySlug = await resolveCompany(fiken, input.company);

    if (input.id !== undefined) {
      const { data } = await fiken.api.GET("/companies/{companySlug}/inbox/{inboxDocumentId}", {
        params: { path: { companySlug, inboxDocumentId: input.id } },
      });
      return jsonResult({ document: data ? inboxSummary(data) : null });
    }

    const { data, response } = await fiken.api.GET("/companies/{companySlug}/inbox", {
      params: {
        path: { companySlug },
        query: { page: input.page, pageSize: input.limit, status: input.status, name: input.query, sortBy: "createdDate desc" },
      },
    });
    const documents = (data ?? []).map(inboxSummary);
    return jsonResult({ documents, paging: paging(input.page, input.limit, documents.length, response) });
  },
});
