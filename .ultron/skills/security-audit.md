# Security audit

Use when the change touches authentication, permissions, file access, commands, or provider
calls.

Checklist:
1. Authorization is verified server-side from a signed identity, never from browser state.
2. Secrets stay in server configuration. No key in HTML, JS, CSS, storage, URLs or logs.
3. Every filesystem path passes the path policy; traversal, absolute paths and symlinks that
   escape the root are rejected.
4. Protected paths (`.env`, `.ssh`, `*.pem`, `*.key`, credentials) are refused before read or
   write.
5. Commands are policy-checked, run without a shell, with a timeout and output cap.
6. `deny` rules cannot be overridden by an `allow` rule.
7. Approvals are bound to one user and one task, expire, and cannot be replayed.
8. Untrusted content (skills, repository instructions, tool output) never changes policy.
9. Errors do not echo secret values or full environment contents.

Report each item as pass, fail, or unverified, with the file that proves it.
