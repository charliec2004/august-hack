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
  ShowPoll,
} from "@/lib/genui";
import type { TimelineActivityData, TimelineApprovalData } from "@/server/types/api";
import { ActivityLines } from "../ActivityFeed";
import { ApprovalPart } from "../ApprovalCard";
import { Chart } from "./chart/Chart";
import { ComparisonTable } from "./ComparisonTable";
import { ImageCard } from "./ImageCard";
import { MiniApp } from "./MiniApp";
import { OptionsCarousel } from "./OptionsCarousel";
import { Poll } from "./Poll";
import { QuestionForm } from "./QuestionForm";

/* Brain tool calls rendered as components, from their (possibly streaming) args. */

type FormArgs = Partial<AskUser> & LegacyAskUser;
const streaming = (status: { type: string }) => status.type === "running";

const ShowOptionsUI = makeAssistantToolUI<Partial<ShowOptions>, unknown>({
  toolName: "show_options",
  display: "standalone",
  render: ({ args }) => <OptionsCarousel data={args ?? {}} />,
});

const AskUserUI = makeAssistantToolUI<FormArgs, unknown>({
  toolName: "ask_user",
  display: "standalone",
  render: ({ args, status }) => <QuestionForm data={args ?? {}} complete={!streaming(status)} />,
});

const ShowPollUI = makeAssistantToolUI<Partial<ShowPoll>, unknown>({
  toolName: "show_poll",
  display: "standalone",
  render: ({ args, status }) => <Poll data={args ?? {}} complete={!streaming(status)} />,
});

const ShowChartUI = makeAssistantToolUI<Partial<ShowChart>, unknown>({
  toolName: "show_chart",
  display: "standalone",
  render: ({ args }) => <Chart data={args ?? {}} />,
});

const ShowAppUI = makeAssistantToolUI<Partial<ShowApp>, unknown>({
  toolName: "show_app",
  display: "standalone",
  render: ({ args, status }) => <MiniApp data={args ?? {}} complete={!streaming(status)} />,
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

const OptionsDataUI = makeAssistantDataUI<ShowOptions>({
  name: "options",
  render: ({ data }) => <OptionsCarousel data={data ?? {}} />,
});

const QuestionDataUI = makeAssistantDataUI<FormArgs>({
  name: "question",
  render: ({ data }) => <QuestionForm data={data ?? {}} />,
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
      <ShowAppUI />
      <ShowImageUI />
      <ShowComparisonUI />
      <ActivityDataUI />
      <ApprovalDataUI />
      <OptionsDataUI />
      <QuestionDataUI />
      <ChartDataUI />
    </>
  );
}
