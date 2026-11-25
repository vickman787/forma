import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceEnvironment, serviceRoles } from "../lib/service-env";
test("web and previews never inherit signing or provider credentials", () => {
  const settings: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    OPENAI_API_KEY: "isolated-provider-secret",
    FORMA_DEPLOYER_PRIVATE_KEY: "isolated-signing-secret",
    APP_MODE: "live",
  };
  for (const role of serviceRoles) {
    const env = serviceEnvironment(role, settings);
    assert.equal(env.PROCESS_ROLE, role);
    assert.equal(
      env.OPENAI_API_KEY,
      role === "generation" ? settings.OPENAI_API_KEY : "",
    );
    assert.equal(
      env.FORMA_DEPLOYER_PRIVATE_KEY,
      role === "operator" ? settings.FORMA_DEPLOYER_PRIVATE_KEY : "",
    );
    assert.equal(
      Object.hasOwn(env, "FORMA_DEPLOYER_PRIVATE_KEY"),
      true,
      "empty value prevents dotenv reload in the web process",
    );
  }
});
