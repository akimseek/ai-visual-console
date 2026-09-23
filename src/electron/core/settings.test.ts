import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGatewayExternalApiEnabled,
  getGatewayExternalApiStatus,
  getGatewayExternalApiTokenHash,
  rotateGatewayExternalApiToken,
  setGatewayExternalApiEnabled,
  setSettingsPath
} from "./settings";

let settingsDirectory = "";

beforeEach(async () => {
  settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-visual-console-settings-"));
  setSettingsPath(path.join(settingsDirectory, "settings.json"));
});

afterEach(async () => {
  setSettingsPath("");
  await fs.rm(settingsDirectory, { recursive: true, force: true });
});

describe("gateway external API settings", () => {
  it("keeps the API disabled by default and persists only a token hash", async () => {
    expect(await getGatewayExternalApiStatus()).toEqual({ enabled: false, tokenConfigured: false });

    const token = await rotateGatewayExternalApiToken();
    const tokenHash = await getGatewayExternalApiTokenHash();
    expect(token).toHaveLength(43);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(await fs.readFile(path.join(settingsDirectory, "settings.json"), "utf8")).not.toContain(token);
    expect(await getGatewayExternalApiStatus()).toEqual({ enabled: false, tokenConfigured: true });
  });

  it("rotates the shared token and persists the external API switch", async () => {
    const previousToken = await rotateGatewayExternalApiToken();
    const previousHash = await getGatewayExternalApiTokenHash();
    await setGatewayExternalApiEnabled(true);
    const currentToken = await rotateGatewayExternalApiToken();

    expect(currentToken).not.toBe(previousToken);
    expect(await getGatewayExternalApiTokenHash()).not.toBe(previousHash);
    expect(await getGatewayExternalApiEnabled()).toBe(true);
  });
});
