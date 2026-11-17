// PidginCore's default sign-in page: an email link form that posts to
// /auth/login-form. An edition can replace it through the loginPage hook
// (for example with its own Microsoft, Google Workspace and managed-tenant page).
import type { Env } from "../types";
import { appPath, routePath } from "../base-path";
import { theme } from "./theme";
import { esc } from "./index";

export async function coreLoginPage(env: Env, error?: string, next?: string): Promise<Response> {
  const target = next || routePath("/workspace");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:${theme.sand};color:${theme.ink};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:420px;background:white;border:1px solid ${theme.line};border-radius:20px;padding:32px}label{display:block;font-weight:600;margin:16px 0 6px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid ${theme.line};border-radius:10px;font:inherit}button{margin-top:16px;width:100%;padding:13px;border:0;border-radius:10px;background:${theme.primary};color:white;font:inherit;font-weight:650}.error{padding:10px;border-radius:8px;background:${theme.errorBg};color:${theme.error}}</style></head>
<body><main><h1>Sign in</h1><p>We send a sign-in link to your email address.</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="${esc(appPath(env, "/auth/login-form"))}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required><input type="hidden" name="next" value="${esc(target)}"><button type="submit">Send sign-in link</button></form></main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
