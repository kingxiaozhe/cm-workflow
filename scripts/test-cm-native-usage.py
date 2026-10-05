#!/usr/bin/env python3
"""Local native usage accounting fixture. Synthetic logs only; no providers."""
import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("native_usage_report", Path(__file__).with_name("cm-usage-report.py"))
reporter = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = reporter
spec.loader.exec_module(reporter)

class NativeUsage(unittest.TestCase):
    def report(self, usages):
        with tempfile.TemporaryDirectory(prefix="cm-native-usage-") as directory:
            root = Path(directory).resolve()
            now = datetime.datetime.now(datetime.timezone.utc)
            ref = reporter.RunRef("native-fixture-run", "cm-ai", "fixture", "done", now, now.isoformat(), "events.jsonl")
            rows = []
            for index, usage in enumerate(usages):
                common = {"workflow": "cm-ai", "runtime": "codex", "stage": "review", "role": "reviewer",
                          "adapter": "codex-cli", "requested_model": "fixture", "source": "native-cli-terminal",
                          "purpose": "workflow-execution", "run_id": ref.run_id, "call_id": "call-" + str(index)}
                claim = {**common, "event": "model_call", "phase": "claimed"}
                row = {**common, "event": "model_usage", "phase": "complete", "outcome": "success", **usage}
                rows.extend([claim, row, row])  # Exact repeated log bytes must not add tokens.
            (root / "events.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
            with contextlib.redirect_stderr(io.StringIO()):
                return reporter.build_report(root, [ref])

    def test_subsets_not_added_and_missing_components_are_null(self):
        result = self.report([{"usage_state": "observed", "input_tokens": 100, "output_tokens": 20,
                               "cache_read_tokens": 70, "reasoning_tokens": 5},
                              {"usage_state": "observed", "input_tokens": 10, "output_tokens": 2},
                              {"usage_state": "unavailable"}])
        self.assertEqual(result["summary"]["input_tokens"], 110)
        self.assertEqual(result["summary"]["output_tokens"], 22)
        self.assertEqual(result["summary"]["observed_calls"], 2)
        self.assertEqual(result["summary"]["unavailable_calls"], 1)
        fields = result["native_components"]["fields"]
        self.assertEqual(fields["reasoning_tokens"], {"tokens": 5, "observed_calls": 1, "unavailable_calls": 2})
        self.assertEqual(fields["cache_write_tokens"]["tokens"], None)
        self.assertEqual(fields["cache_write_tokens"]["unavailable_calls"], 3)

    def test_bad_reasoning_subset_and_unavailable_counts_are_rejected(self):
        result = self.report([{"usage_state": "observed", "input_tokens": 1, "output_tokens": 2, "reasoning_tokens": 3},
                              {"usage_state": "unavailable", "reasoning_tokens": 0}])
        self.assertEqual(result["summary"]["observed_calls"], 0)
        self.assertNotIn("native_components", result)

    def test_unknown_reasoning_is_not_inferred_from_output(self):
        result = self.report([{"usage_state": "observed", "input_tokens": 100, "output_tokens": 20}])
        self.assertEqual(result["native_components"]["fields"]["reasoning_tokens"]["tokens"], None)
        self.assertEqual(result["native_components"]["fields"]["cache_read_tokens"]["tokens"], None)

if __name__ == "__main__":
    unittest.main()
