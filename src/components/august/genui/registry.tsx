"use client";

import { makeAssistantDataUI, makeAssistantToolUI } from "@assistant-ui/react";
import type { AskUser, ShowComparison, ShowImage, ShowOptions } from "@/lib/genui";
import type { TimelineActivityData, TimelineApprovalData } from "@/server/types/api";
import { ActivityLines } from "../ActivityFeed";
import { ApprovalPart } from "../ApprovalCard";
import { ChoiceQuestion } from "./ChoiceQuestion";
import { ComparisonTable } from "./ComparisonTable";
import { ImageCard } from "./ImageCard";
import { OptionsCarousel } from "./OptionsCarousel";

/* Brain tool calls rendered as components, from their (possibly streaming) args. */

const ShowOptionsUI = makeAssistantToolUI<Partial<ShowOptions>, unknown>({
  toolName: "show_options",
  display: "standalone",
  render: ({ args }) => <OptionsCarousel data={args ?? {}} />,
});

const AskUserUI = makeAssistantToolUI<Partial<AskUser>, unknown>({
  toolName: "ask_user",
  display: "standalone",
  render: ({ args }) => <ChoiceQuestion data={args ?? {}} />,
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

const QuestionDataUI = makeAssistantDataUI<AskUser>({
  name: "question",
  render: ({ data }) => <ChoiceQuestion data={data ?? {}} />,
});

/** Mount once inside the AssistantRuntimeProvider to register every renderer. */
export function AugustRenderers() {
  return (
    <>
      <ShowOptionsUI />
      <AskUserUI />
      <ShowImageUI />
      <ShowComparisonUI />
      <ActivityDataUI />
      <ApprovalDataUI />
      <OptionsDataUI />
      <QuestionDataUI />
    </>
  );
}
