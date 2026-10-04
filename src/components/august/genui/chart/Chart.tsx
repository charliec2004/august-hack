"use client";

import { useEffect, useState } from "react";
import { ChartColumnIcon, TableIcon } from "lucide-react";
import type { ShowChart } from "@/lib/genui";
import { CartesianPlot } from "./CartesianPlot";
import { categories, cleanSeries, slices, valueAt, type Series } from "./data";
import { PiePlot } from "./PiePlot";
import { formatValue, seriesColor } from "./scale";

const KIND_LABEL = { bar: "Bar chart", line: "Line chart", pie: "Pie chart", scatter: "Scatter plot" } as const;

/** A chart from the model's numbers, with hover values and a table view. */
export function Chart({ data }: { data: Partial<ShowChart> }) {
  const [table, setTable] = useState(false);
  const [ref, width] = useWidth<HTMLDivElement>();
  const series = cleanSeries(data);
  const kind = data.kind ?? "bar";
  if (!data.title || series.length === 0) return null;
  const unit = data.unit ?? null;
  const pie = kind === "pie" ? slices(series) : [];
  const summary = `${KIND_LABEL[kind]}: ${data.title}. ${series.map((s) => s.name).join(", ")}.`;

  return (
    <figure aria-label={summary} className="bg-card my-3 max-w-2xl rounded-2xl border px-4 pt-3 pb-3.5">
      <div className="flex items-start justify-between gap-3">
        <figcaption className="text-sm leading-snug font-medium">
          {data.title}
          {unit && <span className="text-muted-foreground font-normal"> ({unit})</span>}
        </figcaption>
        <button
          type="button"
          onClick={() => setTable((t) => !t)}
          aria-pressed={table}
          title={table ? "Show chart" : "Show table"}
          className="text-muted-foreground hover:text-foreground hover:bg-muted -mt-1 -mr-1.5 rounded-md p-1.5 transition-colors"
        >
          {table ? <ChartColumnIcon className="size-4" /> : <TableIcon className="size-4" />}
          <span className="sr-only">{table ? "Show chart" : "Show table"}</span>
        </button>
      </div>

      {kind !== "pie" && series.length > 1 && !table && (
        <ul className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
          {series.map((s, i) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: seriesColor(i) }} />
              {s.name}
            </li>
          ))}
        </ul>
      )}

      <div ref={ref} className="mt-3">
        {table ? (
          <DataTable title={data.title} kind={kind} series={series} unit={unit} />
        ) : kind === "pie" ? (
          <PiePlot slices={pie} unit={unit} />
        ) : (
          width > 0 && <CartesianPlot kind={kind} series={series} unit={unit} width={width} />
        )}
      </div>
      {data.note && <p className="text-muted-foreground mt-2 text-xs">{data.note}</p>}
    </figure>
  );
}

function DataTable({ title, kind, series, unit }: { title: string; kind: ShowChart["kind"]; series: Series[]; unit: string | null }) {
  const cell = "px-3 py-1.5 text-left font-normal";
  if (kind === "pie") {
    const rows = slices(series);
    const total = rows.reduce((sum, r) => sum + r.value, 0);
    return (
      <div className="max-h-72 overflow-auto rounded-xl border">
        <table className="w-full text-[13px] tabular-nums">
          <caption className="sr-only">{title}</caption>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b last:border-b-0">
                <th scope="row" className={cell}>
                  {r.label}
                </th>
                <td className={cell}>{formatValue(r.value, unit)}</td>
                <td className={`${cell} text-muted-foreground`}>{Math.round((r.value / total) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="max-h-72 overflow-auto rounded-xl border">
      <table className="w-full text-[13px] tabular-nums">
        <caption className="sr-only">{title}</caption>
        {series.length > 1 && (
          <thead>
            <tr className="text-muted-foreground border-b">
              <td className={cell} />
              {series.map((s) => (
                <th key={s.name} scope="col" className={cell}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {categories(series).map((c) => (
            <tr key={c} className="border-b last:border-b-0">
              <th scope="row" className={`${cell} text-muted-foreground`}>
                {c}
              </th>
              {series.map((s) => {
                const v = valueAt(s, c);
                return (
                  <td key={s.name} className={cell}>
                    {v === null ? "" : formatValue(v, unit)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Element width, kept current as the layout changes. Callback ref: the element may mount late. */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}
