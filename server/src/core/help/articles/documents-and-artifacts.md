---
slug: documents-and-artifacts
title: Documents, artifacts and audio
summary: How documents and artifacts get into __PRODUCT__, who can see them, how versions and sharing work, and how to turn a document into audio.
audience: people
tags: [documents, docs, artifacts, pages, widgets, versions, share, team, private, public, design system, markdown, decision memo, runbook, audio, listen, narration, документы, артефакты, аудио]
---

## Documents

A __PRODUCT__ document is a longer write-up: release notes, a spec, meeting notes or a decision memo. Agents usually publish them, through the __PRODUCT__ skill and shell client or the MCP tool `{{tool}}publish_document`.

- Markdown is typeset by the server in a document style (a design system). Mermaid diagrams in Markdown are drawn as diagrams.
- Document kinds include doc, decision memo, meeting note, spec and runbook.
- An agent can ask the server to polish or enrich a Markdown document; the enhanced page is published as version 2.

Your personal documents are under **Docs** (`/toc`). Documents shared with a team appear in the project's **Documents** view in the workspace.

## Edit a document: publish a new version

A posted document is never changed in place. To edit it, publish a **new version**: the agent passes the document's id (any version's) and the version it last read, with `{{shellCli}}send --doc-id <id> --base-version <n>` or `doc_id` and `base_version` on `{{tool}}publish_document`.

- The new version gets its own address and becomes the one __PRODUCT__ lists, in your inbox, Docs and the team feed. It arrives as a new, unread item.
- Older versions keep their content and address. Opening one in the web viewer shows a banner, "A newer version (vN) of this document exists — open it", and the latest version shows its version number and links to the earlier ones. Interactive documents, share links and the __PRODUCT__ app open the exact version without a banner.
- A new version stays in the same team and project and keeps the document's visibility and kind. An interactive document's new version must be interactive too.
- The author of the latest version can publish a new version. For a team document, a team owner or admin can as well; other members cannot.
- If someone published a newer version since you last read it, __PRODUCT__ refuses with a version conflict that names the latest version's id. Read that version and publish from it.
- Deleting the latest version makes the previous version the latest again. Dismissing a document (archive or delete) applies to all of its versions.
- A custom slug can be used once per team, or once among your own documents. To change a document that already has the slug, publish a new version of it.
- A new version cannot be enhanced; publish it as you want it to read.

## Artifacts

An artifact is a live, self-contained web page at a stable address, such as a preview, a dashboard or a diagram. Agents publish them with the __PRODUCT__ skill or the MCP tool `{{tool}}publish_artifact`.

- **Versions**: republishing the same artifact updates the same address as a new version. The last 20 versions are kept.
- **Private by default**: a new artifact is private unless it is published as public.
- **Safe to open**: artifact code runs in a sandbox. It cannot read your __PRODUCT__ session, cookies or other pages, or contact other servers.
- **Pages and widgets**: pages appear in the gallery; widgets are small pieces placed inside a message.

Open **Artifacts** (`/artifacts`) for your gallery. Team artifacts appear in the project's **Artifacts** view.

## Who can see documents and artifacts

Content stays private to its author until it is published or shared to a team.

- When something is shared to a team, **every member of that team** can see it, in every project of that team.
- Only the author, while they still have write access to the team, can republish, edit or delete it. A team owner or admin can also publish a new version of a team document.
- Every view checks your current team membership. If you leave a team, you lose access to its content immediately.
- Team links are ordinary __PRODUCT__ addresses that require sign-in; they are not public links.

To share something to a team, publish it with a team and project (agents pass `team_id` and `project_id`).

## Comments and decision memos

Every document, artifact, post and decision memo shared with a team has a discussion thread. Team members can comment and reply; viewers can read. See Team feed, posts and comments.

**Decision memos** record a decision with its context, options, consequences and owners. They appear in the workspace under **Decision memos**.

## Audio

**Audio** (`/audio`) is your personal listening library. Audio belongs to you, not to a team.

- **Upload audio**: an MP3, M4A or WAV file, up to 100 MB. Safari and iPhone can't play OGG, Opus or WebM.
- **From a document**: paste Markdown, HTML or plain text. If it reads in 3 minutes or less, __PRODUCT__ reads it as written. If longer, __PRODUCT__ writes a short audio summary and reads that.
- Your commute briefings appear here too.

Agents can publish audio with the MCP tool `{{tool}}publish_audio`. A document turns into audio in the background; check that its status is ready before you play it.
