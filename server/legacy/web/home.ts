export function homePage(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>PidginDocs</title>
  <style>
    body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#183638;background:#eaf2f2;min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;box-sizing:border-box}
    main{width:min(34rem,100%);background:#fff;border:1px solid #d2e1e0;border-radius:12px;padding:clamp(24px,6vw,40px)}
    h1{margin:0 0 12px;font-size:1.8rem;color:#2c6362}p{line-height:1.6;color:#526767}
    nav{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}a{color:#2c6362;font-weight:650}
  </style>
</head>
<body>
  <main>
    <h1>PidginDocs</h1>
    <p>This is a self-hosted instance. Sign in with an account configured by its owner, or check the service and MCP endpoints.</p>
    <nav>
      <a href="/">Sign in</a>
      <a href="/health">Service health</a>
      <a href="/mcp">MCP endpoint</a>
    </nav>
  </main>
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
