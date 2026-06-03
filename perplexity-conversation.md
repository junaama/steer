<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# Summarize the current webpage

The page is a **HumanLayer Take-Home Assessment** describing a technical interview assignment for a software engineering role.[^1_1]

## Task Overview

You must build a **sync-based headless coding agent** with a reactive user interface. The system has four core components:[^1_1]

- **Server Process**: A web server providing APIs and sync-driven UI functionality.
- **Postgres Database \& Electric SQL**: Postgres for persistence, with Electric SQL as the sync engine.
- **Headless Coding Agent / Daemon**: A CLI-runnable agent loop that receives tasks via sync, runs them on its host, and streams events back to the server.
- **User Interface**: A reactive UI synced via Electric SQL and TanStack DB, supporting login, session creation/deletion/interruption/continuation, and live viewing of agent activity.


## Key Constraints

- Entirely **TypeScript** for frontend and backend/agent.[^1_1]
- **No existing coding agent SDKs** (e.g., Claude Code, Cursor) and **no Next.js** .
- Must implement **authentication \& authorization**.[^1_1]
- Sync system **must use Electric SQL, TanStack DB, and Postgres** .
- Deliverable must include a **docker-compose** setup that builds and runs with only `docker compose up` after configuring a `.env` file .


## Deliverables

A GitHub repository (public or shared with `K-Mistele`) containing the full source code with git history, a `README.md` with setup instructions, and a link to a Loom video demonstrating the project and discussing architecture, design decisions, data model, and security model .

<div align="center">⁂</div>

[^1_1]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c


---

# what does sync based mean? what is electric sql? what is tanstack db?

**Sync-based** means the architecture uses a **sync engine** to automatically propagate data changes between a central database and connected clients in real time, rather than having clients manually fetch data on demand. When something changes in the database, every authorized client sees the update almost instantly, creating a reactive system where the UI stays synchronized without refresh or polling.[^2_1][^2_2]

## Electric SQL

Electric SQL is an **open-source Postgres sync engine** that streams data out of Postgres to clients using an HTTP-based sync protocol. It handles hard problems like partial replication, fan-out, and data delivery, often leveraging CDNs for scalable distribution. In this assessment, Electric SQL acts as the real-time bridge: when the coding agent writes events to Postgres, Electric SQL pushes those changes to the UI, and vice versa.[^2_3][^2_4][^2_5]

## TanStack DB

TanStack DB is a **reactive client-side store** built on top of TanStack Query. It provides typed collections, live queries, and optimistic mutations with differential dataflow for sub-millisecond UI updates. It is backend-agnostic but includes a dedicated Electric SQL collection (`@tanstack/electric-db-collection`) that consumes Postgres sync streams, allowing the frontend to react instantly to database changes without custom WebSocket plumbing.[^2_6][^2_7][^2_8]
<span style="display:none">[^2_10][^2_11][^2_12][^2_13][^2_14][^2_15][^2_16][^2_9]</span>

<div align="center">⁂</div>

[^2_1]: https://news.ycombinator.com/item?id=43397640

[^2_2]: https://streamkap.com/resources-and-guides/real-time-database-synchronization

[^2_3]: https://electric.ax

[^2_4]: https://github.com/electric-sql/electric

[^2_5]: https://www.youtube.com/watch?v=EY9zs3z6jCE

[^2_6]: https://www.infoq.com/news/2025/08/tanstack-db-beta/

[^2_7]: https://github.com/tanstack/db

[^2_8]: https://blog.openreplay.com/tanstack-db-reactive-uis/

[^2_9]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c

[^2_10]: https://johnny.sh/blog/choosing-a-sync-engine-in-2026/

[^2_11]: https://www.reddit.com/r/FlutterDev/comments/1dnxt3j/any_good_offline_database_sync_packages_like/

[^2_12]: https://signaldb.js.org/real-time/

[^2_13]: https://merginit.com/blog/24082025-sync-engines-guide-electricsql-convex-zero

[^2_14]: https://www.essentialdesigns.net/news/real-time-data-sync-best-practices-for-cloud-apps

[^2_15]: https://thinkthroo.com/blog/tanstack-db-the-reactive-client-first-store-for-your-api

[^2_16]: https://www.resilio.com/blog/real-time-sync-software


---

# for a coding agent what write events are required for this to require a sync engine?

The assessment requires the agent to write several high-frequency, granular event types that must appear in the UI in **live time**. These write events are what make a sync engine architecturally appropriate rather than polling:[^3_1]

- **Agent execution events**: tool calls, thinking tokens/reasoning steps, and assistant messages streamed during a session.[^3_1]
- **Tool results / output**: the outcomes of executed tool calls (file writes, shell output, errors) that the agent sends back to the server.
- **Session state mutations**: status changes when a session starts, is interrupted, continues, completes, or errors out.[^3_1]
- **Session metadata edits**: renames and deletes initiated by the user that must immediately reflect across all connected clients.[^3_1]


## Why these events justify sync

**Volume and frequency** — A coding agent can emit dozens of thinking tokens and tool calls per minute. Polling would either lag or hammer the server.[^3_1]

**Live-time viewing requirement** — The spec explicitly states the user must see the agent's work **as it is working**, which demands sub-second propagation from the agent's host to the browser.[^3_1]

**Bidirectional control** — The UI must interrupt a running session and have that signal reach the headless agent immediately. Sync provides the reactive channel for this control plane, not just the data plane.[^3_1]

**Multi-client consistency** — Because sessions and their event collections are synced to the UI through Electric SQL and TanStack DB, any state change written by the agent or user must be reflected across all active views without manual refresh.[^3_1]

<div align="center">⁂</div>

[^3_1]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c


---

# whats a headless coding agent? is that also how codex/claude code works?

A **headless coding agent** is an AI agent that operates entirely in the background without a built-in graphical or terminal interface. It receives tasks via APIs, programmatic commands, or sync events; executes them autonomously by reading files, running shell commands, and writing code; and returns artifacts or event streams to a separate system that handles display.[^4_1][^4_2][^4_3][^4_4]

## How Claude Code and Codex relate

By default, **Claude Code** and the **OpenAI Codex CLI** are **supervised interactive agents**—they launch a full-screen terminal UI where a human chats, steers, and watches the agent work in real time. Their architecture is a simple "master loop" of tool calls, but the interface is coupled to the agent process.[^4_5][^4_6][^4_7][^4_8]

However, both can run **headless** when needed:

- **Codex CLI** provides `codex exec`, a non-interactive mode designed for CI/CD pipelines and scripted automation.[^4_6][^4_9]
- **Claude Code** can be orchestrated headlessly (e.g., via GitHub Actions or tools like `ccswarm`) to read issues, implement features, and open PRs without a human in the loop.[^4_9][^4_10]


## The HumanLayer assessment difference

This assignment asks you to build **headless-first** from the ground up: the agent daemon has **zero UI** and communicates purely through the sync engine (Electric SQL + Postgres). The reactive web UI is a completely separate client that consumes the agent's event stream in live time. That decoupling—where rendering and generation are independent—is the defining headless architecture.[^4_11][^4_4]
<span style="display:none">[^4_12][^4_13][^4_14][^4_15][^4_16]</span>

<div align="center">⁂</div>

[^4_1]: https://www.lyzr.ai/glossaries/what-is-headless-ai-agent/

[^4_2]: https://www.reddit.com/r/LocalLLaMA/comments/1extoy6/headless_ide_for_coding_agents/

[^4_3]: https://www.linkedin.com/posts/kamaalahmadusmani_what-is-a-headless-ai-agent-a-headless-activity-7298952155003072513-BMGq

[^4_4]: https://discuss.google.dev/t/headless-agents-architecting-decoupled-ai-systems/323144

[^4_5]: https://martinfowler.com/articles/exploring-gen-ai/autonomous-agents-codex-example.html

[^4_6]: https://www.deployhq.com/blog/getting-started-with-openai-codex-cli-ai-powered-code-generation-from-your-terminal

[^4_7]: https://www.youtube.com/watch?v=RFKCzGlAU6Q

[^4_8]: https://code.claude.com/docs/en/best-practices

[^4_9]: https://github.com/openai/codex/issues/4219

[^4_10]: https://www.linkedin.com/posts/ctmarcus_claudecode-aiengineering-agenticai-activity-7433281563376754688-CBwu

[^4_11]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c

[^4_12]: https://www.reddit.com/r/vibecoding/comments/1rgj52j/architect_an_opensource_cli_to_orchestrate/

[^4_13]: https://toloka.ai/blog/ai-coding-agents-what-they-are-how-they-work-and-how-to-build-one/

[^4_14]: https://www.youtube.com/watch?v=OefEyzkW6dM

[^4_15]: https://www.philschmid.de/openai-codex-cli

[^4_16]: https://c3.ai/blog/autonomous-coding-agents-beyond-developer-productivity/


---

# how are headless ai agents servers modeled?

Headless AI agents are typically modeled as **background server processes**—daemons or services that wait for external triggers, run autonomous reasoning loops, and emit results through APIs or event streams.[^5_1][^5_2]

## Core Server Architecture

The canonical pattern is an **agent execution loop** wrapped in a long-running or on-demand server process:[^5_3][^5_1]

1. **Event trigger** — The server receives a task via API call, webhook, database change, or message queue.[^5_4][^5_2]
2. **Context preparation** — Combines the task with system instructions, conversation history, and tool definitions.[^5_1]
3. **Model inference loop** — Repeatedly calls the LLM; if it returns tool calls, the server executes them and feeds results back into context until the model returns a final text response.[^5_3][^5_1]
4. **Result emission** — Streams events (tool calls, outputs, reasoning steps) to the caller via SSE, NDJSON, webhooks, or writes to a sync database.[^5_5]

## Deployment Patterns

Headless agents are deployed in several server configurations depending on autonomy requirements:[^5_6][^5_2]


| Pattern | Model | Use Case |
| :-- | :-- | :-- |
| **On-demand CLI/server** | Single invocation with `--prompt` or HTTP request; exits when done | CI/CD, one-off tasks [^5_7][^5_5] |
| **Daemon/heartbeat loop** | Persistent process with a timed event loop, waiting for work | Background worker that polls or listens [^5_8] |
| **Serverless function** | Triggered by events (file upload, DB change); scales to zero | Cost-efficient, sporadic workloads [^5_2] |
| **Persistent API service** | Always-on HTTP server accepting tasks and streaming responses | Real-time collaborative systems [^5_5] |

## The HumanLayer Assessment Model

This assignment specifically requires a **daemon/background worker** pattern:[^5_9]

- The agent is a **CLI-runnable process** that runs on its own host.
- It receives tasks by **syncing from Postgres** (not a direct HTTP API).
- It streams events back to the server by **writing to the synced database**.
- The UI is a separate client that sees those writes in real time through Electric SQL.[^5_9]

This is a **decoupled event-driven architecture**: the agent server has no direct network connection to the UI; both communicate through the shared sync layer, making the system resilient and allowing the agent to run anywhere with database access.[^5_10][^5_4]
<span style="display:none">[^5_11][^5_12][^5_13][^5_14][^5_15][^5_16][^5_17][^5_18]</span>

<div align="center">⁂</div>

[^5_1]: https://newsletter.victordibia.com/p/the-agent-execution-loop-how-to-build

[^5_2]: https://www.lyzr.ai/glossaries/what-is-headless-ai-agent/

[^5_3]: https://www.braintrust.dev/blog/agent-while-loop

[^5_4]: https://www.sysdig.com/learn-cloud-native/what-is-headless-cloud-security

[^5_5]: https://openrouter.ai/docs/cookbook/building-agents/create-headless-agent

[^5_6]: https://james-carr.org/posts/2026-03-01-agent-hosting-patterns/

[^5_7]: https://www.deployhq.com/blog/getting-started-with-openai-codex-cli-ai-powered-code-generation-from-your-terminal

[^5_8]: https://github.com/different-ai/openwork/issues/508

[^5_9]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c

[^5_10]: https://discuss.google.dev/t/headless-agents-architecting-decoupled-ai-systems/323144

[^5_11]: https://www.linkedin.com/posts/rakeshgohel01_dont-overload-a-single-ai-agent-with-a-bunch-activity-7325137397019484160-qqn4

[^5_12]: https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns

[^5_13]: https://monday.com/blog/ai-agents/ai-agent-architecture/

[^5_14]: https://blog.n8n.io/ai-agent-architecture-patterns/

[^5_15]: https://www.lesswrong.com/posts/6cWgaaxWqGYwJs3vj/a-basic-systems-architecture-for-ai-agents-that-run-code

[^5_16]: https://www.linkedin.com/posts/eoin-mcmillan_short-notes-from-a-week-with-codex-last-activity-7453677781076561920-HhnR

[^5_17]: https://blogs.oracle.com/developers/what-is-the-ai-agent-loop-the-core-architecture-behind-autonomous-ai-systems

[^5_18]: https://www.reddit.com/r/ollama/comments/1smfmjx/built_a_local_3agent_coding_system/


---

# what is a daemon?

A **daemon** is a background process that runs continuously on a computer, typically without any direct user interface or interaction. It waits silently for specific events, triggers, or requests, then performs its designated work autonomously.[^6_1]

## How it works

- **Starts and stays resident**: Unlike a regular program that launches, completes a task, and exits, a daemon initializes once and remains in memory.[^6_2]
- **Event-driven**: It listens for signals—such as a new database row, an API request, a file change, or a timed heartbeat—then wakes up to process the work.[^6_3][^6_2]
- **No foreground UI**: It logs output to files or streams events elsewhere rather than printing to a terminal screen.[^6_1]


## In the context of this assessment

The HumanLayer spec explicitly calls the coding agent a **daemon**. That means your agent process should:[^6_4]

- Start from the CLI and keep running (or run on a schedule/heartbeat).
- Watch the synced Postgres database for new sessions/tasks assigned to it.
- Execute the coding loop in the background, streaming results back through the database.
- Remain fully decoupled from the web UI, which merely observes its activity through the sync layer.

Common examples you have likely encountered include `sshd` (handles SSH connections), `dockerd` (manages containers), or a Celery worker that polls a task queue.

<div align="center">⁂</div>

[^6_1]: https://www.lyzr.ai/glossaries/what-is-headless-ai-agent/

[^6_2]: https://github.com/different-ai/openwork/issues/508

[^6_3]: https://newsletter.victordibia.com/p/the-agent-execution-loop-how-to-build

[^6_4]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c


---

# what is the UI requirement type? is it a web ui? a tui? a mobile app? cloud based? why is UI required as well as headless

The UI requirement is a **web UI** running in a browser, not a TUI, mobile app, or desktop application.[^7_1][^7_2]

## Evidence from the spec

- The server process **"runs on a web server"** and exposes ports so **"a user can interact with"** the UI container.[^7_2][^7_1]
- The UI must be **reactive** and receive all data through **Electric SQL and TanStack DB** sync, which are web-native technologies (HTTP-based sync, browser client store).[^7_1]
- It requires standard web app features: login/logout, session list navigation, and live viewing of agent activity.[^7_1]


## Why both headless agent and UI?

The architecture intentionally **decouples the worker from the interface**:[^7_2][^7_1]


| Component | Role | Exposes ports? |
| :-- | :-- | :-- |
| **Headless agent** | Runs the coding loop, executes shell commands, calls LLMs | No [^7_2] |
| **Web UI** | Creates tasks, watches live progress, interrupts/renames sessions | Yes [^7_2] |

The agent is **headless** so it can run in an isolated container or sandbox without a user interface. The web UI exists because humans still need to **create sessions, monitor progress in real time, and intervene** (e.g., interrupt a runaway agent). The sync engine bridges them: the agent writes events to Postgres, and the UI sees those changes instantly without direct network coupling to the agent.[^7_1]

<div align="center">⁂</div>

[^7_1]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c

[^7_2]: https://electric.ax


---

# so i can run this agent anywhere ? do i need to login through the daemon? do i start the web ui first to access the agent?

Yes, the agent is designed to run **anywhere** that can connect outbound to the server—on a workstation, sandbox, or container. The docker-compose spec even places it in **its own isolated container** that does not expose any ports; it connects outward to the server/Postgres rather than receiving inbound connections.[^8_1][^8_2]

## Authentication flow

You do **not** log in through the daemon. The daemon is headless and has no login interface. Authentication and authorization happen in the **server process** and **web UI**. The daemon simply connects to the shared Postgres/Electric SQL sync layer (and presumably the server API) to receive tasks and emit events.[^8_1]

## Startup order

You do not start the UI first to "access" the agent. The intended workflow is:

1. Run `docker compose up` to start all containers (server, UI, Postgres, Electric SQL, and agent container) simultaneously.[^8_2]
2. Log in through the **web UI** in your browser.[^8_1]
3. Create a session via the UI, which writes to the server-managed database.[^8_1]
4. The agent daemon sees the new session through Electric SQL sync and begins working autonomously.[^8_2][^8_1]

The agent and UI are **parallel, decoupled clients** of the same sync layer—not a gateway hierarchy.

<div align="center">⁂</div>

[^8_1]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c

[^8_2]: https://electric.ax


---

# so even though the agent is headless, i still require the web ui to access the agent server? so if i run the docker container in a hetzner server and on another server can i access the web ui to manage auth and sessions for that server? or is it only running on the same system?

Yes, the architecture supports exactly that deployment model.[^9_1][^9_2]

## How the networking works

| Component | Direction | Ports |
| :-- | :-- | :-- |
| **Web UI + Server** | Accepts inbound connections from browsers | Exposes ports for HTTP/web access [^9_2] |
| **Agent daemon** | Connects **outbound only** to server/Postgres | **No exposed ports** [^9_2] |
| **Your laptop** | Connects to the server/UI over the network | Browser → Hetzner IP |

## The flow on a remote server

If you run `docker compose up` on a Hetzner box:

1. The **server and UI containers** expose ports (e.g., `3000`, `8080`) that you can hit from your laptop browser via the Hetzner IP.[^9_2]
2. You log in through the web UI, create a session, and watch live progress—all remotely.[^9_1]
3. The **agent container** on that same Hetzner host connects **outbound** to the server process and Postgres to receive the session via Electric SQL sync, then streams events back.[^9_2][^9_1]

## Could the agent run on a different machine?

The spec says the agent **"should be able to run anywhere that can connect out to the server"**. In theory, yes—you could run the agent daemon on your local workstation while the server and UI live on Hetzner, as long as your local machine can reach the server's Postgres and Electric SQL endpoints. The docker-compose setup bundles them on one host for convenience, but the design intentionally decouples them.[^9_1]

<div align="center">⁂</div>

[^9_1]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c

[^9_2]: https://electric.ax


---

# if i use this skill [https://github.com/OpenRouterTeam/skills/tree/main/skills/create-headless-agent](https://github.com/OpenRouterTeam/skills/tree/main/skills/create-headless-agent) is that considered using the coding agent sdk which is considered a constraint from the prd?

It depends on whether the OpenRouter skill acts as a **one-time scaffold** or introduces a **runtime dependency** on a pre-built agent framework.[^10_1]

## The constraint is about dependencies

The spec says you **must not** use the SDK, binaries, or source code of an existing coding agent as **direct or indirect dependencies**. It explicitly names Claude Code SDK, OpenCode SDK, Amp, and Cursor as prohibited. However, it allows **agent-building SDKs that do not give you a pre-built agent**, such as Vercel AI SDK, Mastra, Langchain.js, and raw LLM provider SDKs.[^10_1]

## How to evaluate the OpenRouter skill

From the description, the `create-headless-agent` skill **scaffolds** a headless agent in TypeScript + Bun with structured input and output. That suggests it is a **project generator or template**, not a runtime agent SDK.[^10_2]


| Scenario | Likely compliant? |
| :-- | :-- |
| You run the skill once to generate boilerplate, then **remove it as a dependency** and own all the agent loop code yourself | **Yes** |
| The skill remains an installed package that provides the agent loop, tool execution, or state management for your daemon | **No** — this functions like a pre-built agent SDK |

## Safe approach

If you use the skill for inspiration or initial structure, then **reimplement the agent loop, inference calls, and state management yourself** using only permitted libraries (e.g., Vercel AI SDK, Anthropic SDK, or raw fetch), you stay within the rules. The critical test is: *can your agent run without any OpenRouter agent package installed?*[^10_1]
<span style="display:none">[^10_3]</span>

<div align="center">⁂</div>

[^10_1]: https://electric.ax

[^10_2]: https://openrouter.ai/docs/cookbook/building-agents/create-headless-agent

[^10_3]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c


---

# i think the skill uses the openrouter agent typescript sdk so it likely isnt compliant

You're correct. If the skill depends on the **OpenRouter agent TypeScript SDK** as a runtime library, it would likely violate the constraint.[^11_1]

## Why it would be non-compliant

The spec prohibits using **"the SDK of an existing coding agent"** as direct or indirect dependencies, explicitly naming Claude Code SDK, OpenCode SDK, Amp, and Cursor. The OpenRouter agent SDK is functionally the same category: a **pre-built agent framework** that provides the agent loop, tool calling, and state management for you. Using it would mean your coding agent's core logic is not your own implementation, which is exactly what the assessment is testing.[^11_1]

## What is allowed instead

The spec permits **agent-building SDKs that do not give you a pre-built agent**:[^11_1]


| Allowed | Example Use |
| :-- | :-- |
| **LLM provider SDKs** | `@anthropic-ai/sdk`, `openai`, `@google/genai` for raw API calls |
| **Agent-building SDKs** | Vercel AI SDK, Mastra, Langchain.js for orchestration primitives |
| **Raw HTTP/fetch** | Direct API calls with your own loop implementation |

## Recommended approach

Build the agent loop yourself using the **Vercel AI SDK** or raw Anthropic/OpenAI SDKs. These give you tool-call streaming and message formatting primitives without handing you a complete agent runtime. That keeps you compliant while still being productive.[^11_1]
<span style="display:none">[^11_2]</span>

<div align="center">⁂</div>

[^11_1]: https://electric.ax

[^11_2]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c


---

# Based on the questions raised in this conversation, help me build a clear, grounded understanding of the project before I start the next phase of work.

Here is a consolidated, grounded understanding of the HumanLayer take-home assessment based on the full spec and our discussion.[^12_1][^12_2]

## What You Are Building

A **sync-based headless coding agent** with a **reactive web UI**. The system lets a user create coding tasks through a browser, then watch a background agent execute them in real time on a sandboxed host—with every tool call, thinking step, and message streaming live to the UI without polling.[^12_1]

## Architecture \& Components

| Component | Technology | Role |
| :-- | :-- | :-- |
| **Server Process** | TypeScript web server | API for auth, session CRUD, and sync-driven UI data |
| **Database** | Postgres | Persistence for users, sessions, events |
| **Sync Engine** | Electric SQL | Streams Postgres changes to clients in real time |
| **UI Client Store** | TanStack DB | Reactive browser-side cache consuming Electric SQL streams |
| **Agent Daemon** | TypeScript CLI | Headless worker that reads tasks via sync and streams events back |
| **Agent Host** | Isolated container (e.g., Ubuntu) | Runs the daemon; **no exposed ports** [^12_2] |

## How the Pieces Interact

1. **User** logs into the web UI and creates a session.
2. **Server** writes the session to Postgres.
3. **Electric SQL** syncs that new session row to the agent daemon.
4. **Agent daemon** picks up the task, runs the LLM loop (inference → tool calls → execution), and writes events (tool calls, assistant messages, thinking tokens) back to Postgres.
5. **Electric SQL** pushes those events to the browser.
6. **TanStack DB** updates the UI reactively so the user sees live progress.[^12_1]

The agent and UI never talk directly. They communicate through the shared sync layer.[^12_1]

## Key Terms in This Context

| Term | Meaning Here |
| :-- | :-- |
| **Headless** | The agent has no UI of its own. It is a background daemon that receives tasks and emits events programmatically [^12_1][^12_3]. |
| **Sync-based** | Data changes propagate automatically from Postgres to all connected clients via Electric SQL, rather than the UI polling HTTP endpoints [^12_1][^12_4]. |
| **Daemon** | A long-running background process that waits for work, executes it, and streams results without user interaction [^12_5]. |

## Deployment Model

- Everything boots with `docker compose up` after setting a `.env` file.[^12_2]
- The server/UI containers expose ports for browser access.
- The agent container is **portless** and connects **outbound** to the server/Postgres.[^12_2]
- Because the agent connects outbound, it can theoretically run on a separate machine (e.g., your laptop) while the server lives on Hetzner, though the provided `docker-compose` bundles them.[^12_1]


## Authentication \& Authorization

- Auth happens in the **server and web UI**, not the agent.[^12_1]
- You must implement proper request authorization and security boundaries.[^12_1]
- The agent daemon does not log in; it connects to the sync layer (and presumably an internal API) using whatever credentials you configure in its environment.


## Constraints \& Compliance

| Rule | Details |
| :-- | :-- |
| **Language** | Entirely TypeScript (frontend + backend/agent) [^12_2] |
| **No pre-built agent SDKs** | No Claude Code SDK, OpenCode SDK, Amp, Cursor, or similar as dependencies [^12_2] |
| **Allowed helpers** | Vercel AI SDK, Mastra, Langchain.js, raw LLM provider SDKs (Anthropic, OpenAI, Google) [^12_2] |
| **No Next.js** | Use a different framework or vanilla setup [^12_2] |
| **Sync stack** | Must use Electric SQL + TanStack DB + Postgres [^12_2] |
| **Docker Compose** | Must include containers for server/UI, DB, Electric SQL, and a separate agent container [^12_2] |
| **LLM config** | May require an API key in `.env` or support local models (llama.cpp, etc.) [^12_2] |

## Deliverables

- GitHub repo (public or shared with `K-Mistele`) with full git history.[^12_2]
- `README.md` with setup instructions and a link to a Loom video walking through architecture, design decisions, data model, and security model.[^12_2]
- If you used AI coding assistants, include your config directory (e.g., `.claude`, `.cursor`) and any `AGENTS.md` or `CLAUDE.md` files.[^12_2]


## What the Agent Must Actually Do

- Implement its own **agent loop**: inference calls, state management, tool execution.[^12_1]
- Receive tasks via Electric SQL sync from the server-managed database.[^12_1]
- Execute sessions on its local host (file writes, shell commands, etc.).[^12_1]
- Send granular events (tool calls, thinking tokens, assistant messages) back to the server for persistence and sync.[^12_1]


## Next Phase Considerations

Before you start coding, you will likely want to decide on:

- Your web framework (since Next.js is banned, consider Vite + React, Remix, or similar).
- Your server framework (Express, Fastify, Hono, or Elysia).
- Your agent loop library (Vercel AI SDK is the safest compliant choice for streaming tool calls).
- Your auth strategy (JWT sessions, OAuth, or simple token-based).
- Your Postgres schema for sessions, events, and users.

Would you like help sketching the data model or choosing a stack?

<div align="center">⁂</div>

[^12_1]: https://firebasestorage.googleapis.com/v0/b/gauntlet-hq.firebasestorage.app/o/project-documents%2Fproject_1779150256327.pdf?alt=media\&token=953b7129-1592-45e9-842b-746aeca35f0c

[^12_2]: https://electric.ax

[^12_3]: https://www.lyzr.ai/glossaries/what-is-headless-ai-agent/

[^12_4]: https://news.ycombinator.com/item?id=43397640

[^12_5]: https://github.com/different-ai/openwork/issues/508

