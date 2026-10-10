---
name: qwen-tool-calling
description: Qwen3/Qwen3.5 tool calling for OllamaCode agents
---

# Qwen Tool Calling

- Используй только реальные результаты tools (`[TOOL_RESULT]…[/TOOL_RESULT]`).
- JSON: `{"name":"tool","arguments":{...}}` или XML / `<tool_call><function=…>` по шаблону модели.
- Не выдумывай stdout/stderr.
- Thinking → tool_calls → наблюдай TOOL_RESULT → следующий tool или итоговый ответ.
- После TOOL_RESULT **не** пересказывай задачу пользователя и **не** составляй план с нуля — следующий шаг из evidence.
- Язык thinking и ответа = язык пользователя. Метки `status: BLOCKED` / `TOOL_RESULT` — машинные; комментируй их на языке пользователя.
- Не останавливайся на «сейчас прочитаю / let me read» без tool_calls — сразу вызови tool.
