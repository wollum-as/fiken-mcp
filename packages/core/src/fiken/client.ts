import createClient, { type Client, type Middleware } from "openapi-fetch";
import { FikenApiError, readFikenMessage } from "./errors.ts";
import type { FikenTransport, HttpMethod } from "./transport.ts";
import type { components, paths } from "./types.gen.ts";

export type Company = components["schemas"]["company"];

/** The typed Fiken API: every path, parameter, body and response comes from the OpenAPI spec. */
export type FikenApi = Client<paths>;

/** Fiken's maximum page size. */
export const MAX_PAGE_SIZE = 100;

const BASE_URL = new URL("https://api.fiken.no/api/v2");

export interface Page<T> {
  items: T[];
  /** Total number of items across all pages, from `Fiken-Api-Result-Count`. */
  total: number | undefined;
}

/**
 * Access to the Fiken API v2 for one signed-in user. All calls go through the injected transport,
 * which owns authentication and Fiken's rate limits.
 *
 * Non-2xx responses throw `FikenApiError`; a call without a usable response throws
 * `FikenTransportError`. A successful call therefore always has `response.ok`.
 */
export class FikenClient {
  readonly api: FikenApi;
  readonly #transport: FikenTransport;

  constructor(transport: FikenTransport) {
    this.#transport = transport;
    this.api = createClient<paths>({
      baseUrl: BASE_URL.href,
      headers: { accept: "application/json" },
      fetch: (request) => sendThrough(transport, request),
    });
    this.api.use(requirePathParams, throwOnError);
  }

  /**
   * A GET whose path is only known at run time: the gateway's allowlisted operations. Always GET,
   * and path parameters go through the same encoding and checks as typed calls.
   */
  async getByTemplate(
    path: string,
    params: { path: Record<string, string | number>; query: Record<string, string | number | boolean> },
  ): Promise<{ data: unknown; response: Response }> {
    const get = this.api.GET as unknown as (path: string, init: { params: typeof params }) => Promise<{ data?: unknown; response: Response }>;
    const { data, response } = await get(path, { params });
    return { data, response };
  }

  /**
   * Downloads a file Fiken links to for API clients (`documentUrl`, `downloadUrl`). These are
   * `https://api.fiken.no/api/v2/files/...` (measured 10.11.2026); anything else is refused.
   */
  async download(url: string): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.origin !== BASE_URL.origin || !parsed.pathname.startsWith(`${BASE_URL.pathname}/`)) {
      throw new Error("Refusing a download outside the Fiken API");
    }
    const response = await this.#transport.send({ method: "GET", path: parsed.pathname.slice(BASE_URL.pathname.length) + parsed.search });
    // Transports do not follow redirects, so the token stays on Fiken. Name the target in case Fiken starts redirecting.
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("Location");
      throw new FikenApiError(response.status, `Videresender til ${target ? new URL(target, url).host : "ukjent adresse"}`);
    }
    if (!response.ok) throw new FikenApiError(response.status, await readFikenMessage(response.clone()), { write: false });
    return response;
  }

  async listCompanies(): Promise<Page<Company>> {
    const { data, response } = await this.api.GET("/companies", {
      params: { query: { page: 0, pageSize: MAX_PAGE_SIZE, sortBy: "name asc" } },
    });
    return { items: data ?? [], total: resultCount(response) };
  }
}

/** Total count from Fiken's pagination headers. */
export function resultCount(response: Response): number | undefined {
  const total = Number(response.headers.get("Fiken-Api-Result-Count") ?? Number.NaN);
  return Number.isFinite(total) ? total : undefined;
}

/**
 * The ID of a resource Fiken just created. Fiken answers a successful POST with an empty body and
 * a `Location` header pointing at the new resource.
 */
export function createdId(response: Response): string | undefined {
  const location = response.headers.get("Location");
  if (!location) return undefined;
  const segment = new URL(location, BASE_URL).pathname.split("/").filter(Boolean).at(-1);
  return segment === undefined ? undefined : decodeURIComponent(segment);
}

/**
 * openapi-fetch leaves a missing path parameter in the URL as `{name}`. Refuse the call instead, and
 * refuse empty values and dot segments, which would change the path.
 */
const requirePathParams: Middleware = {
  onRequest({ schemaPath, params }) {
    for (const [, name] of schemaPath.matchAll(/\{([^}]+)\}/g)) {
      const value = name === undefined ? undefined : params.path?.[name];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing path parameter: ${name ?? "?"}`);
      }
      // encodeURIComponent leaves "." and "..", and URL parsing then walks up the path.
      if (value === "." || value === "..") throw new Error(`Invalid path parameter: ${name ?? "?"}`);
    }
    return undefined;
  },
};

const throwOnError: Middleware = {
  async onResponse({ request, response }) {
    if (!response.ok) {
      throw new FikenApiError(response.status, await readFikenMessage(response.clone()), { write: request.method !== "GET" });
    }
    return undefined;
  },
};

async function sendThrough(transport: FikenTransport, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== BASE_URL.origin || !url.pathname.startsWith(`${BASE_URL.pathname}/`)) {
    throw new Error("Refusing a request outside the Fiken API");
  }
  const body = request.body ? await request.arrayBuffer() : undefined;
  return transport.send({
    method: request.method as HttpMethod,
    path: url.pathname.slice(BASE_URL.pathname.length) + url.search,
    headers: Object.fromEntries(request.headers),
    ...(body === undefined ? {} : { body }),
  });
}
