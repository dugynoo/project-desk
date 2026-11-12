# Mobilný chat pre vzdialený prístup

## Prečo
Terminál na mobile je zle čitateľný. Keď mobil zúži zdieľaný PTY, zostane na desktope
rozsypaný výstup a prstom sa v ňom takmer nedá scrollovať. Používateľ chce na mobile pohľad
ako v Claude alebo ChatGPT.

## Čo
- Pre Claude a Codex sessions so známou konverzáciou (`agentSessionId`) má mobil dve záložky:
  **Chat** (predvolená) a **Terminál**. Antigravity a shell majú len terminál.
- Chat zobrazí správy zo session súboru agenta:
  - používateľove správy ako bubliny,
  - odpovede agenta ako markdown,
  - použité nástroje ako krátke riadky (`⚙ Bash: npm test`).
  Nové správy pribúdajú naživo (polling 1 s) a scrolluje sa natívne.
- Písanie funguje ako doteraz (bracketed paste + Enter). V chate je navyše Esc na prerušenie.
- Chat nemení veľkosť PTY, takže desktopový terminál sa nerozbije. Keď mobil zavrie
  záložku Terminál, desktop si veľkosť vezme hneď späť.
- Ak agent čaká na odpoveď (`needs-you`), napríklad pri povolení alebo výbere, chat ukáže
  tlačidlo na otvorenie terminálu.

## Súkromie (výnimka z pravidla)
Text konverzácie číta len `src-tauri/src/remote/chat.rs`, a to iba na žiadosť spárovaného
mobilu cez overený WebSocket, keď je vzdialený prístup zapnutý. Nikde ho neukladá a posiela
ho len tomuto socketu. Mapovanie session → (provider, agentSessionId) drží server a mobil
ho nedostane. Snímok obsahuje len príznak `chat: true`. Úprava pravidla je v `CLAUDE.md`.
Ostatné watchery (`usage.rs`, hooky) text naďalej neposielajú.

## Ako
- Protokol:
  - klient posiela `chatOpen {id}` a `chatClose {id}`,
  - server posiela `chat {id, reset, items}`, kde `items` sú
    `{role: "user"|"assistant"|"tool", text, name?}`. Pri `reset` ide posledných 400 položiek,
    potom už len pribúdajúce.
- Claude JSONL:
  - `user` (text, bez `tool_result`, meta a sidechain riadkov; `<command-name>` sa zobrazí ako príkaz),
  - `assistant` (`text` a `tool_use` so stručným vstupom; `thinking` sa vynechá).
- Codex rollout:
  - `event_msg` `user_message` a `agent_message` (text bez duplikátov z `response_item`),
  - `response_item` `function_call`, `custom_tool_call` a `local_shell_call` ako nástroje.
- Markdown na mobile:
  - vlastný malý parser do AST a vykreslenie cez DOM, bez innerHTML,
  - podporuje nadpisy, odseky, zoznamy, citácie, bloky kódu, tabuľky, inline kód,
    tučné a kurzívu a http(s) odkazy.
- Zmena `agentSessionId` (napríklad `/clear`) prepne chat na nový súbor s `reset`.
