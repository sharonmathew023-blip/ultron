// ULTRON workspace manager: pairing, ownership and short-lived access tokens.
// A workspace is registered explicitly by its owner, then paired with a one-time code.
// Tokens are stored hashed; the plain token exists only in the pairing response.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

export const WORKSPACE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function createWorkspaceManager({
  now = () => Date.now(),
  newId = () => "ws_" + randomBytes(8).toString("hex"),
  newToken = () => randomBytes(32).toString("base64url"),
  newCode = () => randomBytes(4).toString("hex").toUpperCase(),
} = {}) {
  const workspaces = new Map();
  const byToken = new Map();

  // Registers a root and returns the pairing code the user types into ULTRON.
  function register({ root, owner, label }) {
    if (typeof root !== "string" || !root.trim()) return { ok: false, error: "A workspace root is required." };
    if (typeof owner !== "string" || !owner.trim()) return { ok: false, error: "A workspace owner is required." };
    const absoluteRoot = path.resolve(root);
    const workspaceId = newId();
    const code = newCode();
    const workspace = {
      id: workspaceId,
      root: absoluteRoot,
      owner: owner.trim(),
      label: typeof label === "string" ? label.slice(0, 80) : path.basename(absoluteRoot),
      createdAt: now(),
      pairingCodeHash: hashToken(code),
      pairingExpiresAt: now() + PAIRING_CODE_TTL_MS,
      network: "disabled-by-default",
      tokens: new Set(),
    };
    workspaces.set(workspaceId, workspace);
    return { ok: true, workspaceId, pairingCode: code, root: absoluteRoot, expiresAt: workspace.pairingExpiresAt };
  }

  // Exchanges the one-time code for a token. The code is invalidated immediately.
  function pair({ workspaceId, code, owner }) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) return { ok: false, error: "Unknown workspace." };
    if (typeof code !== "string" || !code) return { ok: false, error: "A pairing code is required." };
    if (workspace.pairingExpiresAt <= now()) return { ok: false, error: "Pairing code expired. Register the workspace again." };
    if (!safeEqualHex(hashToken(code), workspace.pairingCodeHash)) return { ok: false, error: "Invalid pairing code." };
    if (typeof owner === "string" && owner.trim() && owner.trim() !== workspace.owner) {
      return { ok: false, error: "Workspace belongs to another account." };
    }
    workspace.pairingCodeHash = null;
    workspace.pairingExpiresAt = 0;
    const token = newToken();
    const tokenHash = hashToken(token);
    workspace.tokens.add(tokenHash);
    byToken.set(tokenHash, { workspaceId: workspace.id, owner: workspace.owner, expiresAt: now() + WORKSPACE_TOKEN_TTL_MS });
    return { ok: true, workspaceId: workspace.id, token, expiresAt: now() + WORKSPACE_TOKEN_TTL_MS };
  }

  // Token -> workspace, or an error. Never leaks whether a workspace exists.
  function authorize(token) {
    const entry = byToken.get(hashToken(token === undefined || token === null ? "" : token));
    if (!entry) return { ok: false, error: "Invalid workspace token." };
    if (entry.expiresAt <= now()) {
      byToken.delete(hashToken(token));
      return { ok: false, error: "Workspace token expired." };
    }
    const workspace = workspaces.get(entry.workspaceId);
    if (!workspace) return { ok: false, error: "Invalid workspace token." };
    return { ok: true, workspace: { id: workspace.id, root: workspace.root, owner: workspace.owner, label: workspace.label, network: workspace.network } };
  }

  function revoke(token) {
    const tokenHash = hashToken(token === undefined || token === null ? "" : token);
    const entry = byToken.get(tokenHash);
    if (!entry) return { ok: false, error: "Invalid workspace token." };
    byToken.delete(tokenHash);
    const workspace = workspaces.get(entry.workspaceId);
    if (workspace) workspace.tokens.delete(tokenHash);
    return { ok: true };
  }

  function listForOwner(owner) {
    return [...workspaces.values()]
      .filter((workspace) => workspace.owner === owner)
      .map((workspace) => ({
        id: workspace.id,
        label: workspace.label,
        root: workspace.root,
        owner: workspace.owner,
        paired: workspace.tokens.size > 0,
        createdAt: workspace.createdAt,
      }));
  }

  return Object.freeze({ register, pair, authorize, revoke, listForOwner });
}
