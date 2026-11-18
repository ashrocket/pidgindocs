import type { Env } from "./types";
import { editionAgentSponsorAccessSql, editionAccountActiveSql } from "./edition-hooks";


/**
 * What a key's sponsor (the `owner` users row, already joined as active) must
 * also satisfy, for REST and MCP alike. Core requires an active account (an
 * edition decides what that means); an edition may add its sign-in rules.
 * Bind-free, so it never shifts a caller's positional binds.
 */
export function agentSponsorAccessSql(env: Env, owner = "owner"): string {
  return editionAgentSponsorAccessSql(env, owner) ?? editionAccountActiveSql(owner);
}

