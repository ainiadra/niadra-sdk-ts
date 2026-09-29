// The replay spec's verdict (section 8), as the recorder computes it: the tests' stand-in for the server, run
// against the regression statistics vectors.

const ORDER = ["pass", "flaky", "infrastructure_error", "pin_mismatch", "regression"];

export interface Execution {
  status: "completed" | "pin_mismatch" | "infrastructure_error";
  paraphrase: boolean;
  outcomes: Record<string, "pass" | "fail" | "not_checked">;
}

function comb(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let out = 1n;
  for (let i = 0; i < k; i++) out = (out * BigInt(n - i)) / BigInt(i + 1);
  return out;
}

export function fisher(basePass: number, baseFail: number, passed: number, failed: number): number {
  const total = basePass + baseFail + passed + failed;
  const failures = baseFail + failed;
  const drawn = passed + failed;
  if (failures === 0 || drawn === 0) return 1;
  let tail = 0n;
  for (let x = failed; x <= Math.min(failures, drawn); x++) tail += comb(failures, x) * comb(total - failures, drawn - x);
  return Number(tail) / Number(comb(total, drawn));
}

/** Half to even at six decimal places, as Python's `round` does on the decimal value. */
function round6(value: number): number {
  const scaled = value * 1e6;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return (floor % 2 === 0 ? floor : floor + 1) / 1e6;
  return Math.round(scaled) / 1e6;
}

const rate = (passed: number, failed: number): number => (passed + failed ? passed / (passed + failed) : 1);

export function scenarioVerdict(executions: readonly Execution[], baseline: Record<string, [number, number]> | null): Record<string, unknown> {
  const completed = executions.filter((e) => e.status === "completed");
  const outcomes = new Map<string, string[]>();
  for (const e of completed) for (const [id, outcome] of Object.entries(e.outcomes)) outcomes.set(id, [...(outcomes.get(id) ?? []), outcome]);
  const assertions = [...outcomes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, list]) => {
      const passed = list.filter((o) => o === "pass").length;
      const failed = list.filter((o) => o === "fail").length;
      const [basePass, baseFail] = baseline?.[id] ?? [passed + failed, 0];
      const drop = round6(rate(basePass, baseFail) - rate(passed, failed));
      const pValue = round6(fisher(basePass, baseFail, passed, failed));
      const regression = failed >= 2 && drop >= 0.2 && pValue < 0.05;
      return {
        id,
        passed,
        failed,
        not_checked: list.filter((o) => o === "not_checked").length,
        baseline_passed: basePass,
        baseline_failed: baseFail,
        drop,
        p_value: pValue,
        regression,
        flaky: !regression && failed >= 1,
      };
    });
  const mismatches = executions.filter((e) => e.status === "pin_mismatch").length;
  let verdict = "pass";
  if (mismatches > 0) verdict = "pin_mismatch";
  else if (completed.length === 0) verdict = "infrastructure_error";
  else if (assertions.some((a) => a.regression)) verdict = "regression";
  else if (assertions.some((a) => a.flaky)) verdict = "flaky";
  return {
    verdict,
    completed: completed.length,
    infrastructure_errors: executions.filter((e) => e.status === "infrastructure_error").length,
    pin_mismatches: mismatches,
    needs_paraphrase: assertions.some((a) => a.passed > 0 && a.failed > 0),
    assertions,
  };
}

export function worst(verdicts: readonly string[]): string {
  return verdicts.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "pass");
}
