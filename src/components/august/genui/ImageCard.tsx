"use client";

import { ArrowUpRightIcon, ImageOffIcon } from "lucide-react";
import { safeUrl, type ShowImage } from "@/lib/genui";
import { hostOf } from "../format";
import { SafeImage } from "./SafeImage";

/** One image with an optional caption and source link; quiet when it can't load. */
export function ImageCard({ data }: { data: Partial<ShowImage> }) {
  const source = safeUrl(data.sourceUrl);
  if (!data.url) return null;
  return (
    <figure className="my-3 max-w-md">
      <div className="overflow-hidden rounded-2xl border">
        <SafeImage
          src={data.url}
          alt={data.caption ?? ""}
          className="max-h-[22rem] w-full"
          fallback={
            <div className="bg-muted/50 text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
              <ImageOffIcon className="size-4" />
              Image unavailable
            </div>
          }
        />
      </div>
      {(data.caption || source) && (
        <figcaption className="text-muted-foreground mt-1.5 flex items-baseline gap-2 text-[13px]">
          {data.caption && <span className="min-w-0 flex-1">{data.caption}</span>}
          {source && (
            <a
              href={source}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground inline-flex shrink-0 items-center gap-0.5 transition-colors"
            >
              {hostOf(source)}
              <ArrowUpRightIcon className="size-3" />
            </a>
          )}
        </figcaption>
      )}
    </figure>
  );
}
