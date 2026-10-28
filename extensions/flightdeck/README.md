# Flightdeck for Hermes WebUI

Flightdeck adds an instrument panel beside WebUI chat, adapted from [scasella/claude-flightdeck](https://github.com/scasella/claude-flightdeck). It is for people who want to follow a WebUI turn without leaving the conversation. The desktop Flight tab sits in the workspace panel; on narrow screens a summary strip above the composer opens the panel.

- **Main:** model, provider, context and compression, cost, cache and estimated output tokens per second.
- **Gate:** tool activity, errors and approval states; **Agents:** delegated tasks and linked child sessions.
- **Advisor:** consults matching a configurable pattern; **Receipt and log:** turn duration, tool counts and recent activity.

## Install, disable and uninstall

Once Flightdeck is available in your configured gallery, open **Settings → Extensions → Gallery**, find Flightdeck and install it. Reload the WebUI tab. Disable or uninstall it through **Settings → Extensions**. Gallery availability depends on it being published to the gallery you use; this source repository alone does not make it available there.

Flightdeck needs no server restart or sidecar. Configure layout, panel order, advisor words, phone strip and child tracking under **Settings → Extensions → Flightdeck**. Advisor words are plain words separated by `|`, matched without case in the tool name or delegate role; they are not a regular expression.

## Data access and trust

Flightdeck is a same-origin WebUI extension and runs with the signed-in user's WebUI access. It observes the active turn via a second read-only EventSource to `/api/chat/stream`, including replay, and reads `/api/sessions` and `/api/session` to match and inspect child sessions. Session listing may include other conversations; child details can include messages, tool calls and answers. It opens child sessions using WebUI navigation, and adds its own tab, panel and phone strip to the host DOM, including changing host panel visibility. It sends no WebUI API writes, makes no external network requests, and has no filesystem access, native host or sidecar.

State is stored only through the WebUI extension-owned storage namespace: `s:*` per session, `index` and `ui`. It does not directly access raw browser storage; WebUI may back its storage API with local storage. State can include activity and snippets from the session, so anyone with access to the browser profile may be able to read it. Masking is best effort, not a privacy guarantee. Saves are debounced, limited to 20 sessions and approximately 400,000 characters in the namespace, with older sessions evicted and oversized state reduced. If the storage API is unavailable, state is held in memory for that page load only.

While child tracking is enabled, normal polling runs for active children in a visible tab, backing off from 4 to 20 seconds when unchanged. A refresh can also occur on session switch, delegation or turn completion, but never while the page is hidden. Requests time out after 12 seconds and are aborted when the selected session changes. At most four child details are fetched per poll; there are no overlapping polls. Disable child tracking in settings to stop these requests.

## Limitations

- Tool error classifications are **inferred** from available result snippets and shell error shapes; WebUI may omit exit codes or truncate output, so failures can be missed or misclassified. Approval outcomes are also inferred from subsequent tool events, not an authoritative approval audit.
- Agent cards are matched to child sessions by parent and timing. Their completion, activity and answers are polled snapshots, not a complete live subagent event stream; matches and status can be wrong or delayed.
- Only turns visible through the WebUI chat stream are observed; other clients' activity is not necessarily represented. Plan quota windows are not available.
- Output tok/s is calculated from output-token deltas over estimated model time with tool time excluded. Replay, time to first token, incomplete metering and concurrent activity can affect it; it is not raw decode speed.
- Requires a WebUI supporting extension bundles, extension settings/storage, turn events and the listed session/stream APIs. Browser-checked against WebUI v0.52.492 with seeded, synthetic demonstration data at desktop 1440 px and phones 390/320 px, in light/dark themes, and against v0.52.568 with a live agent turn from a mock model provider (three rounds, twelve tool calls) at desktop 1440 px and phone 390 px. Screenshots use synthetic demo data, not user conversations.
- A turn that was running when you left a conversation is replayed from WebUI's run journal when you come back. If WebUI no longer has that stream, the turn is closed at its last recorded activity as "ended", with its outcome unknown.

## Tests

From the root of this repository, after `npm install` (the UI suite uses `jsdom`), run `node --test scripts/test-flightdeck-core.mjs scripts/test-flightdeck-ui.mjs`. Both are registered in `scripts/behavior-tests.json`, so `node scripts/run-behavior-tests.mjs` runs them with the rest of the gallery. The core suite replays recorded turn journals that were anonymized before publication (user commands, goals, paths and tool output replaced; sequence, timing and outcome shape kept), embedded in the test file. The UI suite covers stream/session races, recovery of a turn left running, poll isolation and rotation, focus and pointer stability, keyboard containment against Core's approval shortcut, two-tap reset, bounded storage and mobile accessibility.

## License and attribution

MIT. Portions are derived from [scasella/claude-flightdeck](https://github.com/scasella/claude-flightdeck), copyright (c) 2026 Stephen Casella; see the accompanying `LICENSE` for the full notice and terms.
