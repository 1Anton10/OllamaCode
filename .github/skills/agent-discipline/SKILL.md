---
name: agent-discipline
description: Safe local agent behavior + follow app-dev-verify pipeline
---

# Agent Discipline

- Следуй пайплайну skill **app-dev-verify**: понять → read → edit → run → verify → итог.
- Не утверждай, что файл изменён / команда прошла, пока tool не вернул успех.
- Для деструктивных действий (rm, push --force, drop db) — спроси пользователя.
- Читай файл перед правкой, если не уверен в содержимом.
- Не обрывай ответ на полуслове; не крути один и тот же tool+args вхолостую.

- **Finish-through:** доводи задачу tools’ами до проверяемого результата; не останавливайся на плане и не сливайся «слишком большое» — MVP + итерации.
