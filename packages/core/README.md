# @fiken-mcp/core

The platform-independent part of Fiken MCP: the MCP server, its 25 tools, a typed client for the Fiken API v2, and the scheduler that keeps calls within Fiken's limits. It depends only on web-standard APIs, `@modelcontextprotocol/server`, `openapi-fetch` and `zod`, so it can run inside another stack, for example Fiken's own.

The package is not published to npm. It exports its TypeScript source (`src/index.ts`) and uses only erasable syntax, so Node runs it directly with type stripping (tested with Node 22.22), and bundlers such as esbuild take it as is.

`apps/cloudflare` is the reference implementation of everything core leaves to the platform.

## What the platform provides

Core does not authenticate anyone, store tokens or keep state between requests. The platform provides:

1. **Authentication of MCP clients**, following the MCP authorization spec, and an access level per grant: `read` or `write`. Core registers write tools only for `write`.
2. **Fiken OAuth**: sign-in, storing the Fiken tokens, and refreshing them. Core only sees an access token, and only inside the transport.
3. **One `FikenScheduler` per Fiken user**, shared by every request and every process that calls Fiken for that user. Fiken's API rules (in the spec's introduction) allow a single concurrent request, slow down more than 4 requests per second, and may ban a user who breaks the rule. A scheduler per request or per process is not enough.
4. **A stable key per Fiken user** for that scheduler. `GET /user` returns only name and e-mail, so the reference implementation uses an HMAC of the e-mail.
5. Optionally, upload links, logging, and an override for the Enhetsregisteret lookup (see Options).

## Minimal example

A single Node process that already has a signed-in user:

```ts
import { FikenClient, FikenScheduler, handleMcpRequest, type AccessLevel, type FikenHttpRequest, type FikenTransport } from "@fiken-mcp/core";

/** A Fiken API call plus the token of the user it is made for. */
type AuthorizedRequest = FikenHttpRequest & { accessToken: string };

/** One scheduler per Fiken user, shared by every request that user makes. */
const schedulers = new Map<string, FikenScheduler<AuthorizedRequest>>();

function schedulerFor(userKey: string): FikenScheduler<AuthorizedRequest> {
  let scheduler = schedulers.get(userKey);
  if (!scheduler) {
    scheduler = new FikenScheduler<AuthorizedRequest>({
      send: (request, signal) =>
        fetch(`https://api.fiken.no/api/v2${request.path}`, {
          method: request.method,
          headers: { ...request.headers, authorization: `Bearer ${request.accessToken}` },
          body: request.body ?? null,
          redirect: "manual",
          signal,
        }),
    });
    schedulers.set(userKey, scheduler);
  }
  return scheduler;
}

interface SignedInUser {
  /** Stable per Fiken user, e.g. an HMAC of the e-mail from GET /user. */
  key: string;
  fikenAccessToken: string;
  access: AccessLevel;
}

/** POST /mcp, after your own OAuth layer has authenticated the request. */
export function serveMcp(request: Request, user: SignedInUser): Promise<Response> {
  const scheduler = schedulerFor(user.key);
  const transport: FikenTransport = {
    send: (call) => scheduler.run({ ...call, accessToken: user.fikenAccessToken }),
  };
  return handleMcpRequest(request, {
    fiken: new FikenClient(transport),
    access: user.access,
    onToolCall: (event) => console.log("tool_call", event),
  });
}
```

This was run against the test company: `initialize`, `tools/list` (12 tools for a read grant) and a `find_contacts` call. The `Map` only works in one process. With several instances, route each user to a single place: on Cloudflare that is a Durable Object (`apps/cloudflare/src/queue.ts`); elsewhere an actor, or a queue with a lock per user.

`redirect: "manual"` keeps the bearer token from following a redirect to another host.

## Server

| Export | Use |
| --- | --- |
| `handleMcpRequest(request, options)` | Serves one MCP request over Streamable HTTP and returns the response. Stateless: a fresh `McpServer` per request, for 2026-07-28 clients and 2025-era clients without sessions. |
| `createFikenServer(options)` | The `McpServer` itself, for other transports such as stdio or in-memory tests. |
| `INSTRUCTIONS` | The server instructions. claude.ai web and Desktop do not pass them to the model, so the rules that matter are also in the tool descriptions. |
| `TOOLS` | The tool definitions. |

`FikenServerOptions`:

| Option | Required | Purpose |
| --- | --- | --- |
| `fiken` | yes | A `FikenClient` for the signed-in user. |
| `access` | yes | `read` or `write`. Write tools are registered only for `write`. |
| `onToolCall` | no | Called after each tool call with tool, company, outcome, Fiken status and duration. Never accounting data or tokens. |
| `onError` | no | Unexpected errors. The model only gets a generic message. |
| `issueUploadLink` | no | Issues one-time upload links for `create_upload_link`. Without it, the tool can still attach inbox documents but says uploads are unavailable. |
| `lookupOrganization` | no | Enhetsregisteret lookup for `save_contact`. Defaults to the public API (`brregLookup()`). |
| `today` | no | Today's date in Norway, `YYYY-MM-DD`. Defaults to the real date. |

## Transport and scheduler

`FikenClient` sends every call through a `FikenTransport`:

```ts
interface FikenTransport {
  send(request: FikenHttpRequest): Promise<Response>;
}
```

`request.path` is relative to `https://api.fiken.no/api/v2`, with path parameters already encoded and the query string appended. The client refuses any URL outside the Fiken API before the transport sees it. A transport returns Fiken's response, or throws `FikenTransportError` when there is no usable response.

`FikenScheduler.run(request)` queues the request behind every earlier one for that user and returns the response with its body already read. Defaults, all overridable through `SchedulerOptions`:

- At least 300 ms between the start of two requests, about 3.3 per second.
- A 429 is retried after `Retry-After`, or with exponential backoff from 1 s. Fiken does not execute a call it answers with 429, so writes are retried too.
- After 3 consecutive 429s, or a `Retry-After` over 10 s, a circuit breaker stops all calls for at least 60 s. Pass a `BreakerStore` to keep it across restarts.
- A write that times out (30 s) or loses its connection is never retried: it throws `FikenTransportError("outcome_unknown")`, since Fiken may have executed it. A 5xx on a write is returned, not retried.
- A read is retried once after a 5xx or a lost connection.

Errors the tools turn into messages for the model:

- `FikenApiError`: Fiken answered with a non-2xx status. Has `status` and a Norwegian message.
- `FikenTransportError`: no usable response. `kind` is `outcome_unknown`, `rate_limited` or `unavailable`.

## Tools

| Tool | Grant | Class |
| --- | --- | --- |
| `list_companies` | read | read |
| `find_contacts` | read | read |
| `find_products` | read | read |
| `find_invoices` | read | read |
| `find_sales` | read | read |
| `find_purchases` | read | read |
| `find_accounts` | read | read |
| `find_journal_entries` | read | read |
| `find_inbox` | read | read |
| `read_file` | read | read |
| `get_report` | read | read |
| `explore_api` | read | read |
| `read_api` | read | read |
| `save_contact` | write | reversible write |
| `save_product` | write | reversible write |
| `save_invoice_draft` | write | reversible write |
| `save_purchase_draft` | write | reversible write |
| `save_sale_draft` | write | reversible write |
| `create_upload_link` | write | reversible write |
| `finalize_draft` | write | destructive |
| `delete_draft` | write | destructive |
| `register_payment` | write | destructive |
| `create_journal_entry` | write | destructive |
| `credit_invoice` | write | destructive |
| `send_document` | write | destructive |

Rules every tool follows:

- **Annotations** on every tool: `readOnlyHint` for reads, `destructiveHint: false` for reversible writes, `destructiveHint: true` for booking, deleting and sending. The classes are never mixed in one tool.
- **Destructive tools** say in their description that the model must summarize and get a clear yes first.
- **Amounts** are kroner in the tools and øre to Fiken. All conversion is in `src/money.ts`.
- **`PUT` replaces the whole object** in Fiken, so tools fetch, merge and write, then read back.
- **User-facing text is Norwegian**: titles, descriptions and error messages.
- **Responses** default to 20 rows, at most 100.
- **Budget**: all tool definitions stay under about 7,200 tokens, which a test enforces (`test/server.test.ts`).

`explore_api` and `read_api` reach other `GET` operations in Fiken through an allowlist generated from the spec (`src/gateway/ops.gen.ts`). Never a free URL, and never anything but `GET`.

## Uploads

`create_upload_link` asks the platform for a one-time link through `issueUploadLink`. The platform serves the upload page, checks the file with `checkUpload` (PDF, PNG, JPG or GIF, at most 10 MB), and sends it with `uploadAttachment(fiken, target, file)` through the user's transport. The link's security is the platform's: see `apps/cloudflare/src/upload.ts`.

## Generated code

Never edit these by hand:

- `src/fiken/types.gen.ts`: types for every path and schema, from `spec/fiken-openapi.yaml` by `openapi-typescript`.
- `src/gateway/ops.gen.ts`: the `GET` allowlist and the amount fields, by `scripts/gen-gateway.ts`.

`pnpm gen:types` regenerates both. `pnpm spec:update` at the repository root fetches Fiken's published spec first. CI fails if the generated files are out of date, and a weekly workflow warns when Fiken publishes a new spec.

## Portability rules

- No Cloudflare imports. ESLint refuses `cloudflare:*`, `@cloudflare/*`, `agents` and `wrangler` in this package.
- Relative imports use the `.ts` extension, and the code uses no enums, namespaces or parameter properties, so it runs with type stripping.

## Tests

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests, no network. |
| `pnpm test:integration` | Against Fiken's test company `fiken-demo-slott-og-fly-as`, with `FIKEN_TEST_TOKEN` from `.dev.vars` at the repository root. The test transports refuse every other company. Write tests clean up after themselves. |
| `FIKEN_DESTRUCTIVE_TESTS=1 pnpm test:integration` | Also books in the test company and annuls afterwards. Each run leaves one credited invoice. |

## Reference implementation

`apps/cloudflare`:

| File | What it does |
| --- | --- |
| `src/index.ts` | OAuth 2.1 for MCP clients with `@cloudflare/workers-oauth-provider`, and the routes. |
| `src/auth/` | The consent flow, Fiken OAuth with PKCE, and the exchange of our tokens for refreshed Fiken tokens. |
| `src/mcp.ts` | Calls `handleMcpRequest` with a transport to the user's queue. |
| `src/queue.ts` | `FikenUserQueue`, a Durable Object per Fiken user that runs `FikenScheduler` and refreshes Fiken tokens single-flight. |
| `src/upload.ts` | One-time upload links and the upload page. |

`docs/HANDOFF.md` (Norwegian) has the decisions behind the design and every behaviour of the Fiken API measured along the way.
