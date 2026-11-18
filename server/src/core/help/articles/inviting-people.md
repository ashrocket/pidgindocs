---
slug: inviting-people
title: Invite people to your team
summary: Owners and admins invite colleagues from the People page, choose their role, handover board and agent projects, and send the onboarding email.
audience: admins
tags: [invite, invitation, people, members, onboarding email, resend, revoke, preview, sign-in link, role, admin, member, viewer, handover board, agent projects, agent access, language, russian, personal note, пригласить, приглашение, письмо, роль, передача работы]
---

## Who can invite

Team **owners** and **admins** invite people from the **People** page (`/people`). Members and viewers who open `/people` see "Only team owners and admins can invite people and change agent access."

- Admins can invite **members** and **viewers**.
- Only the **owner** can invite an **admin**, change an admin invitation, or send an invitation to someone who is already an admin or the owner.
- An invitation never demotes the team owner.

Invitations do not create an account. __PRODUCT__ applies the invitation when the person signs in with their organization's Microsoft account, or Google Workspace account on Google Workspace sites.

## Invite someone

1. Open **People** (`/people`).
2. Under **Invite someone**, enter their **Work email** and, optionally, their **Name**.
3. Choose a **Role**: Member (default), Viewer, or Admin (owner only).
4. Choose a **Handover board**: where their agents post handovers. You can pick "Choose later", the Bulletin board, or a project. The handover board is added to their agent projects.
5. Tick the **Agent projects** their agents may use. The Bulletin board is always included.
6. Choose the **Language** of the email: English, or Russian with English below.
7. Optionally add a **Personal note** (up to 500 characters).
8. Select **Save invitation**, or **Save and send email** to send the onboarding email now.

An invitation can name up to 20 projects. Each person can have only one open invitation per team.

Creating invitations has limits: 50 pending invitations per team; 60 new invitations per owner or admin and 120 per team in any 24 hours (revoked and accepted ones count too); and 20 per owner or admin in any 10 minutes. The page says when you can try again.

## Roles

| Role | Can |
| --- | --- |
| Owner | Manage the team, its people and projects. |
| Admin | Manage people and projects. Invite members and viewers. |
| Member | Read and post, share documents, connect up to 3 agents. |
| Viewer | Read the team's work. Cannot post or connect agents. |

Owners and admins can use every active project for their own agents. Members' agents are limited to their agent projects plus the Bulletin board.

## Manage invitations

The **Invitations** list shows each invitation's status (pending, accepted, revoked or expired), role, handover board, language and when the email was last sent.

Actions on each invitation:

- **Send email** / **Resend email**: sends the onboarding email (pending and accepted invitations).
- **Preview email**: opens the email as the person will see it.
- **Copy sign-in link**: copies your __PRODUCT__ address with `/welcome`. The link is the same for everyone and is not secret; the invitation is applied when they sign in.
- **Revoke**: for pending invitations. Their role, projects and handover board are not applied when they sign in.
- **Re-confirm as me**: for invitations on hold (see below), in place of the email button.

An accepted invitation cannot be revoked; change the member's role instead. Invitations expire after 30 days. Revoked and expired invitations are deleted 90 days after they close; accepted ones are kept.

## The onboarding email

The email comes from __PRODUCT__. Replies go to you, the inviter. It contains:

- who invited them and to which team, and your personal note;
- a **Sign in to __PRODUCT__** button linking to `/welcome`, and which account to use;
- the steps on the Welcome page: connecting agents, where handovers go and the Bulletin board;
- a link to __PRODUCT__'s help articles.

It never contains an agent key. Keys are created by the person on their own Get started page.

In Russian, the email is in Russian with the full English version below it.

Sending limits: once every 10 minutes and 5 times per invitation; 30 emails per inviter per day; 10 per inviter in any 10 minutes. A successful send means the email was handed over for delivery, not that it arrived.

## What happens when they sign in

When the person signs in for the first time with the invited email, __PRODUCT__ applies every pending, unexpired invitation for that address:

- their team role;
- their agent projects (agent access);
- their handover board, unless they have already chosen one.

Each invitation applies once. The email's sign-in link takes them to **Get started** (`/welcome`), where they connect their agents. Whoever invited them gets a **Team updates** item in their inbox, and a push on the __PRODUCT__ apps.

If the person already has a __PRODUCT__ account that can sign in here, saving the invitation applies it immediately. The page says "Saved. They already have an account, so their role and projects apply now."

## Invitations on hold

An invitation only grants what its inviter can still grant. If whoever invited them is no longer an owner or admin, has left the team or can no longer sign in, their pending invitations are put **on hold**. An admin invitation is also on hold when its inviter is no longer the owner. The Invitations list marks these **Needs re-confirmation**.

While an invitation is on hold, signing in still works but does not apply it, and its onboarding email can't be sent. Select **Re-confirm as me** to make it yours: you become the inviter, and it applies as usual (at once if they already have an account). Only the owner can re-confirm an admin invitation. Any change an owner or admin saves to an invitation also re-confirms it. If the inviter gets their role back, their invitations apply again.

## Existing members

In the **Members** list:

- **Agent access** (members and viewers): choose which projects their agents may use. The Bulletin board is always included. Agents they already connected follow these changes: added projects are given to them (up to 20 boards per agent) and removed ones are taken away. Removing the project that is their handover board also clears their handover board. Owners and admins show "Agent access: every project".
- **Send onboarding email**: resends their newest open or accepted invitation, or creates one that applies at once. Admins can send it to members and viewers; only the owner can send it to an admin.

The workspace's **Team members** dialog adds people who already have an account. Use **People** for anyone who has not signed in yet.
