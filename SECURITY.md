# Security policy

Fiken MCP connects AI assistants to accounting data, so we take reports of security problems seriously.

## Reporting a vulnerability

E-mail **kontakt@wollums.no** with "Security" in the subject. Please do not open a public GitHub issue for a security problem.

Include:

- what the problem is, and what an attacker could do with it
- the steps to reproduce it
- the affected route, tool or file, and the commit if you tested a copy of your own

Do not send real accounting data, tokens or passwords. If something like that was exposed, describe it without copying it.

## Scope

- The hosted service at `https://fiken.mcp.wollums.no`.
- The code in this repository, on the `main` branch.

The Fiken API itself belongs to Fiken AS. Report problems there to Fiken.

## Testing safely

- Use your own Fiken account and a test company. Fiken explains how to create one in the introduction to their API documentation.
- Never access, change or delete data that is not yours, and stop as soon as you reach someone else's data.
- Do not run load or denial-of-service tests. Fiken limits each user to one concurrent request and may ban users who break that rule.

Give us a reasonable time to fix the problem before you disclose it.
