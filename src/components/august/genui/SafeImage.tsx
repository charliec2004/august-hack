"use client";

import { useState } from "react";
import { safeUrl } from "@/lib/genui";
import { cn } from "@/lib/utils";

/**
 * An image from evidence. Unparseable or broken URLs render `fallback`
 * (nothing by default) instead of a broken-image icon.
 */
export function SafeImage({
  src,
  alt,
  className,
  fallback = null,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const url = safeUrl(src);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!url || failed) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary evidence hosts
    <img
      src={url}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={cn("bg-muted object-cover transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0", className)}
    />
  );
}
