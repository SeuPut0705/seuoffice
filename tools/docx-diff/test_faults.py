import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("docx_faults", HERE / "faults.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class FaultVerdictTest(unittest.TestCase):
    def run_fault(self, verdict):
        with tempfile.TemporaryDirectory(prefix="docx-fault-verdict-") as directory:
            root = pathlib.Path(directory)
            (root / "tools").mkdir()
            shutil.copyfile(HERE.parent / "fault-shards.mjs", root / "tools/fault-shards.mjs")
            source = root / "value.rs"
            source.write_text("let value = 1;")
            spec = root / "faults.json"
            spec.write_text(json.dumps({"group": "parse", "faults": [{
                "name": "line\nbreak", "file": "value.rs", "old": "= 1", "new": "= 2"
            }]}))
            output = root / "out/faults.txt"

            def compare(_group):
                changed = "= 2" in source.read_text()
                differences = 1 if changed and verdict == "caught" else 0
                checks = 2 if changed and verdict == "set-aside" else 1
                line = f"parse.value checks {checks} differences {differences} key order only 0"
                return "(f) parse\n" + line, [line]

            with patch.multiple(RUNNER, ROOT=root, OUT=output,
                                TIMES=root / "out/faults.json", COSTS=root / "missing-costs.json"), \
                    patch.object(RUNNER, "build", return_value=""), \
                    patch.object(RUNNER, "compare", side_effect=compare), \
                    patch.object(sys, "argv", [str(HERE / "faults.py"), str(spec)]), \
                    patch.dict("os.environ", {"FAULT_SHARD": "0/1"}):
                code = RUNNER.main()
            self.assertEqual(source.read_text(), "let value = 1;")
            return code, output.read_text()

    def test_a_caught_fault_passes_and_a_missed_fault_fails(self):
        for verdict, expected in [("caught", 0), ("missed", 1), ("set-aside", 1)]:
            with self.subTest(verdict=verdict):
                code, output = self.run_fault(verdict)
                self.assertIn("faults 1:", output)
                self.assertEqual(code, expected)


if __name__ == "__main__":
    unittest.main()
