import { editionSlug } from "../wire-names";
import { appPath } from "../base-path";
import { editionProductName } from "../edition-hooks";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The account consent presentation. The route owns every authorization check. */
export function oauthConsentHtml(input: {
  clientName: string;
  accountEmail: string;
  destination: string;
  requestId: string;
  csrf: string;
  /** Server-rendered, escaped team/agent controls; never client-provided HTML. */
  agentSection: string;
  boardPostingOff: boolean;
  /** URL path prefix of this deployment: basePath(env). */
  base?: string;
}): string {
  const base = input.base ?? "";
  const name = escapeHtml(input.clientName);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Connect ${name} · ${editionProductName()}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:40px 24px;background:#f7f8f6;color:#183c3c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;-webkit-text-size-adjust:100%}
main{width:100%;min-width:0;max-width:520px;padding:40px;border:1px solid #dce4e0;border-radius:18px;background:#fff;box-shadow:0 8px 32px #183c3c05;overflow-wrap:anywhere}
.consent-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:flex;gap:9px;align-items:center;font-size:20px;font-weight:700;letter-spacing:-.5px}
.brand img{width:34px;height:34px;border-radius:9px}
h1{font-size:32px;line-height:1.2;letter-spacing:-.7px;margin:32px 0 16px}
p{line-height:1.6;color:#526663;margin:0 0 20px}
.app-name{color:#183c3c;overflow-wrap:anywhere}
.account{display:flex;align-items:center;gap:12px;padding:16px 18px;background:#f4f7f5;border:1px solid #e3eae6;border-radius:10px;margin:24px 0 28px}
.account-icon{width:28px;height:28px;flex:0 0 auto;fill:none;stroke:#426460;stroke-width:1.6}
.account-label{display:block;font-size:13px;line-height:1.5;color:#526663;margin-bottom:4px}
.account-email{display:block;font-size:16px;line-height:1.5;overflow-wrap:anywhere;color:#183c3c}
.permissions{list-style:none;padding:0;margin:0 0 28px}
.permissions li{display:flex;gap:12px;align-items:flex-start;line-height:1.6;margin:16px 0;color:#425a56}
.check{color:#2c6362;flex:0 0 auto;margin-top:1px}
.permissions p{color:inherit;margin:0}
details{border-top:1px solid #e3eae6;border-bottom:1px solid #e3eae6;margin:28px 0}
summary{cursor:pointer;min-height:52px;padding:16px 0;color:#526663;font-size:15px;line-height:1.5}
summary:hover{color:#183c3c}
.details-body{padding:4px 0 24px}
.details-body p{font-size:14px}
.detail-label{display:block;font-size:14px;line-height:1.5;color:#526663;margin:16px 0 8px}
code{display:block;overflow-wrap:anywhere;padding:12px 14px;margin-bottom:20px;border:1px solid #e3eae6;border-radius:8px;background:#f4f7f5;color:#183c3c;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.note{font-size:14px;color:#60716e}
.board-notice{font-size:14px;border-left:2px solid #d9b88f;padding-left:14px}
.agent-settings{border-top:1px solid #e3eae6;margin-top:24px;padding-top:20px}
.agent-settings p{font-size:14px}
.agent-settings label{display:block;font-size:14px;line-height:1.5;font-weight:600;margin:20px 0 8px}
select{width:100%;min-width:0;max-width:100%;min-height:48px;font:inherit;font-size:16px;padding:11px 12px;border:1px solid #c9d6d0;border-radius:8px;background:#fff;color:#183c3c}
.team-name{font-weight:600}
.actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-top:28px}
button{min-height:50px;padding:12px;border-radius:9px;border:1px solid #c9d6d0;font:inherit;font-size:16px;font-weight:650;cursor:pointer;background:white;color:#2c6362}
button[value=allow]{background:#2c6362;color:white;border-color:#2c6362}
button:hover{background:#f3f7f4}
button[value=allow]:hover{background:#214f4e}
button:focus-visible,summary:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #b18a59;outline-offset:3px}
.footnote{text-align:center;font-size:14px;line-height:1.6;color:#60716e;margin:24px 0 0}
a{color:#2c6362;text-underline-offset:3px}
@media(max-width:480px){body{padding:24px 12px}
main{padding:28px 20px;border-radius:16px}
h1{font-size:28px;margin-top:28px}
}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}
}

</style></head><body><main><header class="consent-header"><div class="brand"><img src="${appPath(base, "/assets/app-icon.jpg?v=${editionSlug()}-4")}" alt="">${editionProductName()}</div></header><h1>Connect to ${editionProductName()}</h1><p><strong class="app-name" translate="no">${name}</strong> <span>wants to use your ${editionProductName()} account.</span></p><div class="account"><svg class="account-icon" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="9" r="4"></circle><path d="M6 24v-3a8 8 0 0 1 16 0v3"></path></svg><div><span class="account-label">Signed in as</span><span class="account-email" translate="no">${escapeHtml(input.accountEmail)}</span></div></div><ul class="permissions"><li><span class="check" aria-hidden="true">✓</span><p>Read your content and team spaces.</p></li><li><span class="check" aria-hidden="true">✓</span><p>Publish updates and manage content with your permissions.</p></li></ul>${input.agentSection ? `<p class="board-notice" id="oauth-board-notice"${input.boardPostingOff ? "" : " hidden"}>Team board posting is off. You can change this in Connection details.</p>` : ""}<form method="post" action="${appPath(base, "/oauth/authorize")}"><input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><details><summary>Connection details</summary><div class="details-body"><span class="detail-label">Return address</span><code>${escapeHtml(input.destination)}</code><p class="note">This connection renews when used and expires after 30 days of inactivity.</p><p class="note">You can disconnect this app in Get started.</p>${input.agentSection}</div></details><div class="actions"><button name="decision" value="deny" type="submit">Cancel</button><button name="decision" value="allow" type="submit">Connect</button></div></form><p class="footnote">Only connect if you started this request.</p></main></body></html>`;
}
