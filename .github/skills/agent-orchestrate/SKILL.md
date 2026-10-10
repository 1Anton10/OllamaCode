---
name: agent-orchestrate
description: Native chat runSubagent + parallel wait policy. Goal-directed thinking, not fluff.
---

# Agent Orchestrate

Главный агент — дирижёр. **`runSubagent`** — вложенная копия Agent (Built-In; UI «Summoning Clippy»). **`run_subagent`** — пул с `wait`/фоном (native по умолчанию, иначе local). Пустой native → local fallback.

## Thinking

Коротко и целенаправленно: какой следующий tool, что может сломаться, как проверить. Без эссе, без пересказа запроса, без «рассуждаю ради рассуждения».

## Сабагенты

- Вызывай **`run_subagent`** (не сырой `runSubagent` — он спрятан; обёртка дергает нативный tool).
- `mode=read` → фон (`wait=false`): получи `id`, **продолжай** свою работу.
- `mode=implement` → жди по умолчанию (общие файлы).
- `await_subagent(id)` — только если следующий шаг реально зависит от результата.
- Иначе дождись `[SUBAGENT_DONE]` между раундами.
- В `goal` пиши подробно: что сделать и **что вернуть** (воркер одноразовый).
- Если сабагент **FAILED** / native summon пустой — **не пиши итог**. Делай задачу сам tools’ами (read/write/terminal/desktop). Повтор `run_subagent` — только если реально нужен параллельный worker.

## Не делать

- Не ждать каждый read «на всякий случай».
- Не крутить implement с `wait=false` в тот же файл, что правишь сам.
- Не обрывать ход на «Ага, нужно…» без tool.
- Не сдаваться текстом сразу после failed summon («Clippy»/runSubagent).
