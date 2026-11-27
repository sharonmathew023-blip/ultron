# Code review

Use when the user asks for a review, or before calling work finished.

Steps:
1. Read the diff, not the whole repository. `git.diff` is enough.
2. For each changed file, check: correctness, error handling, security, and tests.
3. Look for secrets, weakened authorization, and new public API surface.
4. Report findings as `file:line`, severity, and a one-line reason.

Never rewrite the code during a review unless the user asks for fixes.

Findings worth blocking on:
- Credentials or provider keys in browser code, logs, fixtures or URLs.
- A path that can escape the workspace or read a protected file.
- A command that reaches a shell or bypasses the command policy.
- A permission check that trusts the browser or the model.
- A test that asserts nothing, or a check reported as passing when it did not run.

Finish with: what was reviewed, what was verified, and what was not run.
