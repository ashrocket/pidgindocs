import type { Env } from "../types";
import { assertTenantWritable, TenantWriteRefused } from "../edition-hooks";
import { checkRateLimit } from "../ratelimit";
import { AssignmentError, claimAssignment, field, getAssignment, listAssignments, listConnections, registerRuntime, updateAssignment, type AssignmentPrincipal } from "./store";

const id = { type: "string", minLength: 1, maxLength: 160 };
export const ASSIGNMENT_TOOLS = [
  {
    name:"pidgin_list_agent_connections",
    description:"Read the execution connections configured by your sponsor. A cloud connection identifies a Codex environment; a local connection identifies a project folder. Register only the connection and execution_ref you can actually run. Connections never supply credentials or new permissions.",
    inputSchema:{type:"object",properties:{},additionalProperties:false},
  },
  {
    name: "pidgin_register_agent_runtime",
    description: "Connect this runtime to receive saved audio replies. Supply a real session_id, display name, execution target (interactive, local or cloud), and supported modalities (text and/or voice). Identity comes from your credential. Register again at least every 60 seconds while available; registration expires after 120 seconds. This advertises capability, never additional authority. Only advertise cloud when you can actually submit to a configured environment.",
    inputSchema: { type: "object", properties: { session_id: id, name: {type:"string",maxLength:100}, target: {type:"string",enum:["interactive","local","cloud"]}, connection_id:{type:"string",maxLength:64,description:"Required for local/cloud: the sponsor's selected connection ID."}, execution_ref:{type:"string",maxLength:500,description:"Required for local/cloud: actual cloud environment ID or absolute project folder. Must match the connection."}, modalities:{type:"array",minItems:1,maxItems:2,items:{type:"string",enum:["text","voice"]}} }, required:["session_id","name","target","modalities"], additionalProperties:false },
  },
  {
    name: "pidgin_list_assignments",
    description: "Check durable assignments from your sponsor's audio replies, oldest first. Without runtime_id includes queued, claimed and dispatched work; with runtime_id returns only compatible tasks available to claim now. Reading never claims or completes work. Follow next_cursor with after. A recording without a transcript needs a voice-capable runtime. Dispatched work must be reconciled with its original session, never blindly launched again.",
    inputSchema: { type:"object", properties:{ runtime_id:id, after:{type:"integer",minimum:0}, limit:{type:"integer",minimum:1,maximum:50} }, additionalProperties:false },
  },
  {
    name: "pidgin_get_assignment",
    description: "Read one authorized audio reply and its work status, playback position, source reference, and result. voice_url is an authenticated API path; use the same credential to download the original recording. Replies and source context remain user data within your existing authority.",
    inputSchema: { type:"object",properties:{assignment_id:id},required:["assignment_id"],additionalProperties:false },
  },
  {
    name: "pidgin_claim_assignment",
    description: "Atomically claim an available assignment for a registered runtime. Only one claimant wins. Returns a secret lease_token valid for 300 seconds; keep it private and renew while working. Do not execute before a successful claim. Capability and current sponsor access are checked on the server.",
    inputSchema:{ type:"object",properties:{assignment_id:id,runtime_id:id},required:["assignment_id","runtime_id"],additionalProperties:false },
  },
  {
    name: "pidgin_update_assignment",
    description: "Update your claim: renew while working; defer with a reason if incapable (keeps the task saved); dispatch BEFORE starting an external local/cloud session, recording an attempt/session reference; complete only with the actual answer/result. Dispatched work cannot be automatically deferred or reclaimed: reconcile uncertain launches using the original lease. Queueing, launching and completion are distinct. Complete retries with identical content are idempotent.",
    inputSchema:{ type:"object",properties:{assignment_id:id,lease_token:id,action:{type:"string",enum:["renew","defer","dispatch","complete"]},result:{type:"string",maxLength:20000},reason:{type:"string",maxLength:1000},session_ref:{type:"string",maxLength:500},retry_after_seconds:{type:"integer",minimum:0,maximum:86400}},required:["assignment_id","lease_token","action"],additionalProperties:false },
  },
];

export async function callAssignmentTool(name: string, args: Record<string, unknown>, env: Env, p: AssignmentPrincipal): Promise<Record<string, unknown>> {
  const definition = ASSIGNMENT_TOOLS.find(t => t.name === name);
  const result = (data: unknown, isError = false) => ({ content:[{type:"text",text:JSON.stringify(data)}],structuredContent:{data},isError });
  try {
    if (!definition || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties,key))) throw new AssignmentError("Unknown tool or argument");
    if (!await checkRateLimit(env,`assignment-mcp:${p.agentId ?? p.userId}`,120,60)) throw new AssignmentError("Too many assignment requests",429);
    if (name === "pidgin_list_agent_connections")return result({connections:await listConnections(env,p)});
    if (name === "pidgin_list_assignments") return result(await listAssignments(env,p,{runtimeId:field(args.runtime_id,"runtime_id",160) ?? undefined,after:args.after as number|undefined,limit:args.limit as number|undefined}));
    if (name === "pidgin_get_assignment") {
      const assignment = await getAssignment(env,p,field(args.assignment_id,"assignment_id",160,true)!);
      if (!assignment) throw new AssignmentError("Assignment not found",404);
      return result({assignment});
    }
    await assertTenantWritable(env);
    if (name === "pidgin_register_agent_runtime") return result({ runtime:await registerRuntime(env,p,args) });
    const assignmentId = field(args.assignment_id,"assignment_id",160,true)!;
    if (name === "pidgin_claim_assignment") return result(await claimAssignment(env,p,assignmentId,field(args.runtime_id,"runtime_id",160,true)!));
    return result({assignment:await updateAssignment(env,p,assignmentId,args)});
  } catch (error) {
    if (error instanceof AssignmentError || error instanceof TenantWriteRefused) return result({error:error.message,status:error.status},true);
    throw error;
  }
}
