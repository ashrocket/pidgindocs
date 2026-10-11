interface UserRow {
  id: string;
  email: string;
  invited_by: string | null;
  created_at: string;
  status: string;
}

export function adminUsersPage(users: UserRow[], ownerEmail: string, inviteCode?: string): Response {
  const rows = users
    .map(
      (u) => `
    <tr>
      <td>${u.email}${u.email === ownerEmail ? ' <span class="badge">owner</span>' : ""}</td>
      <td>${u.status}</td>
      <td>${u.invited_by ?? "—"}</td>
      <td>${u.created_at.slice(0, 10)}</td>
    </tr>`
    )
    .join("");

  const codeSection = inviteCode
    ? `<div class="code-banner">New invite code: <strong>${inviteCode}</strong> (7 days, 1 use)</div>`
    : "";

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Users — PidginDocs Admin</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f1117;color:#e8edf8;margin:0;padding:32px}
    h1{margin-bottom:24px}
    table{width:100%;border-collapse:collapse;background:#1c2333;border-radius:12px;overflow:hidden}
    th,td{padding:12px 16px;text-align:left;border-bottom:1px solid #2a3550;font-size:14px}
    th{color:#7a8aaa;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
    .badge{background:#f38020;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700}
    form{margin-top:24px;display:flex;gap:12px;align-items:center}
    button{padding:10px 20px;background:#f38020;border:none;border-radius:8px;color:#fff;font-weight:600;cursor:pointer}
    .code-banner{margin-top:16px;padding:16px;background:#1c2333;border:1px solid #f38020;border-radius:10px;font-family:monospace;font-size:16px}
  </style>
</head>
<body>
  <h1>🐦 PidginDocs Users</h1>
  <table>
    <thead><tr><th>Email</th><th>Status</th><th>Invited By</th><th>Joined</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${codeSection}
  <form method="POST" action="/admin/users/invite-code">
    <button type="submit">Generate Invite Code</button>
  </form>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
