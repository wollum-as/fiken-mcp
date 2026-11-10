import * as z from "zod";
import { companyInput, idInput, limitInput, pageInput, paging, resolveCompany } from "./common.ts";
import { contactDetail, contactSummary } from "./summaries.ts";
import { defineTool, jsonResult, READ_ONLY } from "./tool.ts";

export const findContacts = defineTool({
  name: "find_contacts",
  access: "read",
  title: "Finn kunder og leverandører",
  description:
    "Kunder og leverandører. Søk her før du oppretter en kontakt, så det ikke blir duplikater. Med id: adresse, kontonummer og kontaktpersoner.",
  inputSchema: z.object({
    company: companyInput,
    id: idInput("Kontakt"),
    query: z.string().min(1).optional().describe("Del av navnet"),
    org_number: z.string().refine((value) => /^\d{9}$/.test(value), "Organisasjonsnummer har 9 sifre").optional(),
    email: z.string().optional(),
    role: z.enum(["customer", "supplier"]).optional(),
    include_inactive: z.boolean().default(false),
    limit: limitInput,
    page: pageInput,
  }),
  annotations: READ_ONLY,
  async handler(input, { fiken }) {
    const companySlug = await resolveCompany(fiken, input.company);

    if (input.id !== undefined) {
      const path = { companySlug, contactId: input.id };
      const { data: contact } = await fiken.api.GET("/companies/{companySlug}/contacts/{contactId}", { params: { path } });
      const { data: persons } = await fiken.api.GET("/companies/{companySlug}/contacts/{contactId}/contactPerson", { params: { path } });
      return jsonResult({ contact: contact ? contactDetail(contact, persons ?? []) : null });
    }

    const { data, response } = await fiken.api.GET("/companies/{companySlug}/contacts", {
      params: {
        path: { companySlug },
        query: {
          page: input.page,
          pageSize: input.limit,
          name: input.query,
          organizationNumber: input.org_number,
          email: input.email,
          customer: input.role === "customer" ? true : undefined,
          supplier: input.role === "supplier" ? true : undefined,
          inactive: input.include_inactive ? undefined : false,
        },
      },
    });
    const contacts = (data ?? []).map(contactSummary);
    return jsonResult({ contacts, paging: paging(input.page, input.limit, contacts.length, response) });
  },
});
