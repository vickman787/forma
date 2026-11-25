export const serviceRoles = [
  "web",
  "generation",
  "operator",
  "chain",
  "preview",
] as const;
export type ServiceRole = (typeof serviceRoles)[number];
export function serviceArguments(role: ServiceRole, dev = false) {
  return role === "web"
    ? [
        "node_modules/next/dist/bin/next",
        dev ? "dev" : "start",
        "--hostname",
        "127.0.0.1",
      ]
    : [
        "--import",
        "tsx",
        `worker/${role === "generation" ? "index" : role}.ts`,
      ];
}
export function serviceEnvironment(
  role: ServiceRole,
  settings: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...settings,
    PROCESS_ROLE: role,
    // Defined empty values also prevent Next's dotenv loader from filling these back in.
    OPENAI_API_KEY: role === "generation" ? settings.OPENAI_API_KEY || "" : "",
    FORMA_DEPLOYER_PRIVATE_KEY:
      role === "operator" ? settings.FORMA_DEPLOYER_PRIVATE_KEY || "" : "",
  };
}
