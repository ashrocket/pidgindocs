import type { Env } from './types';
import { contentPolicy, restrictedContentTeams } from './content-policy';
import { assertTenantWritable } from './edition-hooks';
export class DocumentAudienceError extends Error { constructor(message:string,public status=400){super(message);} }
export type Audience = 'private'|'team'|'role';
export type Preference = {audience:Audience;role_id:string|null;revision:number};
export type DocumentAudienceInput = {documentId:string;teamId:string;userId:string;docSlug?:string|null};
type Hook = {
 options(env:Env,teamId:string):Promise<{id:string;name:string;kind:string}[]>;
 statements(env:Env,input:DocumentAudienceInput,preference:Preference,boardProjectId?:string):Promise<D1PreparedStatement[]>;
};
let hook:Hook|undefined;
export function installDocumentAudienceHook(value:Hook){hook=value;}
const active = `EXISTS(SELECT 1 FROM team_memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND m.user_id=? AND u.status='active' AND m.role IN ('owner','admin','member'))`;
async function member(env:Env,teamId:string,userId:string){
 if(!contentPolicy().documentDefaultsEnabled)throw new DocumentAudienceError('Document sharing settings are unavailable',404);
 if(!teamId || !await env.DB.prepare(`SELECT 1 WHERE ${active}`).bind(teamId,userId).first())throw new DocumentAudienceError('Active team membership with write access required',403);
}
/** Resolve only an opted-in saved audience. Explicit document visibility and
 * supplied teams always win; a project can narrow the eligible team set. */
export async function resolveDocumentDefaultTeam(env:Env,input:{userId?:string|null;teamId?:string|null;projectId?:string|null;sharing?:string|null;isPublic?:boolean}):Promise<string|null>{
 if(!contentPolicy().documentDefaultsEnabled || input.teamId || !input.userId || input.sharing!=null || input.isPublic)return input.teamId??null;
 const rows=(await env.DB.prepare(`SELECT p.team_id FROM document_audience_preferences p
 JOIN team_memberships m ON m.team_id=p.team_id AND m.user_id=p.user_id
 JOIN users u ON u.id=p.user_id
 WHERE p.user_id=? AND p.audience IN ('team','role') AND u.status='active'
 AND m.role IN ('owner','admin','member')
 AND (? IS NULL OR EXISTS(SELECT 1 FROM projects project WHERE project.id=? AND project.team_id=p.team_id AND project.archived_at IS NULL AND project.board_kind<>'work'))
 ORDER BY p.team_id LIMIT 2`).bind(input.userId,input.projectId??null,input.projectId??null).all<{team_id:string}>()).results;
 if(rows.length>1)throw new DocumentAudienceError('Choose a team (team_id) before applying a saved document audience');
 return rows[0]?.team_id??null;
}
export async function getDocumentAudience(env:Env,teamId:string,userId:string){
 await member(env,teamId,userId);
 const preference=await env.DB.prepare('SELECT audience,role_id,revision FROM document_audience_preferences WHERE team_id=? AND user_id=?').bind(teamId,userId).first<Preference>() ?? {audience:'private' as const,role_id:null,revision:0};
 const governed=await restrictedContentTeams(env,teamId);
 return {team_id:teamId,preference,governed,roles:governed && hook ? await hook.options(env,teamId):[]};
}
export async function saveDocumentAudience(env:Env,input:{teamId:string;userId:string;audience:Audience;roleId?:string|null;expectedRevision:number}){
 await assertTenantWritable(env);
 const state=await getDocumentAudience(env,input.teamId,input.userId);
 if(!['private','team','role'].includes(input.audience) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0)throw new DocumentAudienceError('Invalid document audience');
 if(input.audience==='role' && (!input.roleId || !state.roles.some(r=>r.id===input.roleId)))throw new DocumentAudienceError('Choose an access role from this team');
 if(input.audience!=='role' && input.roleId)throw new DocumentAudienceError('Unexpected access role');
 const id=crypto.randomUUID();
 const guard=`${active} AND COALESCE((SELECT revision FROM document_audience_preferences WHERE team_id=? AND user_id=?),0)=?`;
 const extra=input.audience==='role' ? ' AND EXISTS(SELECT 1 FROM team_access_roles WHERE team_id=? AND id=?)':'';
 const result=await env.DB.batch([
  env.DB.prepare(`INSERT INTO document_audience_audit(id,team_id,user_id,action,details) SELECT ?,?,?,'save',? WHERE ${guard}${extra}`).bind(id,input.teamId,input.userId,JSON.stringify({before:state.preference,after:{audience:input.audience,role_id:input.roleId??null}}),input.teamId,input.userId,input.teamId,input.userId,input.expectedRevision,...(input.audience==='role'?[input.teamId,input.roleId]:[])),
  env.DB.prepare(`INSERT INTO document_audience_preferences(team_id,user_id,audience,role_id,revision) SELECT ?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM document_audience_audit WHERE id=?) ON CONFLICT(team_id,user_id) DO UPDATE SET audience=excluded.audience,role_id=excluded.role_id,revision=document_audience_preferences.revision+1`).bind(input.teamId,input.userId,input.audience,input.roleId??null,id)
 ]);
 if(!result[0].meta.changes)throw new DocumentAudienceError('Settings changed; refresh before saving',409);
 return getDocumentAudience(env,input.teamId,input.userId);
}
export async function documentDefaultStatements(env:Env,input:DocumentAudienceInput, savedPreference?:Preference):Promise<D1PreparedStatement[]>{
 if(!contentPolicy().documentDefaultsEnabled)return [];
 const preference=savedPreference ?? await env.DB.prepare('SELECT audience,role_id,revision FROM document_audience_preferences WHERE team_id=? AND user_id=?').bind(input.teamId,input.userId).first<Preference>();
 if(!preference || preference.audience==='private')return [];
 if(await restrictedContentTeams(env,input.teamId))return hook ? hook.statements(env,input,preference):[];
 if(preference.audience!=='team')return [];
 const key=input.docSlug??input.documentId;
 const auditId=crypto.randomUUID();
 const allowed=`${active} AND ${contentPolicy().unrestrictedTeamSql('messages.team_id')}
 AND EXISTS(SELECT 1 FROM document_audience_preferences WHERE team_id=? AND user_id=? AND revision=? AND audience='team')
 AND NOT EXISTS(SELECT 1 FROM messages family WHERE family.team_id=? AND family.type='document' AND COALESCE(family.doc_slug,family.id)=? AND (family.user_id IS NOT ? OR family.sharing_explicit=1))`;
 return [env.DB.prepare(`INSERT INTO document_audience_audit(id,team_id,user_id,action,details) SELECT ?,?,?,'apply',? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND team_id=? AND type='document' AND user_id=? AND sharing='private' AND sharing_explicit=0 AND ${allowed})`).bind(auditId,input.teamId,input.userId,JSON.stringify({resource_key:key,audience:'team'}),input.documentId,input.teamId,input.userId,input.teamId,input.userId,input.teamId,input.userId,preference.revision,input.teamId,key,input.userId),
 env.DB.prepare(`UPDATE messages SET sharing='shared' WHERE team_id=? AND type='document' AND COALESCE(doc_slug,id)=? AND user_id=? AND EXISTS(SELECT 1 FROM document_audience_audit WHERE id=?)`).bind(input.teamId,key,input.userId,auditId)];
}
export async function boardDocumentAudienceStatements(env:Env,input:DocumentAudienceInput & {projectId:string}):Promise<D1PreparedStatement[]>{
 if(await restrictedContentTeams(env,input.teamId)){
  if(!hook)throw new DocumentAudienceError('Document audience unavailable',409);
  return hook.statements(env,input,{audience:'team',role_id:null,revision:0},input.projectId);
 }
 return [env.DB.prepare("UPDATE messages SET sharing='shared' WHERE id=? AND team_id=? AND user_id=? AND type='document'").bind(input.documentId,input.teamId,input.userId)];
}
export async function applyDocumentAudience(env:Env,input:{teamId:string;userId:string;expectedRevision:number;cursor?:string}){
 await assertTenantWritable(env);
 const {preference}=await getDocumentAudience(env,input.teamId,input.userId);
 if(preference.revision!==input.expectedRevision)throw new DocumentAudienceError('Settings changed; refresh before applying',409);
 // Private affects future documents only. Applying never revokes existing grants.
 const candidates=(await env.DB.prepare("SELECT MIN(id) AS id,COALESCE(doc_slug,id) AS resource_key FROM messages WHERE team_id=? AND user_id=? AND type='document' AND COALESCE(doc_slug,id)>? GROUP BY COALESCE(doc_slug,id) ORDER BY resource_key LIMIT 51").bind(input.teamId,input.userId,input.cursor??'').all<{id:string;resource_key:string}>()).results;
 const personal=Number((await env.DB.prepare("SELECT COUNT(DISTINCT COALESCE(doc_slug,id)) AS n FROM messages WHERE team_id IS NULL AND user_id=? AND type='document'").bind(input.userId).first<{n:number}>())?.n??0);
 let applied=0,skipped=0;
 for(const row of candidates.slice(0,50)){
  if(preference.audience==='private'){skipped++;continue;}
  const statements=await documentDefaultStatements(env,{documentId:row.id,docSlug:row.resource_key,teamId:input.teamId,userId:input.userId},preference);
  if(!statements.length){skipped++;continue;}
  const result=await env.DB.batch(statements);
  if(result[0].meta.changes)applied++;else skipped++;
 }
 return {applied,skipped,personal,next_cursor:candidates.length>50?candidates[49].resource_key:null};
}
