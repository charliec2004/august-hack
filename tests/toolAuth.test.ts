import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { detectLocalInstalls } from "../src/server/computers/localInstalls";
import {
  buildExecRequest,
  planInjection,
  redactOutput,
  redactValues,
  type ToolCredentialMaterial,
} from "../src/server/computers/toolAuth";
import {
  EnvironmentError,
  canonicalManifest,
  manifestSha256,
  nextManifestFor,
  normalizeToolAuth,
  type UserEnvironmentTool,
} from "../src/server/computers/types";
import { openCredential, parseCredentialsKey, sealCredential } from "../src/server/credentials/crypto";

const key = randomBytes(32);
const binding = { userId: "u1", toolKey: "notion", kind: "env" as const };

describe("credential encryption", () => {
  it("round-trips", () => {
    const sealed = sealCredential(key, binding, '{"kind":"env","env":{"NOTION_TOKEN":"secret_abc"}}');
    expect(sealed.ciphertext.toString("utf8")).not.toContain("secret_abc");
    expect(openCredential(key, binding, sealed)).toContain("secret_abc");
  });

  it("detects tampering with ciphertext, tag, iv, key, or binding", () => {
    const sealed = sealCredential(key, binding, "hello world");
    const flip = (b: Buffer) => {
      const c = Buffer.from(b);
      c[0] ^= 1;
      return c;
    };
    expect(() => openCredential(key, binding, { ...sealed, ciphertext: flip(sealed.ciphertext) })).toThrow();
    expect(() => openCredential(key, binding, { ...sealed, authTag: flip(sealed.authTag) })).toThrow();
    expect(() => openCredential(key, binding, { ...sealed, authTag: sealed.authTag.subarray(0, 8) })).toThrow();
    expect(() => openCredential(key, binding, { ...sealed, iv: flip(sealed.iv) })).toThrow();
    expect(() => openCredential(randomBytes(32), binding, sealed)).toThrow();
    expect(() => openCredential(key, { ...binding, userId: "u2" }, sealed)).toThrow();
    expect(() => openCredential(key, { ...binding, toolKey: "doordash" }, sealed)).toThrow();
  });

  it("requires a 32-byte base64 key", () => {
    expect(() => parseCredentialsKey(undefined)).toThrow();
    expect(() => parseCredentialsKey(randomBytes(16).toString("base64"))).toThrow();
    expect(parseCredentialsKey(key.toString("base64")).equals(key)).toBe(true);
  });
});

describe("secret redaction", () => {
  const secret = "secret_NotionToken123";

  it("redacts raw, base64, and base64url forms", () => {
    const b64 = Buffer.from(secret).toString("base64");
    const url = b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const text = `token=${secret}\n${b64}\n${url}\nok`;
    const out = redactValues(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(b64.replace(/=+$/, ""));
    expect(out).toContain("ok");
  });

  it("redacts stdout and stderr", () => {
    const out = redactOutput({ exitCode: 0, stdout: `x ${secret}`, stderr: `${secret}!` }, [secret]);
    expect(out.stdout).toBe("x [redacted]");
    expect(out.stderr).toBe("[redacted]!");
  });

  it("redacts every line of a credentials file", () => {
    const manifest = canonicalManifest({
      tools: [{ toolKey: "notion", packageName: "notion-cli", packageVersion: "1.0.0", auth: { kind: "file", path: ".config/notion/credentials.json" } }],
    });
    const file = '{"token": "ntn_abcdefgh12345", "workspace": "ws_99887766"}';
    const plan = planInjection(manifest, new Map([["notion", { kind: "file", file } as ToolCredentialMaterial]]));
    const shown = redactValues('{"token":"ntn_abcdefgh12345"} ws_99887766', plan.secrets);
    expect(shown).not.toContain("ntn_abcdefgh12345");
    expect(shown).not.toContain("ws_99887766");
  });
});

describe("env injection", () => {
  const notion: UserEnvironmentTool = {
    toolKey: "notion",
    packageName: "notion-cli",
    packageVersion: "1.0.0",
    auth: { kind: "env", vars: ["NOTION_TOKEN"] },
  };
  const manifest = canonicalManifest({ tools: [notion] });
  const creds = new Map<string, ToolCredentialMaterial>([
    ["notion", { kind: "env", env: { NOTION_TOKEN: "ntn_supersecret_1", EXTRA: "not-declared" } }],
    ["doordash", { kind: "env", env: { DD_TOKEN: "dd_not_pinned_123" } }],
  ]);

  it("injects only declared vars of pinned tools, via env, never in the command", () => {
    const plan = planInjection(manifest, creds);
    expect(plan.env).toEqual({ NOTION_TOKEN: "ntn_supersecret_1" });
    const req = buildExecRequest("notion search 'q4 plan'", plan);
    expect(req.env).toEqual({ NOTION_TOKEN: "ntn_supersecret_1" });
    expect(req.command).not.toContain("ntn_supersecret_1");
    expect(req.command.endsWith("notion search 'q4 plan'")).toBe(true);
    expect(req.command).toContain("export PATH='/opt/august-env/bin'");
  });

  it("stores a redacted command even if it contains an injected value", () => {
    const plan = planInjection(manifest, creds);
    const req = buildExecRequest("curl -H 'x: ntn_supersecret_1' https://api.notion.com", plan);
    expect(req.recorded).not.toContain("ntn_supersecret_1");
    expect(req.recorded).toContain("[redacted]");
  });

  it("ignores a stored credential whose kind no longer matches", () => {
    const fileTool = canonicalManifest({ tools: [{ ...notion, auth: { kind: "file", path: ".notion" } }] });
    expect(planInjection(fileTool, creds)).toEqual({ env: {}, files: [], secrets: [] });
    expect(buildExecRequest("ls", planInjection(fileTool, creds)).env).toBeUndefined();
  });
});

describe("manifest auth declarations", () => {
  const cowsay: UserEnvironmentTool = { toolKey: "cowsay", packageName: "cowsay", packageVersion: "1.6.0" };

  it("keeps the hash of tools without auth unchanged", () => {
    const legacy = '{"format":"user-environment-manifest:v1","tools":[{"packageName":"cowsay","packageVersion":"1.6.0","toolKey":"cowsay"}]}';
    const expected = createHash("sha256").update(legacy, "utf8").digest("hex");
    expect(manifestSha256(canonicalManifest({ tools: [cowsay] }))).toBe(expected);
    expect(manifestSha256(canonicalManifest({ tools: [{ ...cowsay, auth: null }] }))).toBe(expected);
  });

  it("treats adding a login declaration as a change", () => {
    const base = canonicalManifest({ tools: [cowsay] });
    const next = nextManifestFor(base, { operation: "install", tool: { ...cowsay, auth: { kind: "env", vars: ["COW_TOKEN"] } } });
    expect(next.tools[0].auth).toEqual({ kind: "env", vars: ["COW_TOKEN"] });
    expect(manifestSha256(next)).not.toBe(manifestSha256(base));
  });

  it("rejects unsafe declarations", () => {
    for (const bad of [
      { kind: "env", vars: ["PATH"] },
      { kind: "env", vars: ["lower"] },
      { kind: "env", vars: [] },
      { kind: "file", path: "/etc/passwd" },
      { kind: "file", path: "../.ssh/id_rsa" },
      { kind: "file", path: ".config/../../x" },
      { kind: "file", path: "a b" },
      { kind: "other" },
    ]) {
      expect(() => normalizeToolAuth(bad)).toThrow(EnvironmentError);
    }
    expect(normalizeToolAuth({ kind: "file", path: ".config/notion/credentials.json" })).toEqual({
      kind: "file",
      path: ".config/notion/credentials.json",
    });
  });
});

describe("local install detection", () => {
  it.each([
    ["npm install -g @notionhq/cli@1.2.3", ["@notionhq/cli"]],
    ["sudo npm i -g prettier", ["prettier"]],
    ["npm install lodash", []],
    ["pip install requests==2.31 'pandas>=2'", ["requests", "pandas"]],
    ["python3 -m pip install --user httpie", ["httpie"]],
    ["pip install -r requirements.txt", []],
    ["pipx install poetry", ["poetry"]],
    ["brew install jq && jq --version", ["jq"]],
    ["cargo install ripgrep --version 14.0.0", ["ripgrep"]],
    ["go install github.com/charmbracelet/glow@latest", ["glow"]],
    ["curl -fsSL https://bun.sh/install | bash", ["bun.sh"]],
    ["ls -la; cat notes.txt", []],
  ])("%s", (command, expected) => {
    expect(detectLocalInstalls(command)).toEqual(expected);
  });
});
