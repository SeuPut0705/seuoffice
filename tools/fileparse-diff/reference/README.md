# The frozen TypeScript readers

packages/file-parse/src as it was at e7e4d38290cceae7185f9d9a5e75f915f7c9ade6, copied by tools/fileparse-diff/freeze-reference.mjs
(package names as the internal rename writes them; @seuoffice/docx-engine is tools/docx-diff/reference).
The gate (tools/fileparse-diff) imports this copy, never packages/file-parse/src, which holds the
binding over the wasm engine. Do not edit these files.
