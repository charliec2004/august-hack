import type { ShowChart } from "@/lib/genui";

export type Point = { x: string | number; y: number };
export type Series = { name: string; points: Point[] };

/** Drop malformed or still-streaming points and series. */
export function cleanSeries(data: Partial<ShowChart>): Series[] {
  return (data.series ?? [])
    .filter((s): s is Series => Boolean(s?.name) && Array.isArray(s?.points))
    .map((s) => ({
      name: s.name,
      points: s.points.filter(
        (p): p is Point =>
          Boolean(p) && (typeof p.x === "string" || typeof p.x === "number") && typeof p.y === "number" && Number.isFinite(p.y),
      ),
    }))
    .filter((s) => s.points.length > 0)
    .slice(0, 8);
}

/** Every x value across series, in first-seen order (sorted when all numeric). */
export function categories(series: Series[]): string[] {
  const seen = new Map<string, string | number>();
  for (const s of series) for (const p of s.points) if (!seen.has(String(p.x))) seen.set(String(p.x), p.x);
  const xs = [...seen.values()];
  if (xs.every((x) => typeof x === "number")) (xs as number[]).sort((a, b) => a - b);
  return xs.map(String);
}

/** y for series at category, or null. */
export function valueAt(s: Series, category: string): number | null {
  const p = s.points.find((pt) => String(pt.x) === category);
  return p ? p.y : null;
}

export const numericX = (series: Series[]) =>
  series.every((s) => s.points.every((p) => typeof p.x === "number" || (p.x !== "" && Number.isFinite(Number(p.x)))));

export type Slice = { label: string; value: number };

/** Pie slices from the first series: positive values, at most 7 plus "Other". */
export function slices(series: Series[]): Slice[] {
  const all = (series[0]?.points ?? []).filter((p) => p.y > 0).map((p) => ({ label: String(p.x), value: p.y }));
  if (all.length <= 8) return all;
  const sorted = [...all].sort((a, b) => b.value - a.value);
  const rest = sorted.slice(7).reduce((sum, s) => sum + s.value, 0);
  return [...sorted.slice(0, 7), { label: "Other", value: rest }];
}
