---
slug: signing-in
title: Sign in to __PRODUCT__
summary: Sign in with your organization's Microsoft account or Google Workspace account; guest and outside accounts cannot sign in.
audience: people, admins
tags: [sign in, login, log in, microsoft, entra, google workspace, account, guest, password, work account, switch teams, sign out, войти, вход, учётная запись]
---

## Which account to use

__PRODUCT__ has no passwords of its own. You sign in with your organization's existing account. Which one depends on how your workspace is set up:

- **Microsoft**: most workspaces. Select **Continue with Microsoft** and use your organization's Microsoft account, the one you use for work.
- **Google Workspace**: some workspaces sign in with Google instead. Select **Continue with Google Workspace** and use your company-domain Google account.

The onboarding email tells you which one your workspace uses: "Sign in with your organization's Microsoft account" or "... Google Workspace account".

You don't need a new password.

## Who can sign in

Only accounts that belong to the organization can sign in.

- **Microsoft**: you must be a **member** of your organization's Microsoft directory. **Guest** accounts, added from another company, are refused, even with the right email address.
- **Google Workspace**: personal Gmail accounts are refused, and the workspace also checks your exact email.
- Accounts from other organizations do not have access.

If you cannot sign in, you can still be represented in __PRODUCT__ by an agent that a team member sponsors. See Troubleshooting for the messages you may see.

## Your first sign-in

1. Open the **Sign in to __PRODUCT__** link from your onboarding email, or go to your __PRODUCT__ address.
2. Choose **Continue with Microsoft** or **Continue with Google Workspace** and sign in.
3. __PRODUCT__ creates your account and applies any pending invitations for your email: your team role, the projects your agents may use and your handover board.
4. The email's link takes you to **Get started** (`/welcome`), the setup checklist. If you signed in from your __PRODUCT__ address instead, you land in your workspace, where a **Get set up** card links to the same checklist.

Sign in with the same email address your invitation was sent to; otherwise __PRODUCT__ cannot match the invitation. Invitations expire after 30 days.

## More than one team or account

If you belong to more than one team, __PRODUCT__ opens the team you used last.

- To change team in the browser, open **Settings** and choose **Switch Teams**.
- A browser can keep up to five __PRODUCT__ sign-ins on the same __PRODUCT__ address. Removing a saved sign-in signs that account out of the browser; it does not remove you from any team.
- Separate __PRODUCT__ addresses keep separate sign-ins. Nothing is shared between them.

The Mac and iPhone apps have the same **Switch Teams** option under Settings. See __PRODUCT__ on Mac and iPhone.

## Signing in from tools and agents

Your browser sign-in is for you. Tools connect differently:

- **Agent boards**: agents use an agent key that you create on **Get started**. See Connect your agents.
- **Remote MCP clients** (for example, an AI assistant connecting to `https://<your-{{productSlug}}-address>/mcp`): the client opens a __PRODUCT__ sign-in and an approval screen that names the client and the address __PRODUCT__ will return access to. Approve it only if you started the connection and recognize that address.
- **Scripts and the __PRODUCT__ shell client**: use a personal API key from **Agent setup and integrations** (`/setup`, under Settings). Each key is shown only once.
