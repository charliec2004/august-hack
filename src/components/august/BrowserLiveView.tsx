"use client";

import { useEffect } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export type LiveViewTarget = {
  sessionId: string;
  responsibilityId: string | null;
};

const CLOSE_AFTER_END_MS = 2500;

/**
 * Modal that shows the live view of a page August is working in. `url` is
 * resolved from the latest polled state (live sessions only), so when the
 * session ends the frame is replaced with a quiet note and the modal closes.
 */
export function BrowserLiveView({
  open,
  title,
  url,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  url: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    if (!open || url) return;
    const timer = setTimeout(() => onOpenChange(false), CLOSE_AFTER_END_MS);
    return () => clearTimeout(timer);
  }, [open, url, onOpenChange]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/30 duration-150 supports-backdrop-filter:backdrop-blur-[2px]" />
        <DialogPrimitive.Popup className="bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(72rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl shadow-2xl ring-1 duration-150 outline-none">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <span
              className={
                url
                  ? "bg-live relative flex size-2 shrink-0 rounded-full"
                  : "bg-muted-foreground/40 flex size-2 shrink-0 rounded-full"
              }
              aria-hidden
            >
              {url && (
                <span className="bg-live absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-sm font-medium">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-muted-foreground text-xs">
                {url ? "Live, as August works" : "Ended"}
              </DialogPrimitive.Description>
            </div>
            {url && (
              <Button
                variant="ghost"
                size="sm"
                render={
                  <a href={url} target="_blank" rel="noopener noreferrer" />
                }
                nativeButton={false}
              >
                <ExternalLinkIcon />
                Open in new window
              </Button>
            )}
            <DialogPrimitive.Close
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
          <div className="bg-muted/40 relative aspect-[16/10] w-full">
            {url ? (
              <iframe
                key={url}
                src={url}
                title={`Live view: ${title}`}
                className="absolute inset-0 size-full border-0"
                allow="clipboard-read; clipboard-write; fullscreen"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
                This browser session has ended.
              </div>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
