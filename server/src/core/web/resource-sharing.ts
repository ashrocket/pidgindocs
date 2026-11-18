/** Owner-only, deliberate publication controls shared by the personal libraries. */
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function resourceSharingControl(kind: "document" | "artifact", id: string, sharing: string | undefined,
  teamId: string | null | undefined, teams: Array<{ id: string; name: string }>): string {
  if (!teamId && !teams.length) return "";
  const select = !teamId && teams.length > 1
    ? `<select aria-label="Team to publish to" data-sharing-team><option value="">Choose a team</option>${teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select>` : "";
  return `<span class="resource-sharing">${select}<button type="button" data-resource-sharing="${sharing === "shared" ? "private" : "shared"}" data-resource-kind="${kind}" data-resource-id="${esc(id)}" data-resource-team="${esc(teamId || (teams.length === 1 ? teams[0].id : ""))}">${sharing === "shared" ? "Make private" : "Publish to team"}</button><span role="status" data-sharing-status></span></span>`;
}
export const resourceSharingStyles = `.resource-sharing{display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:100%}.resource-sharing select,.resource-sharing button{font:inherit;min-height:44px;max-width:100%;border:1px solid #D8D4C8;border-radius:9px;background:white;padding:9px 12px;color:inherit}.resource-sharing select{min-width:0}.resource-sharing button{cursor:pointer}.resource-sharing [role=status]{font-size:13px;overflow-wrap:anywhere}`;
export const resourceSharingScript = `<script>document.addEventListener('click',async function(event){
  var button=event.target.closest('[data-resource-sharing]');if(!button)return;
  var container=button.closest('.resource-sharing'),status=container.querySelector('[data-sharing-status]'),select=container.querySelector('[data-sharing-team]');
  var team=select?select.value:button.dataset.resourceTeam;
  if(!team){status.textContent='Choose a team';return;}
  var sharing=button.dataset.resourceSharing;
  if(!confirm(sharing==='shared'?'Publish this item to all current team members?':'Make this item private to you?'))return;
  button.disabled=true;status.textContent='';
  try{var response=await fetch(APP_BASE+'/api/sharing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resource_type:button.dataset.resourceKind,resource_id:button.dataset.resourceId,sharing:sharing,team_id:team})});var result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Could not change sharing');location.reload();}
  catch(error){status.textContent=error.message;button.disabled=false;}
});</script>`;
