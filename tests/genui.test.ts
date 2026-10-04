import { describe, expect, it } from "vitest";

import {
  askUserSchema,
  describeUi,
  MINI_APP_MAX_HTML,
  normalizeForm,
  readAnswer,
  showAppSchema,
  stripHistoryLines,
  type FormQuestion,
} from "../src/lib/genui";
import { composeFormReply, emptyAnswer, isAnswered } from "../src/lib/genuiForm";
import { buildMiniAppDoc, MINI_APP_CSP, parseMiniAppMessage } from "../src/lib/miniApp";

const q = (over: Partial<FormQuestion>): FormQuestion => ({
  id: "q",
  prompt: "Prompt",
  kind: "single",
  choices: [],
  allowOther: false,
  placeholder: null,
  scale: null,
  ...over,
});

const questions: FormQuestion[] = [
  q({ id: "size", prompt: "How many guests?", kind: "scale", scale: { min: 1, max: 8, minLabel: null, maxLabel: null } }),
  q({
    id: "cuisine",
    prompt: "Cuisine",
    kind: "multi",
    choices: [
      { id: "it", label: "Italian", detail: null },
      { id: "mx", label: "Mexican", detail: null },
      { id: "jp", label: "Japanese", detail: null },
    ],
    allowOther: true,
  }),
  q({ id: "notes", prompt: "Anything else", kind: "text" }),
];

describe("question form replies", () => {
  it("composes one readable message", () => {
    const answers = {
      size: { ...emptyAnswer(), value: 4 },
      cuisine: { ...emptyAnswer(), picked: ["it", "mx"], text: "Thai" },
      notes: { ...emptyAnswer(), text: "window seat" },
    };
    const text = composeFormReply(questions, answers);
    expect(text).toBe("How many guests? 4 of 8 · Cuisine: Italian, Mexican, Thai · Anything else: window seat");
  });

  it("skips unanswered optional text and requires choices and scales", () => {
    expect(isAnswered(questions[0], undefined)).toBe(false);
    expect(isAnswered(questions[2], undefined)).toBe(true);
    const text = composeFormReply(questions, {
      size: { ...emptyAnswer(), value: 2 },
      cuisine: { ...emptyAnswer(), picked: ["jp"] },
    });
    expect(text).toBe("How many guests? 2 of 8 · Cuisine: Japanese");
  });

  it("replies to a single question with just the answer", () => {
    const one = [questions[1]];
    expect(composeFormReply(one, { cuisine: { ...emptyAnswer(), picked: ["mx"] } })).toBe("Mexican");
  });

});

describe("card answers", () => {
  it("reads only well-formed answers", () => {
    expect(readAnswer({ cardId: "call_1", answers: { picked: ["a", 2], q1: "Italian" } })).toEqual({
      cardId: "call_1",
      answers: { picked: ["a"], q1: "Italian" },
    });
    expect(readAnswer({ answers: {} })).toBeNull();
    expect(readAnswer("call_1")).toBeNull();
  });
});

describe("normalizeForm", () => {
  it("maps a legacy single question to one question", () => {
    const form = normalizeForm({ question: "Which day?", choices: [{ id: "a", label: "Fri" }, { id: "b", label: "Sat" }], multi: true });
    expect(form.questions).toHaveLength(1);
    expect(form.questions[0]).toMatchObject({ prompt: "Which day?", kind: "multi", allowOther: false });
    expect(form.questions[0].choices.map((c) => c.label)).toEqual(["Fri", "Sat"]);
  });

  it("makes question and choice ids unique", () => {
    const form = normalizeForm({
      title: null,
      submitLabel: null,
      questions: [
        q({ id: "", prompt: "Who's coming?", kind: "text" }),
        q({ id: "notes", prompt: "Dietary needs?", kind: "text" }),
        q({ id: "notes", prompt: "Any limits?", kind: "text" }),
        q({
          id: "q1",
          prompt: "Vibe",
          kind: "multi",
          choices: [
            { id: "a", label: "Cozy", detail: null },
            { id: "a", label: "Festive", detail: null },
          ],
        }),
      ],
    });
    const ids = form.questions.map((x) => x.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(0, 3)).toEqual(["q1", "notes", "q3"]);
    expect(form.questions[3].choices.map((c) => c.id)).toEqual(["a", "c2"]);
  });

  it("drops partial streaming questions", () => {
    const form = normalizeForm({ title: null, questions: [questions[0], { id: "x" } as FormQuestion], submitLabel: null });
    expect(form.questions.map((x) => x.id)).toEqual(["size"]);
  });

  it("accepts the strict form schema", () => {
    expect(askUserSchema.safeParse({ title: null, questions, submitLabel: null }).success).toBe(true);
  });
});

describe("history lines", () => {
  it("describes each component and strips the lines from visible text", () => {
    const lines = [
      describeUi({ question: { title: "Dinner party", questions, submitLabel: null } }),
      describeUi({ poll: { question: "Weekend?", options: [{ id: "1", label: "Hike" }, { id: "2", label: "Museum" }], multi: false } }),
      describeUi({
        chart: { title: "Rent", kind: "line", unit: "$", series: [{ name: "Rent", points: [{ x: "Jan", y: 2000 }] }], note: null },
      }),
      describeUi({ app: { title: "Tip calculator", html: "<p>hi</p>", height: null } }),
      describeUi({ question: { question: "Which day?", choices: [{ label: "Fri" }, { label: "Sat" }] } }),
    ];
    expect(lines[0]).toBe("(Asked: Dinner party | How many guests? | Cuisine [Italian; Mexican; Japanese] | Anything else)");
    expect(lines[2]).toBe("(Chart shown: Rent ($). Rent: Jan=2000)");
    expect(stripHistoryLines(["Here you go.", ...lines].join("\n"))).toBe("Here you go.");
  });
});

describe("mini app", () => {
  it("puts the CSP first and keeps the app's own document", () => {
    const doc = buildMiniAppDoc("<!DOCTYPE html><html><body><p>hi</p></body></html>", "dark");
    const csp = doc.indexOf(MINI_APP_CSP);
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(doc.indexOf("<style>"));
    expect(doc).toContain("color-scheme:dark");
    expect(doc).toContain("<p>hi</p>");
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(MINI_APP_CSP).toContain("connect-src 'none'");
  });

  it("accepts only height and reply messages", () => {
    expect(parseMiniAppMessage({ type: "august:height", height: 320 })).toEqual({ type: "august:height", height: 320 });
    expect(parseMiniAppMessage({ type: "august:reply", text: "  15% tip: $9  " })).toEqual({ type: "august:reply", text: "15% tip: $9" });
    expect(parseMiniAppMessage({ type: "august:height", height: "9999" })).toBeNull();
    expect(parseMiniAppMessage({ type: "august:navigate", url: "https://x" })).toBeNull();
    expect(parseMiniAppMessage("august:reply")).toBeNull();
  });

  it("caps app html size in the tool schema", () => {
    const big = "x".repeat(MINI_APP_MAX_HTML + 1);
    expect(showAppSchema.safeParse({ title: "Big", html: big, height: null }).success).toBe(false);
  });
});

import { titleMentions } from "../src/components/august/genui/chart/Chart";
describe("chart title unit", () => {
  it("skips the parenthetical when the title already names the unit", () => {
    expect(titleMentions("Daily steps", "steps")).toBe(true);
    expect(titleMentions("Steps per day", "step")).toBe(true);
    expect(titleMentions("Average high temperature", "°F")).toBe(false);
    expect(titleMentions("Monthly spending", "USD")).toBe(false);
  });
});
