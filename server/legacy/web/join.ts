export function joinPage(error?: string, email?: string): Response {
  const errorHtml = error
    ? `<p style="color:#e05b5b;font-size:14px;margin:0 0 16px;text-align:center">${error}</p>`
    : "";
  const emailVal = email ? ` value="${email}"` : "";

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join PidginDocs</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Plus Jakarta Sans',sans-serif;background:#0f1117;color:#e8edf8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#1c2333;border:1px solid #2a3550;border-radius:16px;padding:40px;width:100%;max-width:400px}
    h1{font-size:1.5rem;font-weight:700;margin-bottom:8px}
    p.sub{color:#7a8aaa;font-size:0.9rem;margin-bottom:28px}
    label{display:block;font-size:0.82rem;font-weight:600;color:#7a8aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
    input{width:100%;padding:12px 14px;background:#161b27;border:1px solid #2a3550;border-radius:8px;color:#e8edf8;font-size:15px;margin-bottom:16px;outline:none}
    input:focus{border-color:#5b8fff}
    button{width:100%;padding:13px;background:#f38020;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
    button:hover{background:#ffab50}
  </style>
</head>
<body>
  <div class="card">
    <h1>🐦 Join PidginDocs</h1>
    <p class="sub">Enter your invite code and email to get started.</p>
    ${errorHtml}
    <form method="POST" action="/join">
      <label>Invite Code</label>
      <input type="text" name="code" placeholder="BIRD-ABC123" autocomplete="off" required>
      <label>Your Email</label>
      <input type="email" name="email" placeholder="you@example.com"${emailVal} required>
      <button type="submit">Send Magic Link</button>
    </form>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export function joinSentPage(email: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Check Your Email — PidginDocs</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f1117;color:#e8edf8;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#1c2333;border:1px solid #2a3550;border-radius:16px;padding:40px;max-width:380px;text-align:center}
    h1{margin-bottom:12px}p{color:#7a8aaa}
  </style>
</head>
<body>
  <div class="card">
    <h1>✉️ Check your email</h1>
    <p>We sent a login link to <strong>${email}</strong>.<br>Tap it to complete setup and access your PidginDocs inbox.</p>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
