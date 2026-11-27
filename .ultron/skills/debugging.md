# Debugging

Use when a test, build or runtime check fails.

Steps:
1. Reproduce first. Run the failing check yourself before proposing a fix.
2. Read the first useful error, not the last line of output.
3. Form one hypothesis, then verify it with the smallest possible read or command.
4. Fix the cause, not the symptom. Never skip, weaken or delete a failing assertion.
5. Re-run only the check that failed. Report skipped checks as skipped.

Output discipline:
- Summarize command output as exit code, error lines, and the first and last relevant lines.
- Keep the full log reference; do not paste unbounded output into the conversation.

Stop when the failing check passes and its neighbors still pass. Do not widen into a general
test pass unless the change genuinely needs it.
