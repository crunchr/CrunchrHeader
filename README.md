# CrunchrHeader

A standalone Chrome Manifest V3 extension for applying reusable request and response HTTP-header profiles.

## What it does

- Keeps the selected profile while a clear **On/Off** switch controls whether it is applied.
- Modifies request or response headers with `set`, `append`, and `remove` operations.
- Lets every rule target its own Chrome URL filters and excluded domains. Rules apply to every request type matching the URL scope.
- Stores profiles locally, with duplication, reordering, JSON export, and merge-or-replace import.
- Requests website access only when a profile is activated or an active profile adds a new scope.

Chrome restricts request-header `append` to a fixed allowlist. The editor prevents unsupported request appends; response appends are supported by Chrome's declarative rules engine.

## Install for development

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `chrome-header-profiles` folder.
5. Pin **CrunchrHeader**, then open it from the toolbar.

The extension starts with an inactive Development profile, so it does not alter traffic until you enable and apply a completed rule.

## URL filters

Rules use Chrome declarativeNetRequest `urlFilter` syntax. Put one filter per line.

| Filter | Matches |
| --- | --- |
| `*` | Every HTTP or HTTPS request for which access is granted |
| `||example.com/` | `example.com` and its subdomains |
| `|https://api.example.com/` | URLs starting with that API origin |
| `example.com/v2/` | URLs containing the supplied text |

Each enabled rule applies to every request type matching its URL filter, including page navigations, scripts, images, and Fetch/XHR requests.

## Notes

- The topmost rule has the highest Chrome priority when rules overlap.
- Only the active profile is compiled into Chrome dynamic rules, keeping inactive profiles inert.
- Browser cache and responses generated directly by a site service worker may not be affected by declarative network rules.
- Header values can contain credentials. They remain in Chrome local extension storage and are included in JSON exports, so protect exported files.
