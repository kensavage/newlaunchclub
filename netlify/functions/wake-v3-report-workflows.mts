import type { Config } from "@netlify/functions";
import { wakeWorkflowConsumer } from "../../src/lib/workflow/wakeup-client";

export default async function wakeV3ReportWorkflows() {
  await wakeWorkflowConsumer();
}

export const config: Config = {
  schedule: "*/5 * * * *"
};
