import { describe, expect, it } from "vitest";

import { formatTick, formatValue, isCompactAxis, niceTicks } from "../src/components/august/genui/chart/scale";

describe("chart ticks", () => {
  it("never repeats a word unit on ticks and goes compact on large axes", () => {
    const ticks = niceTicks(0, 21000, 5);
    const compact = isCompactAxis(ticks);
    expect(compact).toBe(true);
    expect(ticks.map((t) => formatTick(t, "steps", compact))).toEqual(["0", "5k", "10k", "15k", "20k", "25k"]);
  });

  it("uses thousands separators on small ranges", () => {
    expect(isCompactAxis([0, 2500, 5000])).toBe(false);
    expect(formatTick(2500, "steps", false)).toBe("2,500");
  });

  it("keeps single-symbol units compact", () => {
    expect(formatTick(1500000, "$", true)).toBe("$1.5M");
    expect(formatTick(-200, "$", false)).toBe("-$200");
    expect(formatTick(40, "%", false)).toBe("40%");
    expect(formatTick(62, "°F", false)).toBe("62°F");
  });
});

describe("chart values", () => {
  it("shows the full value with its unit once", () => {
    expect(formatValue(15000, "steps")).toBe("15,000 steps");
    expect(formatValue(1234.5, "$")).toBe("$1,234.5");
    expect(formatValue(62, "°F")).toBe("62°F");
    expect(formatValue(3, null)).toBe("3");
  });
});
