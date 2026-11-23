// ULTRON Device Intelligence: validated tool registry (read-only, stage 1).
// Pure code: no network, no storage, no secrets. The Worker, the Durable Object and the
// Python bridge all agree on this contract.
//
// Rules this file enforces:
//  - The model can only name a tool from DEVICE_TOOLS. It never writes a command.
//  - Every v1 tool takes zero arguments, so there is nothing to inject.
//  - Device output is untrusted. validateDeviceToolResult() rebuilds a clean object from
//    known fields only, so stray text from a device never reaches the model or the UI.
//  - Findings and the report headline are computed here, not by the model.

export const DEVICE_PROTOCOL_VERSION = 1;

const SAFE_TEXT = /^[A-Za-z0-9 ._+\-()\/:]{1,64}$/;

const int = (min, max) => ({ kind: "int", min, max });
const num = (min, max) => ({ kind: "num", min, max });
const text = () => ({ kind: "text" });
const oneOf = (...values) => ({ kind: "enum", values });

const MB = 1_000_000;

// Every field is required but nullable: null means "this device did not report it".
export const DEVICE_TOOLS = Object.freeze({
  device_info: Object.freeze({
    description: "Read basic device identity: manufacturer, model, Android version, build and security patch.",
    risk: "read",
    fields: Object.freeze({
      manufacturer: text(), brand: text(), model: text(), androidVersion: text(),
      sdkLevel: int(1, 99), buildId: text(), securityPatch: text(), cpuAbi: text(), serialSuffix: text(),
    }),
  }),
  cpu: Object.freeze({
    description: "Read CPU core count, hardware name, architecture and recent load averages.",
    risk: "read",
    fields: Object.freeze({
      cores: int(1, 256), hardware: text(), abi: text(), maxFreqMhz: int(0, 10_000),
      loadAvg1m: num(0, 10_000), loadAvg5m: num(0, 10_000), loadAvg15m: num(0, 10_000),
    }),
  }),
  memory: Object.freeze({
    description: "Read RAM and swap totals and how much RAM is available right now.",
    risk: "read",
    fields: Object.freeze({
      totalMb: int(0, MB), availableMb: int(0, MB), usedPercent: num(0, 100),
      swapTotalMb: int(0, MB), swapFreeMb: int(0, MB),
    }),
  }),
  storage: Object.freeze({
    description: "Read internal storage (user data partition) total, used and free space.",
    risk: "read",
    fields: Object.freeze({ totalMb: int(0, MB * 10), usedMb: int(0, MB * 10), freeMb: int(0, MB * 10), usedPercent: num(0, 100) }),
  }),
  battery: Object.freeze({
    description: "Read battery level, charging state, health, temperature and voltage.",
    risk: "read",
    fields: Object.freeze({
      levelPercent: int(0, 100),
      status: oneOf("unknown", "charging", "discharging", "not_charging", "full"),
      health: oneOf("unknown", "good", "overheat", "dead", "over_voltage", "failure", "cold"),
      power: oneOf("none", "ac", "usb", "wireless"),
      temperatureC: num(-40, 150), voltageMv: int(0, 20_000),
    }),
  }),
});

export const DIAGNOSTIC_BUNDLE = Object.freeze(["device_info", "cpu", "memory", "storage", "battery"]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function isDeviceTool(name) {
  return typeof name === "string" && hasOwn(DEVICE_TOOLS, name);
}

export function isReadOnlyDeviceTool(name) {
  return isDeviceTool(name) && DEVICE_TOOLS[name].risk === "read";
}

// Checks one model-requested call. Every v1 tool takes no arguments.
export function validateDeviceToolCall(name, args) {
  if (!isDeviceTool(name)) return { ok: false, error: "Unknown device tool." };
  if (!isReadOnlyDeviceTool(name)) return { ok: false, error: "This device tool needs approval." };
  if (args === undefined || args === null) return { ok: true, tool: name };
  if (!isPlainObject(args)) return { ok: false, error: "Tool arguments must be an object." };
  if (Object.keys(args).length) return { ok: false, error: "This device tool takes no arguments." };
  return { ok: true, tool: name };
}

function checkField(spec, value) {
  if (value === null) return { ok: true, value: null };
  switch (spec.kind) {
    case "int":
      return Number.isInteger(value) && value >= spec.min && value <= spec.max ? { ok: true, value } : { ok: false };
    case "num":
      return typeof value === "number" && Number.isFinite(value) && value >= spec.min && value <= spec.max
        ? { ok: true, value: Math.round(value * 100) / 100 } : { ok: false };
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? { ok: true, value } : { ok: false };
    case "text": {
      if (typeof value !== "string") return { ok: false };
      const trimmed = value.trim();
      return SAFE_TEXT.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

// Rebuilds a clean result from known fields only. Unknown, missing or malformed fields fail.
export function validateDeviceToolResult(name, result) {
  if (!isDeviceTool(name)) return { ok: false, error: "Unknown device tool." };
  if (!isPlainObject(result)) return { ok: false, error: "Device result must be an object." };
  const fields = DEVICE_TOOLS[name].fields;
  for (const key of Object.keys(result)) {
    if (!hasOwn(fields, key)) return { ok: false, error: "Unexpected field in device result." };
  }
  const clean = {};
  for (const key of Object.keys(fields)) {
    if (!hasOwn(result, key)) return { ok: false, error: "Missing field in device result: " + key };
    const checked = checkField(fields[key], result[key]);
    if (!checked.ok) return { ok: false, error: "Invalid value for field: " + key };
    clean[key] = checked.value;
  }
  return { ok: true, value: clean };
}

// Gemini function declarations. No properties: the model cannot pass anything in.
export function deviceToolDeclarations() {
  return Object.entries(DEVICE_TOOLS).map(([name, tool]) => ({
    name: "device_" + name,
    description: tool.description,
    parameters: { type: "OBJECT", properties: {} },
  }));
}

// Maps a declared Gemini name (device_battery) back to a registry name (battery).
export function registryNameFromDeclaration(declared) {
  const name = String(declared || "").replace(/^device_/, "");
  return isDeviceTool(name) ? name : null;
}

const SEVERITY_RANK = { ok: 0, warning: 1, critical: 2 };

// Builds the structured report from validated results. Deterministic: no model involved.
export function buildDiagnosticReport(results, collectedAt = new Date().toISOString()) {
  const input = isPlainObject(results) ? results : {};
  const sections = {};
  const missing = [];
  for (const name of DIAGNOSTIC_BUNDLE) {
    if (hasOwn(input, name) && input[name]) sections[name] = input[name];
    else missing.push(name);
  }

  const findings = [];
  const add = (id, severity, message) => findings.push({ id, severity, message });

  const battery = sections.battery;
  if (battery) {
    if (battery.levelPercent !== null && battery.status !== "charging" && battery.status !== "full") {
      if (battery.levelPercent <= 10) add("battery.level", "critical", "Battery is at " + battery.levelPercent + "% and not charging.");
      else if (battery.levelPercent <= 20) add("battery.level", "warning", "Battery is low at " + battery.levelPercent + "%.");
    }
    if (battery.temperatureC !== null) {
      if (battery.temperatureC >= 50) add("battery.temp", "critical", "Battery is very hot at " + battery.temperatureC + " C.");
      else if (battery.temperatureC >= 45) add("battery.temp", "warning", "Battery is warm at " + battery.temperatureC + " C.");
    }
    if (battery.health !== null && battery.health !== "good" && battery.health !== "unknown") {
      add("battery.health", "warning", "Battery health reports: " + battery.health.replace(/_/g, " ") + ".");
    }
  }

  const storage = sections.storage;
  if (storage && storage.usedPercent !== null) {
    if (storage.usedPercent >= 95) add("storage.full", "critical", "Storage is " + storage.usedPercent + "% full.");
    else if (storage.usedPercent >= 90) add("storage.full", "warning", "Storage is " + storage.usedPercent + "% full.");
  }

  const memory = sections.memory;
  if (memory && memory.totalMb && memory.availableMb !== null) {
    const freePercent = Math.round((memory.availableMb / memory.totalMb) * 1000) / 10;
    if (freePercent < 5) add("memory.low", "critical", "Only " + freePercent + "% of RAM is available.");
    else if (freePercent < 10) add("memory.low", "warning", "Only " + freePercent + "% of RAM is available.");
  }

  const cpu = sections.cpu;
  if (cpu && cpu.cores && cpu.loadAvg1m !== null) {
    const perCore = Math.round((cpu.loadAvg1m / cpu.cores) * 100) / 100;
    if (perCore >= 3) add("cpu.load", "critical", "CPU load is " + perCore + " per core.");
    else if (perCore >= 1.5) add("cpu.load", "warning", "CPU load is " + perCore + " per core.");
  }

  const worst = findings.reduce((rank, f) => Math.max(rank, SEVERITY_RANK[f.severity]), 0);
  const status = worst === 2 ? "critical" : worst === 1 ? "attention" : "healthy";
  const info = sections.device_info;
  const name = info ? [info.manufacturer, info.model].filter(Boolean).join(" ") : "";
  let headline = name ? name + ": " : "Device: ";
  if (!Object.keys(sections).length) headline += "no diagnostics collected.";
  else if (status === "healthy") headline += "no problems found.";
  else headline += findings.length + (findings.length === 1 ? " issue found." : " issues found.");

  return {
    version: DEVICE_PROTOCOL_VERSION,
    source: "device",
    collectedAt,
    summary: { status, headline },
    findings,
    sections,
    missing,
  };
}
