"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The right-side sheet every inspection surface uses (drawer, logins, ...). */
export function SidePanel({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-40 bg-black/15 duration-200" />
        <DialogPrimitive.Popup className="bg-background data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l shadow-2xl duration-200 outline-none">
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Serif title, optional quiet subtitle, close button. */
export function SidePanelHeader({
  title,
  subtitle,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
}) {
  return (
    <header className="flex items-start gap-3 px-6 pt-6 pb-2">
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="font-heading text-xl leading-tight font-medium tracking-tight">
          {title}
        </DialogPrimitive.Title>
        {subtitle && (
          <DialogPrimitive.Description className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            {subtitle}
          </DialogPrimitive.Description>
        )}
      </div>
      <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" />}>
        <XIcon />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </header>
  );
}

export function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}
