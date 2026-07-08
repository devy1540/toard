import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.TOARD_UPDATER_PORT || "3201");
const SECRET = process.env.TOARD_UPDATER_SECRET || "";
const PROJECT_DIR = process.env.TOARD_COMPOSE_PROJECT_DIR || "/workspace";
const COMPOSE_FILE = process.env.TOARD_COMPOSE_FILE || "docker-compose.yml";
const APP_URL = (process.env.TOARD_APP_URL || "http://app:3000").replace(/\/+$/, "");
const DOCKER_BIN = process.env.TOARD_DOCKER_BIN || "docker";
const LOG_LIMIT = Number(process.env.TOARD_UPDATER_LOG_LIMIT || "120");
const COMMAND_TIMEOUT_MS = Number(process.env.TOARD_UPDATER_COMMAND_TIMEOUT_MS || "600000");
const VERIFY_TIMEOUT_MS = Number(process.env.TOARD_UPDATER_VERIFY_TIMEOUT_MS || "120000");
const LATEST_URL = process.env.TOARD_RELEASE_LATEST_URL || "https://github.com/devy1540/toard/releases/latest";

const phases = {
  idle: "idle",
  latest: "latest",
  preflight: "preflight",
  pulling: "pulling",
  migrating: "migrating",
  restarting: "restarting",
  verifying: "verifying",
  completed: "completed",
  failed: "failed",
};

let status = initialStatus();

function initialStatus() {
  return {
    running: false,
    phase: phases.idle,
    message: "idle",
    currentVersion: null,
    latestVersion: null,
    targetVersion: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    logs: [],
  };
}

function publicStatus() {
  return {
    ...status,
    configured: Boolean(SECRET),
  };
}

function setPhase(phase, message) {
  status.phase = phase;
  status.message = message;
  addLog(message);
}

function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  status.logs = [...status.logs, line].slice(-LOG_LIMIT);
}

function parseLatestVersionFromLocation(location) {
  if (!location) return null;
  const match = /\/releases\/tag\/v?(\d+\.\d+\.\d+)(?:[/?#]|$)/.exec(location);
  return match?.[1] ?? null;
}

function normalizeTargetVersion(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (v === "" || v === "latest") return null;
  const stripped = v.startsWith("v") ? v.slice(1) : v;
  if (!/^\d+\.\d+\.\d+$/.test(stripped)) {
    throw new Error("targetVersion must be a semver like 1.2.3 or v1.2.3");
  }
  return stripped;
}

function authorized(req) {
  if (!SECRET) return false;
  const value = req.headers.authorization || "";
  const prefix = "Bearer ";
  if (!value.startsWith(prefix)) return false;
  const provided = value.slice(prefix.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function fetchLatestVersion() {
  const res = await fetch(LATEST_URL, { method: "HEAD", redirect: "manual" });
  if (res.status < 300 || res.status >= 400) {
    throw new Error(`latest release lookup failed: HTTP ${res.status}`);
  }
  const parsed = parseLatestVersionFromLocation(res.headers.get("location"));
  if (!parsed) throw new Error("latest release redirect did not include a semver tag");
  return parsed;
}

async function fetchServerVersion() {
  const res = await fetch(`${APP_URL}/api/v1/version`, { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/v1/version failed: HTTP ${res.status}`);
  const json = await res.json();
  return typeof json.version === "string" ? json.version : null;
}

async function waitForOk(path) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}${path}`, { cache: "no-store" });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = String(e);
    }
    await delay(2000);
  }
  throw new Error(`${path} did not become ready before timeout: ${lastError}`);
}

function composeEnv(targetVersion) {
  const env = { ...process.env };
  if (targetVersion) env.TOARD_TAG = targetVersion;
  return env;
}

function dockerComposeArgs(args) {
  return ["compose", "-f", COMPOSE_FILE, ...args];
}

async function runDockerCompose(args, targetVersion) {
  const fullArgs = dockerComposeArgs(args);
  addLog(`$ ${DOCKER_BIN} ${fullArgs.join(" ")}`);
  await runCommand(DOCKER_BIN, fullArgs, {
    cwd: PROJECT_DIR,
    env: composeEnv(targetVersion),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach((line) => addLog(line)));
    child.stderr.on("data", (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach((line) => addLog(line)));
    child.on("error", (e) => {
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function runUpdate(targetVersion) {
  status = {
    ...initialStatus(),
    running: true,
    phase: phases.latest,
    message: "starting update",
    targetVersion,
    startedAt: new Date().toISOString(),
  };
  addLog("starting compose update");

  try {
    setPhase(phases.latest, "checking latest release");
    try {
      status.latestVersion = await fetchLatestVersion();
      addLog(`latest release: v${status.latestVersion}`);
    } catch (e) {
      addLog(`latest release check skipped: ${String(e)}`);
    }

    setPhase(phases.preflight, "checking current server version");
    try {
      status.currentVersion = await fetchServerVersion();
      addLog(`current server version: ${status.currentVersion ?? "unknown"}`);
    } catch (e) {
      addLog(`current server version unavailable before update: ${String(e)}`);
    }

    setPhase(phases.pulling, "pulling app and migrator images");
    await runDockerCompose(["pull", "app", "migrate"], targetVersion);

    setPhase(phases.migrating, "running database migrations");
    await runDockerCompose(["run", "--rm", "migrate"], targetVersion);

    setPhase(phases.restarting, "restarting app service");
    await runDockerCompose(["up", "-d", "app"], targetVersion);

    setPhase(phases.verifying, "verifying updated app");
    await waitForOk("/api/health");
    await waitForOk("/api/ready");
    const verifiedVersion = await fetchServerVersion();
    status.currentVersion = verifiedVersion;
    if (targetVersion && verifiedVersion !== targetVersion) {
      throw new Error(`updated server reported ${verifiedVersion}, expected ${targetVersion}`);
    }

    status.running = false;
    status.phase = phases.completed;
    status.message = "update completed";
    status.finishedAt = new Date().toISOString();
    addLog(`update completed; server version: ${verifiedVersion ?? "unknown"}`);
  } catch (e) {
    status.running = false;
    status.phase = phases.failed;
    status.message = "update failed";
    status.error = String(e);
    status.finishedAt = new Date().toISOString();
    addLog(`update failed: ${status.error}`);
  }
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, SECRET ? 200 : 503, { ok: Boolean(SECRET) });
  }
  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && url.pathname === "/status") return send(res, 200, publicStatus());
  if (req.method === "POST" && url.pathname === "/update") {
    if (status.running) return send(res, 409, { error: "update already running", status: publicStatus() });
    try {
      const body = await readJson(req);
      const targetVersion = normalizeTargetVersion(body.targetVersion);
      void runUpdate(targetVersion);
      return send(res, 202, publicStatus());
    } catch (e) {
      return send(res, 400, { error: String(e) });
    }
  }
  return send(res, 404, { error: "not found" });
}

function startServer() {
  if (!SECRET) {
    console.error("toard-updater: TOARD_UPDATER_SECRET is required");
    process.exit(1);
  }
  createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: String(e) }));
  }).listen(PORT, "0.0.0.0", () => {
    console.log(`toard-updater listening on :${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export {
  dockerComposeArgs,
  initialStatus,
  normalizeTargetVersion,
  parseLatestVersionFromLocation,
};
