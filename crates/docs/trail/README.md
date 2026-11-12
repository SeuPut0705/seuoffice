# Trail of unit 2

The record of the unit that ported `resolve-props.ts` and the leaves without
model types (2026-11-12), kept in the tree so that it depends neither on the
retention of GitHub artifacts nor on one machine.

- `decisions.tsv`: the decisions of the session as it took them, one a row:
  time, phase, decision, why, evidence, result. Rows are appended, never edited;
  a later row corrects an earlier one.
- The files below are outputs as they were written, compressed with `gzip -n`.
  Nothing in them was edited. The SHA-256 is of the uncompressed file.

| file (`.gz`)                         | SHA-256                                                            | what it is                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve-first-local-048754e6b.txt`  | `74ebf1a0a831611572e823c7c819e35f0dc2112366f7061c9373817c49db9892` | First comparison of group `resolve` (resolve-props.ts), before any fix, on 048754e6b. Run on the workstation, before first comparisons moved to runners: 24,840 checks, 0 differences, 0 key-order places, 13 functions.                                            |
| `resolve-gate-run-43149479120.log`   | `cb4a5a2810c6fcb490a6f6c6ea7a765f2badc489486dc0ee300a611cf12fbc34` | The gate step of runner run 43149479120 on 6e28d6fdd, the first runner gate with the resolver: 1,692,526 checks, 0 differences. The run kept no artifact (the job did not write the gate output to a file yet): this is its log.                                    |
| `leaves-first-run-43151626477.txt`   | `df2e98cd926d12077a6fa0040138704cdb61779ab8fd952078369a50589794b7` | First comparison of the seven leaf groups, before any fix, runner run 43151626477 on 177d43b3d (artifact `docx-diff-out`, `gate.txt`): 28,741 checks in those groups, 12 differences, all legacy charsets on Node.                                                  |
| `icase-first-run-43152727453.txt`    | `096076c27411920f27107cdd10e03b6f05c8ffaf321315f2429688de2ffe45e3` | First run with inputs holding U+0131, U+017F and U+212A, runner run 43152727453 on 2f5aca170: 679 differing checks from the case folding of `jscompat`, before stream D fixed it.                                                                                   |
| `faults-resolve-local.txt`           | `f0096eaf57c27ebdfe85ce4da9beaaba6e42b04be5d55dad176f231429b296ba` | Faults in the resolver, the 11 run on the workstation before the load rule: 10 caught, 1 missed.                                                                                                                                                                    |
| `faults-resolve-run-43151191515.txt` | `cf84f96fe6e3732c4e664b28526d0bfc48c00ece4c6841050f00a6cd3501b193` | Faults in the resolver, the other 19 (one of them the miss above again): 13 caught, 6 missed.                                                                                                                                                                       |
| `faults-leaves-run-43153584303.txt`  | `d097b2e41fee5db1d93fe02035106ec0e85a9d9db76d05ad04b62a0c5db5eb38` | Faults in the leaf groups, 43, and three of the resolver again: verdicts by the first rule of `faults.py`, under which the fault `altchunk head 4096 cap dropped` reads caught though it showed no new difference.                                                  |
| `faults-leaves-run-43157250362.txt`  | `a32524be3171a3e04ff0916783f0ca329df8dc564d39db50d9ad85d5042f6fef` | Four leaf faults again after inputs were added: 4 caught.                                                                                                                                                                                                           |
| `faults-classes-run-43161902762.txt` | `c85504e530cd4f5ac28cc2b0077503d0afa39f38bf6036c59d476fa93aa036db` | The 22 faults of the groups with listed classes (altchunk, revision, vml) again, by the second rule of `faults.py` (caught only when a function shows more differences): 18 caught, 4 missed, among them two that a class hides or that the Rust no longer reaches. |

Read one with `gzip -dc <file>`. What these records were used to claim is in
`crates/README.md`, "What was done last".
