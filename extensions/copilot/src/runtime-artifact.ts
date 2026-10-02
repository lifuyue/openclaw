import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { StdioRuntimeConnection } from "@github/copilot-sdk";
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fingerprintCopilotPackage, loadCopilotSdkWithIdentity } from "./sdk-loader.js";

function runtimePlatform(): string {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Copilot runtime artifacts do not support architecture ${process.arch}.`);
  }
  if (process.platform === "linux") {
    const report = process.report?.getReport();
    const header = isRecord(report) && isRecord(report.header) ? report.header : undefined;
    return `${header?.glibcVersionRuntime ? "linux" : "linuxmusl"}-${process.arch}`;
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return `${process.platform}-${process.arch}`;
  }
  throw new Error(`Copilot runtime artifacts do not support platform ${process.platform}.`);
}

async function resolveRuntimePackage(entryPath: string, packageName: string): Promise<string> {
  // Resolve the SDK's own optional dependency afresh: require.resolve caches
  // symlink targets, which would hide a replaced installation during validation.
  const lookupPaths = createRequire(entryPath).resolve.paths(packageName) ?? [];
  for (const lookupPath of lookupPaths) {
    const candidate = path.join(lookupPath, packageName);
    try {
      await fs.access(path.join(candidate, "package.json"));
      return await fs.realpath(candidate);
    } catch (error) {
      if (extractErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`Copilot runtime package ${packageName} is not installed.`);
}

export async function captureCopilotRuntimeArtifact(env: NodeJS.ProcessEnv = process.env): Promise<{
  binding: AgentHarnessRuntimeArtifactBinding;
  connection: StdioRuntimeConnection;
}> {
  // The SDK chooses its default transport from the host environment even when
  // client-level env overrides are supplied. Never verify a different transport.
  const defaultConnection = process.env.COPILOT_SDK_DEFAULT_CONNECTION;
  if (defaultConnection && defaultConnection.toLowerCase() !== "stdio") {
    throw new Error("Copilot runtime artifact verification requires the stdio transport.");
  }
  const { sdk, identity } = await loadCopilotSdkWithIdentity();
  if ((await fingerprintCopilotPackage(identity.packageRoot)) !== identity.fingerprint) {
    throw new Error(
      "Copilot SDK changed after loading. Restart OpenClaw before verifying inference.",
    );
  }
  const platform = runtimePlatform();
  const packageName = `@github/copilot-sdk-${platform}`;
  const sdkManifest: unknown = JSON.parse(
    await fs.readFile(path.join(identity.packageRoot, "package.json"), "utf8"),
  );
  if (
    !isRecord(sdkManifest) ||
    !isRecord(sdkManifest.optionalDependencies) ||
    !sdkManifest.optionalDependencies[packageName]
  ) {
    throw new Error(`The installed Copilot SDK does not declare runtime package ${packageName}.`);
  }
  const packageRoot = await resolveRuntimePackage(identity.entryPath, packageName);
  // The SDK publishes its native runtime as an optional platform package. Pin
  // that packaged executable through the SDK's public RuntimeConnection API.
  const executable = await fs.realpath(
    path.join(
      packageRoot,
      "prebuilds",
      platform,
      process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime",
    ),
  );
  if (env.COPILOT_CLI_PATH && (await fs.realpath(env.COPILOT_CLI_PATH)) !== executable) {
    throw new Error(
      "Copilot runtime artifact verification does not support a custom COPILOT_CLI_PATH.",
    );
  }
  const runtimeFingerprint = await fingerprintCopilotPackage(packageRoot);
  const id = `copilot-sdk:${JSON.stringify([identity.entryPath, executable])}`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([id, identity.fingerprint, runtimeFingerprint]))
    .digest("hex");
  return {
    binding: { id, fingerprint },
    connection: sdk.RuntimeConnection.forStdio({ path: executable }),
  };
}

export async function validateCopilotRuntimeArtifact(
  binding: AgentHarnessRuntimeArtifactBinding,
): Promise<boolean> {
  try {
    const current = await captureCopilotRuntimeArtifact();
    return current.binding.id === binding.id && current.binding.fingerprint === binding.fingerprint;
  } catch {
    return false;
  }
}
