"use client";

import { ArrowUpRightIcon } from "lucide-react";
import { safeUrl, type ShowComparison } from "@/lib/genui";

type Row = ShowComparison["rows"][number];

/** Compact side-by-side table: options down the side, facts across the top. */
export function ComparisonTable({ data }: { data: Partial<ShowComparison> }) {
  const columns = (data.columns ?? []).filter(Boolean);
  const rows = (data.rows ?? []).filter((r): r is Row => Boolean(r?.name));
  if (columns.length === 0 || rows.length === 0) return null;

  return (
    <section aria-label={data.title ?? "Comparison"} className="my-3">
      {data.title && <h3 className="text-foreground/90 mb-2 text-sm font-medium">{data.title}</h3>}
      <div className="bg-card overflow-x-auto rounded-2xl border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-muted-foreground border-b text-left">
              <th scope="col" className="bg-card sticky left-0 px-3.5 py-2 font-medium">
                <span className="sr-only">Option</span>
              </th>
              {columns.map((c, i) => (
                <th key={`${c}-${i}`} scope="col" className="px-3.5 py-2 font-medium whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const link = safeUrl(r.url);
              return (
                <tr key={`${r.name}-${i}`} className="border-b last:border-b-0">
                  <th scope="row" className="bg-card sticky left-0 min-w-[7.5rem] px-3.5 py-2 text-left font-medium">
                    {link ? (
                      <a
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 hover:underline"
                      >
                        {r.name}
                        <ArrowUpRightIcon className="text-muted-foreground size-3" />
                      </a>
                    ) : (
                      r.name
                    )}
                  </th>
                  {columns.map((c, j) => (
                    <td key={`${c}-${j}`} className="text-foreground/85 px-3.5 py-2 whitespace-nowrap">
                      {r.values?.[j] ?? "—"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
