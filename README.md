# fse-mcp

An MCP server that helps developers find out **why the FSE 2.0 gateway rejects a CDA2 document**.

[![CI](https://github.com/massimiliano-dev/fse-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/massimiliano-dev/fse-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Unofficial.** Not affiliated with, endorsed by or connected to the Italian Ministry of Health, Sogei, AgID,
> the regions or any FSE operator. FSE rules change: the official specifications and
> [it-fse-catalogs](https://github.com/ministero-salute/it-fse-catalogs) are the reference.

Integrating with the Fascicolo Sanitario Elettronico 2.0 gateway means sending HL7 CDA R2 documents that are
checked against XSD schemas, a schematron per document type and the national dictionaries. When a document is
refused, the response is an Italian rule message such as `ERRORE-4| Almeno un elemento 'templateId' DEVE ...`
and the fix is buried in an implementation guide. This server puts that knowledge next to your MCP client
(Claude Desktop, Claude Code, an IDE) so you can ask "why was this rejected and what do I change?".

It is **not** another generic open-data wrapper: it does not proxy any public API and makes no network calls.
It targets one pain point, rejected documents, and runs entirely on your machine.

> Status: early scaffold (0.x). See [what is real today](#status) before relying on it.

## Tools

| Tool                       | What it does                                                                                                                              | Example prompt                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `validate_cda`             | Checks a CDA2 document locally (max 2 MiB). Refuses DTDs, entities and XInclude. Full XSD/schematron validation is on the roadmap.        | "Validate this synthetic lab report and tell me what the gateway will reject."       |
| `explain_schematron_error` | Explains a gateway XSD/schematron error in plain language, with the official message and a fix.                                           | "The gateway answered `ERRORE-28` for my referto di laboratorio. What does it want?" |
| `lookup_code`              | Looks up a code or searches display names in LOINC, ICD9-CM, ATC, AIC and HL7 AdministrativeGender, returning the `@codeSystem` OID.      | "What is the LOINC code and code system OID for a laboratory report?"                |
| `generate_sample_cda`      | Returns a **synthetic** CDA2 skeleton (lab report, discharge letter, radiology report, ER report) with fictional patient and doctor data. | "Give me a synthetic referto di laboratorio skeleton I can use as a test fixture."   |

All tools are annotated read-only, idempotent and closed-world, have JSON input and output schemas, and
size-limit every input.

### Status

| Part                                | State                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Transports (stdio, Streamable HTTP) | Real, with token auth and DNS rebinding protection.                                                                                       |
| Pre-flight XML guard                | Real: refuses DOCTYPE, ENTITY, XInclude; checks the `ClinicalDocument` root and HL7 v3 namespace; ignores stylesheets and schemaLocation. |
| `validate_cda` full validation      | **Stub**: reports `not_implemented` after the pre-flight checks. Will use the validator from the `fse-client` project.                    |
| `explain_schematron_error` rules    | **Examples**: five hand-written entries (laboratory report schematron v27.1 plus one XSD error).                                          |
| `lookup_code` dictionaries          | **Sample**: a few dozen codes copied from it-fse-catalogs. A missing code does not mean it is invalid.                                    |
| `generate_sample_cda`               | Real skeletons with verified national templateId roots and LOINC codes; `templateId/@extension` values still to verify.                   |

## Install

Requires Node.js 22.18 or later.

### Claude Code

```bash
claude mcp add fse -- npx -y @massimiliano-dev/fse-mcp
```

or commit a project-scoped `.mcp.json` like [examples/claude-code.mcp.json](examples/claude-code.mcp.json):

```json
{
  "mcpServers": {
    "fse": { "type": "stdio", "command": "npx", "args": ["-y", "@massimiliano-dev/fse-mcp"] }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (see [examples/claude-desktop.json](examples/claude-desktop.json)):

```json
{
  "mcpServers": {
    "fse": { "command": "npx", "args": ["-y", "@massimiliano-dev/fse-mcp"] }
  }
}
```

Pin a version (`@massimiliano-dev/fse-mcp@0.1.0`) if you want upgrades to be deliberate.

## HTTP mode

stdio is the default and the safest choice: only the client that started the process can talk to it. For
clients that need HTTP:

```bash
export FSE_MCP_TOKEN="$(openssl rand -hex 32)"
npx -y @massimiliano-dev/fse-mcp --http            # http://127.0.0.1:3333/mcp
```

Clients send `Authorization: Bearer $FSE_MCP_TOKEN`. Security properties:

- **Loopback only by default.** Binding elsewhere (`--host 0.0.0.0`) is refused unless you also pass
  `--allowed-host <name>`; put a TLS-terminating reverse proxy in front, never expose plain HTTP.
- **Token required.** The server refuses to start without `FSE_MCP_TOKEN` (32+ characters). It is compared in
  constant time, removed from the process environment after start-up and redacted from logs.
- **DNS rebinding protection.** `Host` and `Origin` must be an allowed hostname (`localhost`, `127.0.0.1`,
  `[::1]` by default), checked before authentication, plus the SDK's own host check.
- **No CORS.** No `Access-Control-*` headers are sent, so web pages on other origins cannot read responses.
- **Bounded requests.** 5 MiB body limit (413), header and request timeouts, stateless mode with POST only.

Options: `--host`, `--port` (default 3333), `--allowed-host` (repeatable), `--log-level`. Run `fse-mcp --help`.

## Data protection

- **Never paste real patient documents into a hosted LLM.** A CDA2 document is health data under GDPR art. 9.
  The MCP server runs locally, but whatever the model reads is sent to the model provider. Use the output of
  `generate_sample_cda` or documents you anonymised yourself.
- The server makes no outbound network calls and stores nothing. Logs go to stderr only, never include tool
  inputs, and redact codici fiscali, STP/ENI codes, JWTs and bearer tokens as a safety net.
- Text returned from a submitted document is labelled as untrusted data. A document can contain prompt
  injection ("ignore previous instructions..."); your client should treat tool output as data.

See [SECURITY.md](SECURITY.md) for the threat model.

## Development

```bash
pnpm install
pnpm test            # unit tests, including the HTTP security checks
pnpm lint && pnpm typecheck && pnpm format:check
pnpm build
pnpm inspect         # opens the MCP Inspector against the built server
```

## Roadmap

1. **Wire the real validator**: implement `CdaValidatorPort` with `@massimiliano-dev/fse-validator` from the
   `fse-client` project (offline XSD + schematron, hardened parser, timeout).
2. **Derive the data from it-fse-catalogs**: generate the schematron rule table and the dictionaries at build
   time from a pinned commit, ship them in the package, keep explanations hand-written.
3. Explanations for the most common rejections of every document type, not only the laboratory report.
4. Resources with the official schematron text per document type.

## Licence and third-party content

MIT, see [LICENSE](LICENSE). Sample codes and schematron messages are taken from
[it-fse-catalogs](https://github.com/ministero-salute/it-fse-catalogs).

This material contains content from LOINC (http://loinc.org). LOINC is copyright © 1995-2023, Regenstrief
Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and is available at no
cost under the license at http://loinc.org/license. LOINC® is a registered United States trademark of
Regenstrief Institute, Inc.
