/** One local command for the complete, supervised stack; credentials are role scoped. */
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  serviceEnvironment,
  serviceArguments,
  type ServiceRole,
} from "../lib/service-env";
const settings: NodeJS.ProcessEnv = {
  ...process.env,
  ...parseEnv(await readFile(".env", "utf8")),
};
if (settings.LOCAL_ONLY !== "true")
  throw new Error(
    "The local stack requires LOCAL_ONLY=true; use the deployment services for public hosting.",
  );
for (const origin of [settings.APP_URL, settings.PREVIEW_ORIGIN]) {
  const url = new URL(origin || "");
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
    throw new Error("Local stack requires HTTP origins on 127.0.0.1.");
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `Port ${url.port || "80"} is already in use. Stop the existing Forma stack first.`,
        ),
      ),
    );
    probe.listen(Number(url.port || 80), "127.0.0.1", () =>
      probe.close(() => resolve()),
    );
  });
}
settings.PORT = new URL(settings.APP_URL!).port || "80";
const roles: ServiceRole[] = ["web", "preview", "generation", "chain"];
if (settings.ALLOW_OPERATOR_TRANSACTIONS === "true") roles.push("operator");
const children = new Map<ServiceRole, ChildProcess>();
const retries = new Map<ServiceRole, number>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let stopping = false;
function start(role: ServiceRole) {
  if (stopping) return;
  const started = Date.now();
  const child = spawn(process.execPath, serviceArguments(role), {
    cwd: process.cwd(),
    env: serviceEnvironment(role, settings),
    stdio: "inherit",
    windowsHide: true,
  });
  children.set(role, child);
  child.once("error", () => console.error(`Forma ${role} could not start.`));
  child.once("exit", () => {
    children.delete(role);
    if (stopping) return;
    const failures =
      Date.now() - started > 60000 ? 1 : (retries.get(role) || 0) + 1;
    retries.set(role, failures);
    const delay = Math.min(30000, failures * 2000);
    console.error(`Forma ${role} stopped; restarting in ${delay / 1000}s.`);
    const timer = setTimeout(() => {
      timers.delete(timer);
      start(role);
    }, delay);
    timers.add(timer);
  });
}
for (const role of roles) start(role);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    for (const child of children.values()) child.kill(signal);
  });
console.log(
  "Forma local stack started. Worker exits are supervised; Ctrl+C stops all services.",
);
