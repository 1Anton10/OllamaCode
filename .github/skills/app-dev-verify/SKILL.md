---
name: app-dev-verify
description: General agent pipeline — understand → edit via tools → run → verify. Includes windows_desktop TEXT_VISION recipe.
---

# Agent work pipeline

Не объявляй «готово», пока не прошёл проверку через tools. Не выдумывай вывод терминала / UI.

## 1. Понять задачу

- Цель, критерии успеха, что уже есть в workspace.
- Если неясно — один короткий вопрос; иначе сразу tools.
- **Сбой / ошибка:** сначала получи сигнал через tools (`run_in_terminal` / `get_terminal_output` / diagnostics / уже видимый TOOL_RESULT) → **одной фразой** назови проблему из этого сигнала → правь код проекта под него. Одна гипотеза → один подтверждающий tool → действие. Не углубляйся в догадки без нового факта.

## 2. Смотреть код

- `read_file` / `grep` / `list_files` / `repo_map` — не `cat` в терминале.
- Короткие файлы приходят целиком (EOF в hint) — **не** листай offset/limit.
- Увидел проблему → сразу `replace_in_file` / `write_to_file`, не ещё один read.

## 3. Менять

- Правки только tools: `replace_in_file` / `write_to_file`.
- Маленькие точечные diff’ы; не переписывай файл целиком без нужды.
- Не утверждай «исправил», пока TOOL_RESULT не OK.

## 4. Запускать

- `run_in_terminal` с **реальной** `command` (например `python main.py`).
- Убедись, что в файле есть точка входа (`if __name__ == "__main__":` / `asyncio.run(main())`) — иначе процесс сразу выходит без вывода.
- После запуска бота `get_terminal_output` **должен** показать лог (ready/polling). Если только `PS ...>` / пусто — это FAILURE (`EMPTY_OUTPUT`), бот не жив.
- Долгие процессы (сервер, watcher, бот) → background/async; сохрани `terminal_id`, смотри `get_terminal_output`.
- Живой процесс **оставь в фоне**; `kill_terminal` — только сбой / рестарт / просьба пользователя.
- Traceback / non-zero → чини код (шаг 2–3), потом тот же запуск.

## 5. Проверять по типу задачи

| Тип | Достаточно |
|---|---|
| CLI / lib / скрипт без UI | зелёный запуск / тест + реальный вывод |
| Web UI | сервер + клики в браузере или `windows_desktop` по окну браузера |
| Нативное окно (Tk/WPF/…) | `windows_desktop` recipe ниже |
| Мессенджер-бот | бот в фоне + recipe ниже на клиенте Telegram/Discord |

## 6. windows_desktop (TEXT_VISION)

У модели **нет** зрения. PNG от `screenshot` бесполезен. Глаза = текст TOOL_RESULT: `match`, `pick`, `elements`.

### Правильный рецепт (Telegram-бот E2E)

1. `windows_desktop` `{ "action":"snapshot", "process":"Telegram" }`
2. Прочитай `match.hwnd` или первую строку `pick` с `process=Telegram`
3. `focus` `{ "action":"focus", "hwnd": <число> }`
4. `ui_tree` `{ "action":"ui_tree", "hwnd": <число>, "max_depth": 3, "focus": false }`
5. По `elements` найди поле ввода / чат → `click_element` или `type` / `keys` с тем же `hwnd`
6. Сверь ответ бота + `get_terminal_output`

### Важные правила

- Фильтруй по **`process=Telegram`**, не по `title=Telegram` — заголовок окна часто имя чата.
- Если `pick: EMPTY` но `process_alive: true` / `match.on_screen=false` — окно в трее. Сделай `focus(hwnd=match.hwnd)` (restore), потом `ui_tree`. Если focus не дал foreground — `ui_tree(hwnd=...)` всё равно можно.
- Если `process_alive: false` — клиент не запущен; скажи пользователю открыть Telegram или `launch`.
- Если `ui_tree` / `tree_process` = OllamaCode/Cursor — **не то окно**. Заново snapshot(process=Telegram).
- **Никогда** `close` / `%{F4}` / Alt+F4 на Telegram, Discord, браузер, OllamaCode — заблокировано и ломает ПК пользователя.
- `keys` и `close` требуют `hwnd` или `title`/`process` (глобальный SendKeys запрещён).
- `ui_tree` по умолчанию **не** ворует focus (`focus=false`).
- Не кликай Close / × / «закрыть» через `click_element`.

### Антипаттерны

- `screenshot` «чтобы посмотреть» → бесполезно.
- `snapshot(title="Telegram")` при чате с другим title → 0 windows; используй `process`.
- Клики по Pane/IDE после сбитого focus.
- Объявлять E2E готовым только по «бот запущен в терминале».

## 7. Итог пользователю

- Что сделано, как проверил, что осталось / блокеры (честно).
- Не обрывай мысль на полуслове; допиши ответ.
- Не зацикливайся на одном и том же tool+args — смени подход или дай итог.

## Не делать

- Финал только по «запустил процесс» без проверки из таблицы выше.
- Выдуманные `terminal_id` / результаты tools.
- Idle-текст «сейчас запущу» без tool_calls.
- Закрывать Telegram/Discord/браузер/IDE через `windows_desktop`.
- Пустая `command` в `run_in_terminal`.
