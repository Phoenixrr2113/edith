# System Prompt Research — Source Material

This document captures all research findings for the Edith prompt rewrite.
Combined from: Randy's research, agntK codebase analysis, predecessor agent analysis, Manus/Devin/ReAct research, and full prompt audit.

---

## The "Right Altitude" Principle (Anthropic)

Write at the Goldilocks zone between:
- **Too Prescriptive (Brittle):** "If X, call tool A, then check Y, then call B..."
- **Too Vague (Useless):** "You have tools. Use them when appropriate."
- **Sweet Spot:** Specific enough to guide, flexible enough for the model to reason.

## The 7 Principles

1. **Define identity and philosophy, not steps** — Tell the agent who it is and what it values. It will derive tool usage from understanding its role.

2. **Describe tools like onboarding a smart coworker** — What it does, when to use it, when NOT to, what parameters mean in context, edge cases. Don't duplicate tool schemas in system prompt.

3. **Use heuristics, not rules** — Give decision-making frameworks, not if/else chains.

4. **Give examples, not edge case lists** — 3-5 representative examples teach multiple lessons simultaneously.

5. **Make tool responses token-efficient and self-correcting** — Graceful errors in natural language let agents self-correct without retry logic.

6. **Structure context with clear sections** — XML tags or markdown headers create cognitive scaffolding.

7. **Design for context as a finite resource** — Every token must justify its existence. Minimal but complete.

## Anti-Patterns

1. "If X, Then Tool Y" branching logic — the model reasons better than you can enumerate
2. Duplicating tool schemas in system prompt — contradictions when one is updated
3. Over-constraining output format — model spends attention on formatting, not quality
4. Defensive over-prompting — adding rules for every bad behavior bloats and contradicts
5. Assuming shared context — "use the standard format" means nothing to the model

## Key Quote

> "Think of system prompt design as hiring and onboarding an employee, not writing a script for a call center agent. A well-onboarded employee with good tools and clear values will handle novel situations better than someone following a 200-page script."

## Manus Agent Patterns

- Every step is a tool call, not text narration
- 6-step agent loop: analyze → select tool → execute → observe → record → repeat
- Event stream as working memory (not scratchpad prose)
- todo.md as persistent plan surviving context resets
- 3-strike error recovery: try → alternative → switch strategy → escalate
- CodeAct: generate executable code rather than fixed commands

## Devin Lessons

- Verifiable success criteria drive better reasoning (2x improvement)
- Rich context > brief instructions (doubled PR merge rates)
- Two human checkpoints: plan approval + output approval
- Gap: no agent has cleanly crossed "executes tasks" → "identifies what to work on"

## ReAct Pattern

```
Thought: Reason about current situation
Action: Take one specific action
Observation: See the result
(repeat until done)
```

## Executive Assistant Mental Model

1. Know priorities before being asked
2. Pre-research everything (brief generated before the person knows they need it)
3. Draft → route → track → follow up (full lifecycle, not just step 1)
4. Surface only decisions (everything else handled silently)
5. Pattern recognition from memory

## agntK — What Makes It Less Robotic

1. **Reflection injection** — After every step (or every N steps), injects: "What's the user's goal? What have you accomplished? Most important next action? On track?" Forces meta-cognition.

2. **Skills as prompt injections, not scripts** — Skills have `whenToUse` (natural language), model tier, max steps. They're reasoning guidance injected into system prompt, not checklists.

3. **Memory structured by intent** — `identity.md`, `preferences.md`, `decisions.md`, `context.md`. Each file serves a different cognitive purpose.

4. **Tool results include hints** — `{ success: false, error: "...", hint: "Try X instead" }`. Agent learns from failures in-context.

5. **Dynamic prompt assembly** — Base → skills → memory → workspace → environment → reflection. Each layer enriches the next.

6. **Deep reasoning tool** — Not just chain-of-thought. Structured `thought` + `thoughtNumber` + `totalThoughts` with revision and branching. Enables explorable reasoning paths.

7. **Planning with forced delegation** — If plan > 5 steps, must decide to delegate to sub-agent. Prevents context bloat.

8. **Model tiers** — fast/standard/reasoning/powerful. Complex tasks delegated to reasoning tier. Rich prompts compensate for cheaper models.

9. **"Conversational if vague"** — Explicit rule: "If the user's request is vague or conversational, respond conversationally without using tools."

10. **No personality hardcoded** — Identity is composable: instructions + skills + memory + workspace. More flexible than a fixed system prompt.

## Predecessor Agent — Key Patterns

1. **"Mind + tools" philosophy** — "You have a mind and you have tools. Tools extend your thinking - use them fluidly as part of reasoning, not as separate mechanical steps."

2. **"Thinking out loud" format** — Before each action: Goal (what am I trying to accomplish?), Approach (why this tool?), Risk (what could go wrong?). 1-2 sentences each.

3. **Action over announcement** — "Do things, don't announce them. Instead of 'I'll search for X', just search."

4. **Error-driven adaptation** — "When something doesn't work, adapt. When you need information, go get it. When uncertain, reason carefully. When clear, act directly."

5. **Forced decision points** — Plan tool at 5+ steps MUST choose delegate or proceed. Prevents accidental giant context chains.

6. **Context summarization** — At 60+ messages: keep first 2 + last 15 + summarize middle. Preserves conversation shape.

7. **Role-specific prompts** — Same core agent, different system prompts: generic, researcher, coder, analyst. Sub-agents spawned with roles.

8. **Errors are observations** — No try-catch swallowing. Errors become observations the LLM reads and self-corrects from.

9. **Streaming events** — Real-time visibility into thinking (text-delta, tool-call, tool-result, step-finish).

10. **Background memory extraction** — Memory stored async after response, doesn't block task completion.

## The Fundamental Difference

Both agntK and the predecessor agent are **reasoning-first, tool-second**. They assume the LLM does real thinking and tools extend that thinking. Edith is **tool-first, reasoning-absent** — she dispatches to `claude -p` which is a black box with no reasoning control.

The CLI (`claude -p`) is the bottleneck. It doesn't allow:
- Reflection injection mid-conversation
- Model switching per task
- Streaming tool call visibility
- Context management (summarization, window control)
- Structured reasoning (deep reasoning tool, planning with delegation)

## Recommendation

Phase 1: Rewrite prompts using "right altitude" principles (identity + heuristics + examples, not checklists). This helps regardless of CLI vs SDK.

Phase 2: Migrate from `claude -p` to SDK-based agent loop (Anthropic SDK or agntK SDK). This unlocks reflection, model tiers, context management, and everything that makes agntK smart.
