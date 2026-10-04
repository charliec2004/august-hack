"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Markdown outside a message (e.g. evidence summaries), styled like the
 * thread's markdown. Links open in a new tab.
 */
export function MarkdownBlock({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "text-foreground/85 text-sm leading-relaxed wrap-break-word",
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_a]:text-primary [&_a:hover]:text-primary/80 [&_a]:underline [&_a]:underline-offset-2",
        "[&_ul]:marker:text-muted-foreground [&_ul]:my-2 [&_ul]:ms-5 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:ms-5 [&_ol]:list-decimal [&_li]:mt-1",
        "[&_strong]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-medium",
        "[&_blockquote]:border-muted-foreground/30 [&_blockquote]:text-muted-foreground [&_blockquote]:my-2 [&_blockquote]:border-s-2 [&_blockquote]:ps-3",
        "[&_code]:bg-muted [&_code]:rounded-md [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre]:bg-muted/40 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border-b [&_td]:px-2 [&_td]:py-1 [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
