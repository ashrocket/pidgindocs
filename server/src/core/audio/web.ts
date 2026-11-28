import { AUDIO_REPLY_CSS, audioReplyScript } from "../assignments/web";
import { assignmentCatalogs } from "../assignments/i18n";
import { translationLanguages, type Language } from "../translation-languages";
import { basePath, appPath } from "../base-path";
import { editionLoginPage, editionProductName } from "../edition-hooks";
import { resolveCallerUserId } from "../middleware";
import type { Env } from "../types";
import { navShell } from "../web/nav-shell";
import { theme } from "../web/theme";
import { lookupAudio } from "./service";
import { listAudioItems, isValidAudioId } from "./store";

const esc = (v: string) => v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
/** Self-hosted fallback; managed editions may provide their own audio library. */
export async function renderAudio(request: Request, env: Env, path: string): Promise<Response> {
  const userId = await resolveCallerUserId(request,env);
  if (!userId) return editionLoginPage(env);
  const page = await listAudioItems(env,userId,{limit:50});
  let focus = "";
  if (path !== "/audio") {
    try { focus = decodeURIComponent(path.slice(7)); } catch { return new Response("Not found",{status:404}); }
    const found = isValidAudioId(focus) ? await lookupAudio(env,userId,focus,false) : null;
    if (!found) return new Response("Not found",{status:404});
    if (!page.items.some(i=>i.id===focus)) page.items.unshift(found.item);
  }
  const nonce = crypto.randomUUID(), base = basePath(env);
  const requested=new URL(request.url).searchParams.get("lang")??request.headers.get("Accept-Language")?.split(",")[0]?.split("-")[0]??"en";
  const language=translationLanguages(env).includes(requested as Language)?requested as Language:"en";
  const labels:Record<string,string>=assignmentCatalogs[language],t=(key:string)=>labels[key];
  const data = JSON.stringify(page).replace(/</g,"\\u003c");
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t("Audio")} · ${esc(editionProductName())}</title>
<style>body{font:16px/1.5 system-ui;color:${theme.ink};background:${theme.sand};margin:0}main{max-width:760px;margin:0 auto;padding:24px 16px}article.audio-item{padding:20px;border-radius:12px;background:${theme.paper};margin:16px 0}audio{width:100%}a{color:${theme.primary}}h2{font-size:1.15rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;min-height:44px}${AUDIO_REPLY_CSS}</style></head><body>${navShell({nonce,base,userId})}<main><a href="${appPath(base,"/")}">${t("Inbox")}</a><h1>${t("Audio")}</h1><div id="audio-list"></div><button id="audio-more" hidden>${t("Show more")}</button><p id="audio-notice" role="status"></p></main>
<script nonce="${nonce}">${audioReplyScript(base)}
(function(){var data=${data},base=${JSON.stringify(base)},labels=${JSON.stringify(labels).replace(/</g,"\\u003c")},list=document.getElementById('audio-list'),more=document.getElementById('audio-more');
function append(item){var article=document.createElement('article');article.className='audio-item';var title=document.createElement('h2');title.textContent=item.title;article.appendChild(title);var player=null;
if(item.status==='ready'){player=document.createElement('audio');player.controls=true;player.preload='metadata';player.src=base+item.stream_url;article.appendChild(player);}
if(item.transcript_url){var link=document.createElement('a');link.href=base+item.transcript_url;link.textContent=labels['Transcript'];article.appendChild(link);}AudioReplies.mount(article,item.id,player);list.appendChild(article);}
data.items.forEach(append);more.hidden=!data.next_cursor;
more.onclick=async function(){more.disabled=true;try{var r=await fetch(base+'/api/audio?cursor='+encodeURIComponent(data.next_cursor),{credentials:'same-origin'});var b=await r.json();if(!r.ok||!b.ok)throw new Error();data=b.data;data.items.forEach(append);more.hidden=!data.next_cursor;}catch(e){document.getElementById('audio-notice').textContent=labels['Audio could not be loaded.'];}finally{more.disabled=false;}};
})();</script></body></html>`;
  return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store","Content-Security-Policy":`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,"X-Content-Type-Options":"nosniff"}});
}
