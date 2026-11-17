import type { Env } from '../types';
import { resolveCallerCredential } from '../middleware';
import { resolveAgentCredential } from '../agent-board';
import { TenantWriteRefused } from '../edition-hooks';
import { DocumentAudienceError, getDocumentAudience, saveDocumentAudience, applyDocumentAudience, type Audience } from '../document-audience';
const respond=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export async function handleDocumentAudience(request:Request,env:Env):Promise<Response>{
 try{
  const url=new URL(request.url),origin=request.headers.get('Origin');
  if((origin!==null && origin!==url.origin)||request.headers.get('Sec-Fetch-Site')==='cross-site')return respond({ok:false,error:'Request origin is not allowed'},403);
  if(request.headers.get('Authorization')?.startsWith('Agent ') || await resolveAgentCredential(request.headers,env))return respond({ok:false,error:'A personal credential is required'},401);
  const caller=await resolveCallerCredential(request,env);if(!caller)return respond({ok:false,error:'Sign in to manage document sharing'},401);
  if(request.method==='GET')return respond({ok:true,data:await getDocumentAudience(env,url.searchParams.get('team_id')??'',caller.userId)});
  if(request.method!=='POST')return respond({ok:false,error:'Method not allowed'},405);
  if(caller.via==='web_cookie' && origin!==url.origin)return respond({ok:false,error:'Request origin is not allowed'},403);
  if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw new DocumentAudienceError('Invalid document audience request');
  const reader=request.body?.getReader();if(!reader)throw new DocumentAudienceError('Invalid document audience request');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new DocumentAudienceError('Request is too large',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body:Record<string,unknown>;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DocumentAudienceError('Invalid document audience request');}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','team_id','audience','role_id','expected_revision','cursor'].includes(k))||typeof body.team_id!=='string'||!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<0)throw new DocumentAudienceError('Invalid document audience request');
  const common={teamId:body.team_id,userId:caller.userId,expectedRevision:Number(body.expected_revision)};
  if(body.action==='apply'){if(body.cursor!==undefined&&(typeof body.cursor!=='string'||body.cursor.length>300))throw new DocumentAudienceError('Invalid document audience request');return respond({ok:true,data:await applyDocumentAudience(env,{...common,cursor:body.cursor as string|undefined})});}
  if(body.action!=='save'||(body.role_id!==undefined&&body.role_id!==null&&typeof body.role_id!=='string'))throw new DocumentAudienceError('Invalid document audience request');
  return respond({ok:true,data:await saveDocumentAudience(env,{...common,audience:body.audience as Audience,roleId:body.role_id as string|null|undefined})});
 }catch(error){if(error instanceof TenantWriteRefused)return respond({ok:false,error:error.message},error.status);if(error instanceof DocumentAudienceError)return respond({ok:false,error:error.message},error.status);throw error;}
}
