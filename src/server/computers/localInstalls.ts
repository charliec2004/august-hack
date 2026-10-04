/**
 * Detects task-local software installs in a shell command (pure, unit-tested).
 *
 * Used only as a promotion signal: a tool installed by hand in several
 * unrelated tasks is probably a capability the user wants on every Computer
 * (proposed via computer_install_tool). Conservative on purpose: unknown
 * shapes are ignored rather than guessed.
 */

const MAX_NAMES = 16;
const NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/+-]{0,127}$/;

/** Splits on shell separators (not pipes) into simple segments. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
}

function words(segment: string): string[] {
  return segment
    .replace(/^(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?/, "")
    .split(/\s+/)
    .map((w) => w.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

/** Positional args after `start`, skipping flags (and a flag's value when it takes one). */
function positionals(ws: string[], start: number, flagsWithValue: string[] = []): string[] {
  const out: string[] = [];
  for (let i = start; i < ws.length; i++) {
    const w = ws[i];
    if (w === "|" || w.startsWith(">") || w === "2>&1") break;
    if (w.startsWith("-")) {
      if (flagsWithValue.includes(w)) i += 1;
      continue;
    }
    out.push(w);
  }
  return out;
}

function npmName(spec: string): string {
  // @scope/pkg@1.2.3 -> @scope/pkg ; pkg@latest -> pkg
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function pipName(spec: string): string {
  return spec.split(/[=<>!~;[ ]/)[0];
}

function goName(spec: string): string {
  const path = spec.split("@")[0].replace(/\/\.\.\.$/, "");
  return path.split("/").filter(Boolean).pop() ?? path;
}

function fromSegment(segment: string): string[] {
  const ws = words(segment);
  const [a, b, c] = ws;
  if (a === "npm" && (b === "i" || b === "install" || b === "add")) {
    if (!ws.includes("-g") && !ws.includes("--global")) return [];
    return positionals(ws, 2, ["--prefix"]).map(npmName);
  }
  const pipIdx =
    a === "pip" || a === "pip3"
      ? 0
      : (a === "python" || a === "python3") && b === "-m" && (c === "pip" || c === "pip3")
        ? 2
        : a === "uv" && b === "pip"
          ? 1
          : -1;
  if (pipIdx >= 0 && ws[pipIdx + 1] === "install") {
    return positionals(ws, pipIdx + 2, ["-r", "--requirement", "-c", "--constraint", "-t", "--target", "-i", "--index-url"])
      .filter((p) => !p.startsWith(".") && !p.startsWith("/") && !p.includes("://"))
      .map(pipName);
  }
  if ((a === "pipx" || a === "brew" || a === "cargo") && b === "install") return positionals(ws, 2, ["--version"]);
  if (a === "go" && b === "install") return positionals(ws, 2).map(goName);
  return [];
}

const CURL_PIPE_SH = /\b(?:curl|wget)\b[^|;&\n]*?\bhttps?:\/\/([A-Za-z0-9.-]+)[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/g;

/** Tool/package names installed by this command; empty when none recognized. */
export function detectLocalInstalls(command: string): string[] {
  if (typeof command !== "string" || command.length > 20_000) return [];
  const names = new Set<string>();
  for (const m of command.matchAll(CURL_PIPE_SH)) names.add(m[1].toLowerCase());
  for (const seg of segments(command)) {
    for (const n of fromSegment(seg)) if (NAME.test(n)) names.add(n);
  }
  return [...names].slice(0, MAX_NAMES);
}
