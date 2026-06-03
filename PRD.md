# Headless Coding Agent with Sync Driven Application

## PRD
Develop a comprehensive sync-based headless coding agent system that allows users to create, manage, and interact with coding sessions across different environments. 
The system needs to provide a robust, flexible platform for running coding tasks with real-time synchronization and seamless user experience. 
UI state must be primarily driven by Electric SQL + Tanstack DB-powered sync

## Problem & Context
**Business Context**
Create a flexible coding agent platform that enables developers to run coding tasks remotely, track progress in real-time, and manage sessions across different computing environments with advanced synchronization capabilities.


## Requirements & Success Criteria
**Functional Requirements**

User authentication and authorization, Session creation and management, Real-time coding agent synchronization, Ability to interrupt and continue sessions, session management API, sync-driven UI state

**Performance Benchmarks**
React UI performance

**Code Quality Expectations**
Typescript type-safety
Testable design & high-quality tests 
Well-structured & factored codebase

**Time Constraints**
3-4 days

**Technical Contact**
Kyle Mistele (kyle@humanlayer.dev)

## Technology

Required Languages

TypeScript

AI / ML Frameworks

Up to you

Dev Tools

Docker, npm/bun

Other Requirements

Postgres, Electric SQL, Tanstack DB

Off-Limits Tech

Next.js
non-postgres databases
websockets


# HumanLayer Take-Home Assessment
This assessment is solely for the purposes of evaluating your qualifications for a role at HumanLayer.
Nothing in this assessment will be used in HumanLayer’s products and/or systems. Neither
HumanLayer’s issuance of this assessment to you nor your completion of it constitute an offer of or
contract for employment at HumanLayer.
Task
Your task is to implement a sync-based headless coding agent and user interface. The components of the
system should be as follows:
1. Server Process
a. Runs on a web server. Provides an API for user interaction.
b. Provides sync-driven functionality for user interface
2. Postgres Database & Electric SQL
a. Postgres database - used by the server process for data persistence
b. Electric SQL (https://electric.ax/sync/) - postgres-based sync engine
3. Headless Coding Agent / Daemon
a. Should be able to run anywhere that can connect out to the server - on a workstation,
sandbox, container, etc.
b. Contains the coding agent’s “agent loop” including inference API calls, state, etc.
c. Starting it must be as simple as running a CLI command.
d. Receives user-requested tasks / sessions from the server via electric SQL sync
(optionally + tanstack DB)
e. runs the sessions on the host it’s running on, and sends events (tool calls, thinking
tokens, assistant messages) to the server to be stored in the database and synced to
clients
4. User interface
a. Reactive user interface which allows the user to interact with the server over APIs for
session creation.
b. ALL collections (sessions, events (tool calls, conversation messages) must be synced
to the UI through Electric SQL and Tanstack DB
c. Running sessions that are saved in the server-managed database should be synced out
to the client in live-time so the user can see the coding agent’s work as it is working
d. Users should be able to…
i. Login & logout
ii. View a list of sessions they have created & navigate through them
iii. Create & delete sessions
iv. Interrupt sessions & continue interrupted sessions
v. Update (e.g. rename) and delete sessions

# Constraints
● Your project MUST be written entirely in TypeScript both for the frontend and for the coding agent
harness/backend
● Your application MUST implement authentication & authorization security boundaries in a manner
appropriate to the application and its architecture - proper request authorization, etc.
● You are free to use whatever libraries, toolchain, and packages that you would like with a few
caveats:
1. You MUST NOT use the SDK of an existing coding agent (Claude Code SDK, OpenCode
SDK, Amp, Cursor, etc.) as your coding agent. You may use them for inspiration, but your
coding agent’s source code may not use their SDKs, binaries, or source code as direct or
indirect dependencies.
a. Use of LLM provider SDKs or agent-building SDKs which do not give you a
pre-built agent (e.g. the Vercel AI SDK, Mastra, Langchain.js, and LLM provider
SDKs is acceptable.
2. You MUST NOT use Next.js
3. Your deliverable MUST include a docker-compose configuration to set up the application
4. Your application’s sync system MUST use electric SQL, tanstack DB, and Postgres.
● Your deliverable MAY require the end-user to configure an API key for an LLM inference provider
(Anthropic, OpenAI, Google) for the coding agent to work
○ or it may rely on locally-served models through llama.cpp or similar.
○ Ensure you provide configuration instructions in your deliverable.
● All your work done on the assessment MUST be tracked in your version control
● The deliverable MUST include a docker-compose project which:
○ which has containers for:
■ the server process and UI (they may in the same or in separate containers)
■ the database
■ Electric SQL container
■ a separate container (e.g. ubuntu) which the coding agent runs inside and
connects out to the server process from
○ The server container and UI container should expose appropriate ports so a user can
interact with them. The container which the coding agent runs inside may not
expose or open any ports.
○ A reviewer MUST be able to configure any required API keys in a .env file and run
docker compose up to build and run the project successfully, without any additional
build steps or configuration. Submissions which do not build successfully will be rejected.

# Deliverables
Your deliverables should be contained within a Github repository that is either public, or which is private
but also shared with the Github account K-Mistele, containing:
● The full source code of your project, including the version history of your work on it through git
commits
● A README.md file at the root of the repository which contains:
○ Sufficient instructions for a technical reviewer to get the project up-and-running for the
purposes of evaluating it
○ a link to a Loom video or other web-viewable video of you demonstrating using the
assessment project and discussing the architecture, design decisions, data model, and
security model
● If you worked with an AI coding agent on the project, you should include your configuration
directory (e.g. `.opencode`, `.claude`, `.cursor`, etc.) and any AGENTS.md or CLAUDE.md file
you used, skills, etc.

