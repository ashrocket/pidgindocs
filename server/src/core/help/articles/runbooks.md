---
slug: runbooks
title: Runbooks
summary: Guided step-by-step procedures with approvals, evidence and history, on the web, Mac and iPhone.
audience: people, admins
tags: [runbooks, ops, procedure, guide, steps, approval, evidence, run, incident, checklist, versions, регламент, инструкция, процедура]
---

## What a runbook is

**Runbooks** (`/runbooks`) are guided procedures for your team, for example how to respond to an incident or ship a release. A runbook guides people and agents through the response; it does not run commands itself.

Each runbook has:

- a trigger (when to use it), prerequisites, a rollback plan, verification and an escalation contact;
- an owner;
- 1 to 30 steps. A step is an **action**, a **check**, or a required **human approval**.

## Write and publish a runbook

1. Open **Runbooks** and create a draft.
2. Fill in the trigger, prerequisites, rollback plan, verification, escalation contact, owner and steps.
3. A team **owner or admin** publishes it. Owners and admins can also archive it.

Each edit creates a new, unchangeable version, and __PRODUCT__ asks what changed. Runs already in progress keep the version they started with.

## Run a runbook

Any team member can start a published runbook.

- Each step has a state. You can add notes and evidence references.
- A step that requires evidence cannot be finished without a reference.
- An optional step can be skipped only with a reason.
- An **approval** step can be approved only by a signed-in team owner or admin. An API key can record ordinary step work but cannot approve.

Every run keeps a chronological audit trail of who did what.

## Finish a run

A run closes as **completed** only when every step is resolved. You can also **abort** a run, with a reason.

Past runs stay in the run history.

## Runbooks on Mac and iPhone

Runbooks is a main section in the __PRODUCT__ apps too. You can search, filter by status, draft and revise runbooks, publish and archive them, run them with evidence and approvals, and see run history.

- On iPhone, Runbooks is one of the five tabs.
- On Mac, Runbooks is in the sidebar; Command-2 opens it.

The apps use the same team and the same permissions as the web.
