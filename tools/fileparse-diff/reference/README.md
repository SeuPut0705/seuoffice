# The frozen TypeScript readers

packages/file-parse/src as it was at 8b9fd99ea498038723d924377a0f8f674418eff1, copied by tools/fileparse-diff/freeze-reference.mjs
(package names as the internal rename writes them; @seuoffice/docx-engine is tools/docx-diff/reference).
The gate (tools/fileparse-diff) imports this copy, never packages/file-parse/src, which holds the
binding over the wasm engine. Do not edit these files.
