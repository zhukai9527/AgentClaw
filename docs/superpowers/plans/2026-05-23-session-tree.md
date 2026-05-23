# Session Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class tree-shaped conversation history so AgentClaw can branch from earlier turns, keep failed and repaired paths in one session, and replay only the active path into the agent loop.

**Architecture:** Phase 1 adds durable tree primitives at the memory/session layer and exposes narrow session APIs. Existing linear sessions stay compatible: old rows without parent metadata are read chronologically, while new rows automatically append to the active leaf.

**Tech Stack:** TypeScript, SQLite, Fastify routes, Vitest, pnpm/turbo.

---

## Acceptance Matrix

| Case | Input | Expected result | Evidence |
|---|---|---|---|
| Linear compatibility | Existing turns with no parent metadata | `getHistory()` returns chronological history | Memory unit test |
| Automatic parent chain | Add user then assistant turns to a new conversation | Second turn points to first; active leaf is second | Memory unit test |
| Branch switch | Set active leaf to an earlier user turn and add a new turn | New turn becomes sibling of the abandoned branch, not appended to it | Memory unit test |
| Active branch context | Tree has two branches | `getHistory()` returns only the selected branch path | Memory unit test |
| Full tree visibility | Request tree for conversation | API returns all turns plus active leaf | Route test/manual API smoke |

## Task 1: Memory Model

**Files:**
- Modify: `packages/types/src/memory.ts`
- Modify: `packages/memory/src/database.ts`
- Modify: `packages/memory/src/store.ts`
- Test: `packages/memory/src/__tests__/store.test.ts`

- [x] Add `parentId`, `branchId`, and `activeLeafId` types.
- [x] Add SQLite columns `turns.parent_id`, `turns.branch_id`, and `conversations.active_leaf_turn_id`.
- [x] Make `addTurn()` append to the current active leaf when parent is not explicit.
- [x] Make `getHistory()` return the active branch path when tree metadata exists, with legacy chronological fallback.
- [x] Add `getConversationTree()` and `setActiveConversationLeaf()`.

## Task 2: Session API

**Files:**
- Modify: `packages/gateway/src/routes/sessions.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/types/src/agent.ts`

- [x] Add `GET /api/sessions/:id/tree`.
- [x] Add `POST /api/sessions/:id/active-leaf` with `{ turnId: string | null }`.
- [x] Add orchestrator methods that validate the session before calling memory-store tree primitives.
- [x] Keep all existing `/history` consumers working.

## Task 3: Verification

**Commands:**
- `pnpm --filter @agentclaw/memory test -- src/__tests__/store.test.ts`
- `pnpm --filter @agentclaw/gateway test -- src/__tests__/routes.test.ts`
- `pnpm typecheck`
- `C:\Users\voroj\.agent-flow\commands\agent-flow.ps1 verify`

**Done means:** tests prove old linear sessions still work, branch switching changes only the active path, and full tree state remains inspectable.
