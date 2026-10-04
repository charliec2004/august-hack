"use client";

import { makeAssistantDataUI, makeAssistantToolUI } from "@assistant-ui/react";
import type {
  AskUser,
  LegacyAskUser,
  ShowApp,
  ShowChart,
  ShowComparison,
  ShowImage,
  ShowOptions,
  ShownHtml,
  ShowPoll,
} from "@/lib/genui";
import type { TimelineActivityData, TimelineApprovalData } from "@/server/types/api";
import { ActivityLines } from "../ActivityFeed";
import { ApprovalPart } from "../ApprovalCard";
import { Chart } from "./chart/Chart";
import { useDataCardId } from "./hooks";
import { ComparisonTable } from "./ComparisonTable";
import { GenUiSkeleton } from "./GenUiSkeleton";
import { ImageCard } from "./ImageCard";
import { MiniApp } from "./MiniApp";
import { OptionsCarousel } from "./OptionsCarousel";
import { Poll } from "./Poll";
import { QuestionForm } from "./QuestionForm";

/*
 * Brain tool calls rendered as components, from their (possibly streaming) args.
 * show_options, show_comparison, and show_image are no longer Brain tools; their
 * renderers stay so older messages still render.
 */

type FormArgs = Partial<AskUser> & LegacyAskUser;
const streaming = (status: { type: string }) => status.type === "running";

const ShowOptionsUI = makeAssistantToolUI<Partial<ShowOptions>, unknown>({
  toolName: "show_options",
  display: "standalone",
  render: ({ args, toolCallId }) => <OptionsCarousel cardId={toolCallId} data={args ?? {}} />,
});

const AskUserUI = makeAssistantToolUI<FormArgs, unknown>({
  toolName: "ask_user",
  display: "standalone",
  render: ({ args, status, toolCallId }) =>
    streaming(status) ? <GenUiSkeleton kind="form" /> : <QuestionForm cardId={toolCallId} data={args ?? {}} />,
});

const ShowPollUI = makeAssistantToolUI<Partial<ShowPoll>, unknown>({
  toolName: "show_poll",
  display: "standalone",
  render: ({ args, status, toolCallId }) =>
    streaming(status) ? <GenUiSkeleton kind="poll" /> : <Poll cardId={toolCallId} data={args ?? {}} />,
});

const ShowChartUI = makeAssistantToolUI<Partial<ShowChart>, unknown>({
  toolName: "show_chart",
  display: "standalone",
  render: ({ args, status }) => (streaming(status) ? <GenUiSkeleton kind="chart" /> : <Chart data={args ?? {}} />),
});

/** Generated HTML renders only the server-vetted document from the tool result. */
const ShowHtmlUI = makeAssistantToolUI<Partial<ShowApp>, Partial<ShownHtml>>({
  toolName: "show_html",
  display: "standalone",
  render: ({ args, result, status }) =>
    status.type === "incomplete" ? null : (
      <MiniApp
        title={args?.title}
        html={result?.html}
        images={result?.images ?? []}
        height={args?.height}
        complete={Boolean(result?.html)}
      />
    ),
});

/** Older generated apps (show_app), from before image vetting: no remote images. */
const ShowAppUI = makeAssistantToolUI<Partial<ShowApp>, unknown>({
  toolName: "show_app",
  display: "standalone",
  render: ({ args, status }) => (
    <MiniApp title={args?.title} html={args?.html} height={args?.height} complete={!streaming(status)} />
  ),
});

const ShowImageUI = makeAssistantToolUI<Partial<ShowImage>, unknown>({
  toolName: "show_image",
  display: "standalone",
  render: ({ args }) => <ImageCard data={args ?? {}} />,
});

const ShowComparisonUI = makeAssistantToolUI<Partial<ShowComparison>, unknown>({
  toolName: "show_comparison",
  display: "standalone",
  render: ({ args }) => <ComparisonTable data={args ?? {}} />,
});

/* Timeline and async-delivery data parts (GET /api/messages). */

const ActivityDataUI = makeAssistantDataUI<TimelineActivityData>({
  name: "activity",
  render: ({ data }) => <ActivityLines items={data?.items ?? []} />,
});

const ApprovalDataUI = makeAssistantDataUI<TimelineApprovalData>({
  name: "approval",
  render: ({ data }) => (data?.effectId ? <ApprovalPart data={data} /> : null),
});

/* Delivery cards carry their own stable id in the part data. */
type WithId = { id?: string | null };

function DeliveredOptions({ data }: { data: ShowOptions & WithId }) {
  return <OptionsCarousel cardId={useDataCardId(data.id)} data={data} />;
}

function DeliveredQuestion({ data }: { data: FormArgs & WithId }) {
  return <QuestionForm cardId={useDataCardId(data.id)} data={data} />;
}

const OptionsDataUI = makeAssistantDataUI<ShowOptions & WithId>({
  name: "options",
  render: ({ data }) => <DeliveredOptions data={data ?? { title: "", options: [] }} />,
});

const QuestionDataUI = makeAssistantDataUI<FormArgs & WithId>({
  name: "question",
  render: ({ data }) => <DeliveredQuestion data={data ?? {}} />,
});

const HtmlDataUI = makeAssistantDataUI<{ title: string; html: string; images?: string[] }>({
  name: "html",
  render: ({ data }) => <MiniApp title={data?.title} html={data?.html} images={data?.images ?? []} />,
});

const ChartDataUI = makeAssistantDataUI<ShowChart>({
  name: "chart",
  render: ({ data }) => <Chart data={data ?? {}} />,
});

/** Mount once inside the AssistantRuntimeProvider to register every renderer. */
export function AugustRenderers() {
  return (
    <>
      <ShowOptionsUI />
      <AskUserUI />
      <ShowPollUI />
      <ShowChartUI />
      <ShowHtmlUI />
      <ShowAppUI />
      <ShowImageUI />
      <ShowComparisonUI />
      <ActivityDataUI />
      <ApprovalDataUI />
      <OptionsDataUI />
      <QuestionDataUI />
      <ChartDataUI />
      <HtmlDataUI />
    </>
  );
}
