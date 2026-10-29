# Theme Toggle

A Hermes WebUI extension that adds a sun/moon theme toggle button directly
**under the Settings cog** — in the desktop icon rail and the mobile sidebar
nav — for instant light/dark switching without opening Settings.

## What It Does

- Injects one toggle button below the Settings cog in the desktop icon rail
  (`.rail`) and one in the mobile sidebar nav (`.sidebar-nav`). Both use the
  WebUI's own `rail-btn` / `nav-tab` + `has-tooltip` styling, so they look
  like native buttons (tooltip: "Theme").
- Clicking flips between `_pickTheme('dark')` and `_pickTheme('light')` —
  the WebUI's built-in theme functions — so the choice persists in
  `localStorage('hermes-theme')` and stays in sync with **Settings →
  Appearance**.
- The icon is CSS-driven: **sun** in dark mode (click to go light), **moon**
  in light mode (click to go dark). It tracks the effective (`.dark` class)
  theme, so it also behaves sensibly when "system" mode is selected.
- Tooltip/aria text updates automatically when the theme changes from any
  source (the toggle itself, the Settings picker, or a `/theme` command).

## Version History

- **2.1.0** — registry version: the legacy-core fallback (direct
  localStorage / Prism-link writes) is removed; against a core without
  `_pickTheme` the button now degrades to an inert no-op instead.
- **2.0.0** — moved from a floating button to the rail / sidebar nav, under
  the Settings cog (the floating button covered the chat input area).
- **1.0.0** — floating sun/moon button (top-right).

## Who It Is For

Anyone who switches between light and dark more than once a session. It
replaces the Settings → Appearance round-trip with a one-click toggle that
lives next to the cog, and it works on both the desktop rail and the mobile
sidebar nav. It complements (not replaces) skin extensions such as
`e-ink-skin`, `skin-pack`, and `theme-creator`: those register full skins,
while this is only the built-in light/dark pair.

## Install

### One-click (gallery)

Open **Settings → Extensions**, find **Theme Toggle**, and click **Install**.

### Manual

The extension lives in the WebUI-managed extensions directory
(`~/.hermes/webui/extensions/theme-toggle/`) and is registered in
`~/.hermes/webui/extension-install-manifest.json`. Reloading the page loads
it; no WebUI restart is required.

## Disable And Uninstall

Disable from **Settings → Extensions** (toggle), or remove the
`theme-toggle/` directory and its entry from `extension-install-manifest.json`.
Reload the page. Either way the button disappears and theme persistence is
unaffected (it lives in `localStorage`, owned by the core).

## WebUI APIs And DOM Surfaces Used

- `window._pickTheme('light' | 'dark')` — the core's built-in theme setter
  (the same path the Settings → Appearance picker uses). Primary switch
  path.
- `.dark` class on `<html>` — read to determine the effective theme and
  drive the icon.
- `.rail [data-panel="settings"]` and `.sidebar > .sidebar-nav
  [data-panel="settings"]` — read-only location lookups for button
  placement (inserted as the next sibling of the Settings cog).
- A scoped `MutationObserver` on `document.documentElement` (attribute
  filter: `class`) to keep the icon and tooltip text in sync no matter what
  changed the theme.
- Two injected `<button>` elements with extension-scoped ids
  (`hermes-rtt-rail`, `hermes-rtt-mobile`). They carry no `data-panel`, so
  the WebUI's tab order / tab visibility logic ignores them.
- If `window._pickTheme` is unavailable (a core older than the theme
  system), the button degrades to an inert no-op with a single console
  warning — this entry requires the theme API and deliberately has no
  fallback that writes state on the core's behalf.

## Trust Model And Permissions

This is trusted local code. The injected JavaScript runs in the Hermes WebUI
browser origin against the authenticated session.

Disclosed behavior:

- calls the built-in `_pickTheme()` function (same as the Settings picker)
- reads the effective theme via the `.dark` class on `<html>`
- observes `document.documentElement` class mutations (attribute-filtered)
  to keep tooltips in sync
- creates two small DOM buttons with extension-scoped ids
- does not call WebUI HTTP APIs (no `fetch`/`XMLHttpRequest` anywhere)
- contains no external URL literals at all — zero network activity from
  this code
- no sidecar, native host, or OS integration of any kind
- the extension code performs no storage reads or writes at all;
  persistence to `localStorage('hermes-theme')` happens inside the core's
  own `_pickTheme`, and the icon only reads the `.dark` class the core
  sets

## Sidecar / Native Host

None. `loopback_sidecar: false`, `native_host: false`.

## Known Limitations

- Only toggles between the two built-in themes. Selecting a custom skin is
  done in Settings → Appearance (or via a skin extension); this button
  deliberately does not enumerate skins.
- If a WebUI redesign moves or renames the Settings cog (the
  `[data-panel="settings"]` anchor in `.rail` / `.sidebar-nav`), the button
  simply will not appear until the extension is updated — it never breaks
  or hides other UI.
- Selecting the toggle switches "system" mode to an explicit choice. That
  is intentional: the button represents the current effective theme, and a
  round trip always lands on the other explicit mode.

## Compatibility And Verification Notes

- API surface used: manifest-bundle loading (core requirement for all
  entries), the `window._pickTheme` global, the `.rail` / `.sidebar-nav`
  DOM, and the `hermes-theme` localStorage key. No sidecar contract, no
  theme-registration API, no CSP knobs.
- Tested against the WebUI at commit `687d80333` (bunglejuice mirror of
  `nesquena/hermes-webui`): verified in a real browser — both buttons
  injected as the immediate next sibling of the Settings cog on desktop
  and mobile, click round-trip toggling `.dark` and `localStorage
  (hermes-theme)`, icon/tooltip sync after a Settings-side change, and
  screenshot confirmation of rail placement and sizing.
- No WebUI restart is required after install, update, or uninstall; a page
  reload is sufficient (the loader re-reads the install manifest per
  request).
