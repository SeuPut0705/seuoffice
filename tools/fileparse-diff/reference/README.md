# The frozen TypeScript readers

packages/file-parse/src as it was at 8a92e8544e5cf5ba5fb8548d9aa88ba6a4c2be57, copied by tools/fileparse-diff/freeze-reference.mjs
(package names as the internal rename writes them; @seuoffice/docx-engine is tools/docx-diff/reference).
The gate (tools/fileparse-diff) imports this copy, never packages/file-parse/src, which holds the
binding over the wasm engine. Do not edit these files.
