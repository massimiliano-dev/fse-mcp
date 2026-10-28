# fse-mcp

An MCP server that helps developers find out **why the FSE 2.0 gateway rejects a CDA2 document**.

[![CI](https://github.com/massimiliano-dev/fse-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/massimiliano-dev/fse-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Unofficial.** Not affiliated with, endorsed by or connected to the Italian Ministry of Health, Sogei, AgID,
> the regions or any FSE operator. FSE rules change: the official specifications and
> [it-fse-catalogs](https://github.com/ministero-salute/it-fse-catalogs) are the reference.

> **Passing XSD and schematron locally does not guarantee that the gateway accepts a document**: the gateway
> also checks codes against the national terminology dictionaries, and this server does not.

Integrating with the Fascicolo Sanitario Elettronico 2.0 gateway means sending HL7 CDA R2 documents that are
checked against XSD schemas, a schematron per document type and the national dictionaries. When a document is
refused, the response is an Italian rule message such as `ERRORE-4| Almeno un elemento 'templateId' DEVE ...`
and the fix is buried in an implementation guide. This server puts that knowledge next to your MCP client
(Claude Desktop, Claude Code, an IDE) so you can ask "why was this rejected and what do I change?".

It is **not** another generic open-data wrapper: it does not proxy any public API and makes no network calls.
It targets one pain point, rejected documents, and runs entirely on your machine.

> Status: early (0.x). See [what is real today](#status) before relying on it.

## Tools

| Tool                       | What it does                                                                                                                                                                                                                                                                                    | Example prompt                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `validate_cda`             | Checks a CDA2 document locally (max 2 MiB): refuses DTDs, entities and XInclude, then validates against the CDA XSD and, when the XSD passes, the schematron of the document type, in the gateway's order. The `checks` field says which levels ran. See [validation setup](#validation-setup). | "Validate this synthetic lab report and tell me what the gateway will reject."       |
| `explain_schematron_error` | Explains a gateway XSD/schematron error in plain language, with the official message and a fix.                                                                                                                                                                                                 | "The gateway answered `ERRORE-28` for my referto di laboratorio. What does it want?" |
| `lookup_code`              | Looks up a code or searches display names in LOINC, ICD9-CM, ATC, AIC and HL7 AdministrativeGender, returning the `@codeSystem` OID.                                                                                                                                                            | "What is the LOINC code and code system OID for a laboratory report?"                |
| `generate_sample_cda`      | Returns a **synthetic** CDA2 skeleton (lab report, discharge letter, radiology report, ER report) with fictional patient and doctor data. The lab report skeleton passes XSD and schematron.                                                                                                    | "Give me a synthetic referto di laboratorio skeleton I can use as a test fixture."   |

All tools are annotated read-only, idempotent and closed-world, have JSON input and output schemas, and
size-limit every input.

### Status

| Part                                | State                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transports (stdio, Streamable HTTP) | Real, with token auth and DNS rebinding protection.                                                                                                                                                                                                                                       |
| Pre-flight XML guard                | Real: refuses DOCTYPE, ENTITY, XInclude; checks the `ClinicalDocument` root and HL7 v3 namespace; ignores stylesheets and schemaLocation.                                                                                                                                                 |
| `validate_cda` XSD                  | Real: CDA XSD from it-fse-catalogs at the pinned commit, with libxml2 compiled to WebAssembly (`@massimiliano-dev/fse-validator`, optional). Without the package or the catalogs the result is `validator_unavailable`.                                                                   |
| `validate_cda` schematron           | Real, but only where it can run: needs the optional `saxon-js` and a compiled schematron for the document type. Compiled today: **referto di laboratorio only** (`schematronFSE_LAB_v27.1`). Elsewhere `checks.schematron` says why it was skipped.                                       |
| Terminology checks                  | **Not done.** The gateway checks codes against the national dictionaries; this server does not.                                                                                                                                                                                           |
| `explain_schematron_error` rules    | **Examples**: five hand-written entries (laboratory report schematron v27.1 plus one XSD error).                                                                                                                                                                                          |
| `lookup_code` dictionaries          | **Sample**: a few dozen codes copied from it-fse-catalogs. A missing code does not mean it is invalid.                                                                                                                                                                                    |
| `generate_sample_cda`               | Referto di laboratorio: passes XSD and `schematronFSE_LAB_v27.1` as generated (asserted by the tests). Other types: national templateId roots and LOINC codes verified, the documents themselves **unverified** (no compiled schematron). `templateId/@extension` values still to verify. |
| [Agensi skill](#agensi-skill)       | A packaged triage workflow with reference tables generated from it-fse-catalogs; not part of the npm package.                                                                                                                                                                             |

## Install

Requires Node.js 22.19 or later. Without the optional packages below, `validate_cda` only runs the pre-flight
checks and says so: see [validation setup](#validation-setup).

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

## Validation setup

`validate_cda` validates offline against local copies of the official rules. Each piece is optional; whatever
is missing is reported in the result (`status: "validator_unavailable"`, or a `checks` level other than `run`)
instead of failing.

| Piece                             | What it enables                         | How                                                                                                                                                                                      |
| --------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@massimiliano-dev/fse-validator` | XSD (and the schematron engine wrapper) | Optional peer dependency. **Not on npm yet**: today it is linked from a local [fse-client](https://github.com/massimiliano-dev/fse-client) checkout (`packages/validator`).              |
| it-fse-catalogs checkout          | XSD                                     | `pnpm sync:catalogs` in fse-client, at the commit pinned by the validator (`d8c766a…`; another commit is refused). Point `FSE_MCP_CATALOGS_DIR` at it.                                   |
| Compiled schematrons              | Schematron                              | One `<name>.sef.json` per schematron, made with `pnpm compile:schematron` in fse-client. Point `FSE_MCP_SCHEMATRON_DIR` at the folder. Only `schematronFSE_LAB_v27.1` is compiled today. |
| `saxon-js`                        | Schematron                              | Optional peer dependency, `^2.7.0`. It has a **proprietary licence from Saxonica** (SaxonJS License), so it is never installed by default: read the licence, then add it yourself.       |

Environment variables:

- `FSE_MCP_CATALOGS_DIR`: the it-fse-catalogs checkout (the folder with the `.fse-catalogs-commit` marker).
  Default: `fse-client/vendor/it-fse-catalogs` in the folder that contains this repository.
- `FSE_MCP_SCHEMATRON_DIR`: the folder of compiled schematrons. Default: `fse-client/vendor/schematron-sef` in
  the same parent folder.

The defaults only make sense for a development clone next to fse-client; anywhere else set both variables, for
example `claude mcp add fse -e FSE_MCP_CATALOGS_DIR=/path/to/it-fse-catalogs -e FSE_MCP_SCHEMATRON_DIR=/path/to/schematron-sef -- npx -y @massimiliano-dev/fse-mcp`.

How a result reads:

- Levels run in the gateway's order: XSD, then schematron only if the XSD passes (`not_run_xsd_failed`
  otherwise).
- The schematron is chosen from the LOINC code in `ClinicalDocument/code` for the four document types of
  `generate_sample_cda`; any other code gives `skipped_unknown_document_type`, never a guess.
- `skipped_saxon_missing`, `skipped_schematron_missing` and `skipped_catalogs_missing` mean the level did not run,
  so the absence of issues says nothing about it. `status: "valid"` is about the levels that ran.

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

## Agensi skill

[`skill/fse-cda-triage/`](skill/fse-cda-triage/) is a skill package for [Agensi](https://agensi.io): a
`SKILL.md` that teaches an agent how to triage a gateway rejection, plus reference tables generated from
it-fse-catalogs (the laboratory report rules, the document types, the code systems). It ships no code and makes
no network calls; full validation is left to this server. It is not part of the npm package.
[`skill/LISTING.md`](skill/LISTING.md) is the draft for the submission form.

```bash
pnpm skill:references            # regenerate skill/fse-cda-triage/references/ from FSE_MCP_CATALOGS_DIR
pnpm skill:references --check    # exit 1 if the committed references differ from the catalogs
pnpm skill:zip                   # check the SKILL.md frontmatter, write skill/dist/fse-cda-triage.zip
```

Regenerate the references whenever the catalogs commit changes; the tests fail if they are out of date (and are
skipped when no catalogs checkout is available).

## Roadmap

What is still missing, in order of impact:

1. **Schematrons for the other 21 document types**: compile them, test them against synthetic documents, and
   verify the matching `generate_sample_cda` skeletons. Only the laboratory report is covered today.
2. **Terminology checks**: the gateway validates codes against the national dictionaries; this server does not,
   so a document that passes locally can still be rejected.
3. **Complete dictionaries** for `lookup_code`, generated from a pinned it-fse-catalogs commit instead of the
   current samples.
4. Explanations for the most common rejections of every document type, not only the laboratory report.
5. Resources with the official schematron text per document type.

## Licence and third-party content

MIT, see [LICENSE](LICENSE). Sample codes and schematron messages are taken from
[it-fse-catalogs](https://github.com/ministero-salute/it-fse-catalogs). `saxon-js` is not bundled or
redistributed: if you install it, you accept Saxonica's licence.

This material contains content from LOINC (http://loinc.org). LOINC is copyright © 1995-2023, Regenstrief
Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and is available at no
cost under the license at http://loinc.org/license. LOINC® is a registered United States trademark of
Regenstrief Institute, Inc.
