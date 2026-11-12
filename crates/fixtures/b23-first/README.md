The first comparison of batches B2 (read side) and B3 (write side), unedited.

- gate.txt: runner 43219862506 on 50407c9f7. The wasm ran out of memory in
  packageAfterCorpus after 80 minutes, before any summary was printed.
- local-reduced.txt: the gate on Windows at f517e6f1b plus the two gate fixes
  of the commit that adds this file, with reduced counts: `main.ts
  --by-function --show 20 --fuzz 2000 --container-fuzz 300 --part-fuzz 150
  --props-fuzz 400 --numbers 2000 --call-fuzz 30 --call-arg-fuzz 150`. The
  floors are the full run's, so "BELOW FLOOR" there says nothing.
- model-full.txt: `model-full.ts --show 20` on Windows, the first run of the
  (h) parseDocx and (i) saveDocx comparisons, with the inserted heading's link
  fixed to `{ href }` (a string made the TypeScript saveDocx throw). Some
  fixer edits of the parse side may already have been built into the wasm.
