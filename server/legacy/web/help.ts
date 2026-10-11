import { theme } from "./theme";

export function replyHelpPage(): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs · Reply help</title>
<style>
  :root{
    --sand:${theme.sand};
    --paper:${theme.paper};
    --ink:${theme.ink};
    --muted:${theme.muted};
    --dim:${theme.dim};
    --forest:${theme.primary};
    --deep:${theme.ink};
    --line:${theme.line};
    --green:${theme.badgeAnsweredText};
    --green-bg:${theme.badgeAnsweredBg};
    --amber:${theme.idle};
    --amber-bg:${theme.badgeQuestionBg};
    --slate:#476780;
    --slate-bg:${theme.badgeStatusBg};
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    font-family:Inter,-apple-system,sans-serif;
    color:var(--ink);
    background:
      radial-gradient(circle at top right, rgba(90,107,58,.15), transparent 22%),
      linear-gradient(180deg, #EFE4CC 0%, ${theme.sand} 52%, #E0D4BC 100%);
    min-height:100vh;
    line-height:1.7;
  }
  main{max-width:760px;margin:0 auto;padding:48px 24px 80px}
  .shell{
    background:rgba(250,244,232,.92);
    border:1px solid var(--line);
    border-radius:24px;
    box-shadow:0 16px 40px rgba(43,31,24,.08);
    overflow:hidden;
  }
  .hero{
    padding:34px 34px 28px;
    background:
      radial-gradient(circle at top left, rgba(90,107,58,.18), transparent 28%),
      linear-gradient(180deg, rgba(250,244,232,.95), rgba(232,220,200,.96));
    border-bottom:1px solid var(--line);
  }
  .eyebrow{
    display:inline-block;
    font-size:.74rem;
    text-transform:uppercase;
    letter-spacing:.16em;
    color:var(--forest);
    font-weight:800;
    margin-bottom:14px;
  }
  h1{
    margin:0 0 14px;
    font-family:Georgia,serif;
    font-size:2.1rem;
    line-height:1.05;
    color:var(--deep);
  }
  .lede{
    font-size:1.03rem;
    line-height:1.7;
    color:var(--muted);
    max-width:56ch;
    margin:0;
  }
  .body{padding:30px 34px 36px}
  section{margin:0 0 30px}
  section:last-child{margin-bottom:0}
  h2{
    font-family:Georgia,serif;
    font-size:1.25rem;
    color:var(--deep);
    margin:0 0 14px;
  }
  h3{
    font-size:.95rem;
    color:var(--deep);
    margin:20px 0 8px;
  }
  p{margin:0 0 14px;font-size:.97rem;line-height:1.72;color:var(--ink)}
  p.note{color:var(--muted);font-size:.92rem}
  strong{font-weight:700;color:var(--deep)}
  code{
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    background:rgba(43,31,24,.06);
    color:var(--deep);
    border-radius:6px;
    padding:2px 6px;
    font-size:.88em;
  }
  .legend{display:flex;flex-direction:column;gap:12px;margin:0 0 4px}
  .legend-row{
    display:flex;
    align-items:flex-start;
    gap:14px;
    padding:14px 16px;
    border-radius:14px;
    background:var(--paper);
    border:1px solid var(--line);
  }
  .status{
    flex-shrink:0;
    display:inline-flex;
    align-items:center;
    gap:7px;
    padding:.3rem .7rem;
    border-radius:999px;
    font-size:.74rem;
    font-weight:700;
    text-transform:uppercase;
    letter-spacing:.04em;
    white-space:nowrap;
  }
  .status::before{content:"";width:9px;height:9px;border-radius:50%}
  .status.green{background:var(--green-bg);color:var(--green)}
  .status.green::before{background:var(--green)}
  .status.amber{background:var(--amber-bg);color:var(--amber)}
  .status.amber::before{background:var(--amber)}
  .status.slate{background:var(--slate-bg);color:var(--slate)}
  .status.slate::before{background:var(--slate)}
  .legend-text{font-size:.92rem;line-height:1.6;color:var(--ink)}
  .legend-text strong{display:inline}
  .card{
    background:var(--paper);
    border:1px solid var(--line);
    border-radius:16px;
    padding:18px 20px;
    margin:0 0 14px;
  }
  .card h3{margin-top:0}
  ol{margin:0 0 6px 1.1em;padding:0}
  ol li{margin:0 0 10px;line-height:1.7;color:var(--ink)}
  .callout{
    display:flex;
    gap:12px;
    padding:14px 16px;
    border-radius:14px;
    background:var(--amber-bg);
    border:1px solid #E8D49A;
    margin:14px 0 0;
  }
  .callout .icon{flex-shrink:0;font-size:1rem;line-height:1.6}
  .callout .text{font-size:.9rem;line-height:1.62;color:#7a5d16}
  .callout .text strong{color:#5f470f}
  .footer{
    margin-top:28px;
    padding-top:18px;
    border-top:1px solid var(--line);
    font-size:.85rem;
    color:var(--dim);
  }
  .footer a{color:var(--forest);text-decoration:none;font-weight:600}
  .footer a:hover{text-decoration:underline}
  @media (max-width:640px){
    .hero,.body{padding:24px}
    h1{font-size:1.7rem}
    .legend-row{flex-direction:column;gap:8px}
  }
</style></head><body>
<main>
  <section class="shell">
    <div class="hero">
      <div class="eyebrow">PidginDocs · Reply help</div>
      <h1>Can I still reply?</h1>
      <p class="lede">Here's what the status colors mean and how an agent can retrieve your reply after its session has moved on.</p>
    </div>
    <div class="body">

      <section>
        <h2>What the colors mean</h2>
        <div class="legend">
          <div class="legend-row">
            <span class="status green">Waiting</span>
            <div class="legend-text">An agent polled in the last few seconds and is online right now. Your reply is <strong>delivered instantly</strong>.</div>
          </div>
          <div class="legend-row">
            <span class="status amber">Session ended</span>
            <div class="legend-text">No agent has polled recently — that session has moved on. Your reply is still <strong>saved on the server</strong>; resume on your desktop to deliver it.</div>
          </div>
          <div class="legend-row">
            <span class="status slate">Not yet seen</span>
            <div class="legend-text">The question was posted, but no agent has polled for it yet. Your reply is <strong>saved</strong> and waits for the first agent that reads it.</div>
          </div>
        </div>
        <p class="note">Either way, your reply always saves. The reply endpoint is idempotent — it's delivered whenever an agent session reads the message: instantly if one is live, or later when a new session picks it up.</p>
      </section>

      <section>
        <h2>If the session ended — how to deliver your reply</h2>

        <div class="card">
          <h3>In your project</h3>
          <p>Your reply is already saved on this instance. Reopen the project in an agent connected to PidginDocs and ask it to check for the reply.</p>
          <ol>
            <li>Open the <strong>same project</strong> where the question came from.</li>
            <li>Start a connected agent session. It can read the saved reply from the message history and continue from there.</li>
            <li>For the shell client, run <code>scripts/pidgindocs.sh poll &lt;message-id&gt;</code> with your instance URL and API key configured.</li>
          </ol>
        </div>

        <div class="callout">
          <span class="icon">⚠️</span>
          <span class="text"><strong>No remote dispatch.</strong> Replying from your phone does not start an agent session. It saves your answer for a connected session to read.</span>
        </div>
      </section>

      <section>
        <h2>Why does this happen?</h2>
        <p>Agent sessions are <strong>ephemeral</strong>. An agent polls for a reply for a limited time, then stops. After that, a <strong>fresh session</strong> can read your saved reply and continue. "Session ended" means the original session moved on; your reply is still stored.</p>
      </section>

      <div class="footer">
        PidginDocs · <a href="/onboarding">Instance information</a>
      </div>

    </div>
  </section>
</main>
</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
