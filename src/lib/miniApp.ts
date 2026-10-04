/**
 * The document a mini app runs in. The iframe is sandboxed without
 * allow-same-origin, and this CSP is the first thing in the document, so the
 * app can run its own inline script but can't fetch, load remote resources, or
 * submit forms anywhere.
 */
export const MINI_APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

export type MiniAppTheme = "light" | "dark";

const TOKENS: Record<MiniAppTheme, Record<string, string>> = {
  light: {
    bg: "#ffffff",
    fg: "#1f1f1f",
    muted: "#f4f4f4",
    "muted-fg": "#737373",
    border: "#e6e6e6",
    accent: "#2a78d6",
  },
  dark: {
    bg: "#222222",
    fg: "#f0f0f0",
    muted: "#2e2e2e",
    "muted-fg": "#a3a3a3",
    border: "rgba(255,255,255,0.1)",
    accent: "#3987e5",
  },
};

/** Defaults that make plain HTML look native; the app's own styles come later and win. */
function baseStyles(theme: MiniAppTheme): string {
  const vars = Object.entries(TOKENS[theme])
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");
  return `:root{${vars};color-scheme:${theme}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{padding:14px 16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
h1,h2,h3{font-size:15px;font-weight:600;margin:0 0 8px}
p{margin:0 0 8px}
input,select,textarea,button{font:inherit;color:inherit}
input,select,textarea{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:6px 10px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--muted-fg)}
button{background:var(--muted);border:1px solid var(--border);border-radius:999px;padding:6px 14px;cursor:pointer}
button:hover{filter:brightness(0.97)}
label{color:var(--muted-fg);font-size:13px}
table{border-collapse:collapse;width:100%}
td,th{padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)}`;
}

/** Reports the body's content height (not the viewport's, so the frame can shrink) and exposes `august.reply(text)` to the parent. */
const BRIDGE = `(function(){
var last=0;
function post(){var b=document.body;if(!b)return;var cs=getComputedStyle(b);var h=Math.ceil(b.getBoundingClientRect().height+parseFloat(cs.marginTop)+parseFloat(cs.marginBottom));if(h!==last){last=h;parent.postMessage({type:"august:height",height:h},"*");}}
window.august={reply:function(t){parent.postMessage({type:"august:reply",text:String(t).slice(0,1000)},"*");}};
addEventListener("load",post);
document.addEventListener("DOMContentLoaded",function(){post();if(window.ResizeObserver)new ResizeObserver(post).observe(document.body);});
})();`;

/** Wrap the model's HTML so the CSP, base styles, and bridge come first. */
export function buildMiniAppDoc(html: string, theme: MiniAppTheme): string {
  const body = html.replace(/^\s*<!doctype[^>]*>/i, "");
  return [
    "<!doctype html>",
    `<meta http-equiv="Content-Security-Policy" content="${MINI_APP_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${baseStyles(theme)}</style>`,
    `<script>${BRIDGE}</script>`,
    body,
  ].join("\n");
}

export type MiniAppMessage = { type: "august:height"; height: number } | { type: "august:reply"; text: string };

/** Only these two shapes are accepted from the frame; anything else is ignored. */
export function parseMiniAppMessage(data: unknown): MiniAppMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type === "august:height" && typeof m.height === "number" && Number.isFinite(m.height)) {
    return { type: "august:height", height: m.height };
  }
  if (m.type === "august:reply" && typeof m.text === "string" && m.text.trim()) {
    return { type: "august:reply", text: m.text.trim().slice(0, 1000) };
  }
  return null;
}
