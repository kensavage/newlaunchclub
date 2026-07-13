import type { Config } from "@netlify/functions";
import { wakeNetlifyWorkflowConsumer } from "../runtime/wakeup-client";

export default async function wakeV3ReportWorkflows() {
  await wakeNetlifyWorkflowConsumer();
}

export const config: Config = {
  schedule: "*/5 * * * *"
};
