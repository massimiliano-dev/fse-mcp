# @massimiliano-dev/fse-mcp

## 0.1.0

### Minor Changes

- f750551: First release: an MCP server that explains why the FSE 2.0 gateway rejects a CDA2 document, over stdio or
  token-protected Streamable HTTP. Requires Node.js 22.19 or later.
  
  - `validate_cda`: pre-flight guard (DOCTYPE, ENTITY and XInclude refused), then real XSD validation against the official
    it-fse-catalogs files at the pinned commit, shipped inside the optional peer dependency
    `@massimiliano-dev/fse-validator` (nothing to download). When the XSD passes, the schematron of the document type runs, as on the
    gateway, if the optional `saxon-js` (proprietary Saxonica licence, never installed by default) and a compiled
    schematron are available: today only for the referto di laboratorio. The `checks` field says which levels ran;
    missing pieces give `validator_unavailable` or a skipped level, never a silent pass. Configure with
    `FSE_MCP_CATALOGS_DIR` and `FSE_MCP_SCHEMATRON_DIR`.
  - `generate_sample_cda`: synthetic skeletons for four document types. The referto di laboratorio passes XSD and
    `schematronFSE_LAB_v27.1` as generated; the other three are unverified.
  - `explain_schematron_error` (five hand-written examples) and `lookup_code` (sample dictionaries).
  
  Not included yet: terminology checks against the national dictionaries, schematrons for the other 21 document
  types, complete dictionaries. Passing locally does not guarantee acceptance by the gateway.
