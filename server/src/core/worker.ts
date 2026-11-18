// PidginCore's own Worker entry: the router with no edition around it. It exports the Durable Object
// classes that the Worker needs, and scripts/check-core-bundle.mjs checks that this entry bundles
// nothing from outside core/.
import app from "./app";
import { selfHostEntry } from "./self-host";

export default selfHostEntry(app);
export { json, corsHeaders } from "./utils";
export { TeamEventsDO } from "./events/live-events-do";
export { MatrixSyncDO } from "./chat/matrix-sync-do";
