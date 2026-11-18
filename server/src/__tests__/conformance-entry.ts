// Worker entry for PidginCore conformance runs. Unlike src/index.ts it installs no hosted-edition hooks.
export { TeamEventsDO } from "../core/events/live-events-do";

export default {
  fetch: (): Response => new Response("not found", { status: 404 }),
};
