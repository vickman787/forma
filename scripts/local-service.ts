import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import {
  serviceEnvironment,
  serviceArguments,
  serviceRoles,
  type ServiceRole,
} from "../lib/service-env";
const role = process.argv[2] as ServiceRole;
if (!serviceRoles.includes(role))
  throw new Error("Choose web, generation, operator, chain or preview");
let settings: NodeJS.ProcessEnv = { ...process.env };
try {
  settings = { ...settings, ...parseEnv(await readFile(".env", "utf8")) };
} catch (e) {
  if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT"))
    throw e;
}
const args = serviceArguments(role, process.argv.includes("--dev"));
const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: serviceEnvironment(role, settings),
  stdio: "inherit",
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    child.kill(signal);
  });
child.on("error", () => {
  console.error("Forma service could not start");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
