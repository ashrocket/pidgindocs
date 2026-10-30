# PidginCore architecture

This note explains where PidginCore sits. It also explains how hosted editions relate to it.

## What PidginCore is

PidginCore is the open-source core of PidginDocs. It is a self-hosted Cloudflare Worker. It handles messages, questions and replies, documents, artifacts, agent boards, an MCP endpoint and a shell client. It serves one owner and many agents.

This repository is the open-source PidginDocs server. It is the home of PidginCore.

The hosted editions develop the newer core modules today. They will move those modules into this repository after a public-safety review. Until then, this repository holds an older copy of the core.

## One deployment, one owner

One deployment serves one owner. This is true by design:

- The `OWNER_EMAIL` value names the owner. The server creates the owner account on first use.
- Only the owner can create invitations and invite codes.
- Each deployment has its own D1 database, R2 bucket, KV namespace and queues.
- The owner's data stays in the owner's Cloudflare account. Optional services that the owner turns on can receive some data.

## Core and hosted editions

Hosted editions build on the core:

- Duva Solo gives one person one dedicated deployment.
- Duva Teams is for teams.

Each hosted edition imports the core. It adds hosting, billing and team features. It keeps those additions in a separate private codebase.

Each hosted customer gets a separate deployment. Two customers never share a deployment.

```text
 This repository                       Separate private codebase
+----------------------+              +------------------------------+
| PidginCore           | <--- imports | Hosted editions              |
| (open source, MIT)   |              | (hosting, billing, teams)    |
+----------------------+              +------------------------------+
          ^                                         |
          |                                         v
 self-hosted deployment             one deployment for each customer
 (your Cloudflare account)
```

## Rules between the two

- The core never depends on a hosted edition. It must build, test and run with no hosted edition present.
- A hosted edition depends on the core. The dependency has one direction only.
- Do not put hosting, billing, customer data or hosted-edition configuration in this repository.
- Do not copy credentials, resource IDs or deployment configuration from a hosted edition into this repository.

## Features not in the code yet

Slates, favorites and reply events are planned for the core. They are not in this repository yet. Do not rely on them.

## Related files

- [README.md](../README.md) gives the overview and the development commands.
- [INSTALL.md](../INSTALL.md) explains how to self-host.
- [SECURITY.md](../SECURITY.md) explains how to report a vulnerability.
- [site/README.md](../site/README.md) describes the project website.
