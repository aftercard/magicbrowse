# Third Party Notices

MagicBrowse includes aftercard-authored code and adapted third-party browser
agent components.

## Nanobrowser

- Project: `nanobrowser/nanobrowser`
- Source commit: `322384f8b4d48d8614343e51efca68c85e64f90b`
- Source repository: <https://github.com/nanobrowser/nanobrowser>
- Upstream license: Apache-2.0
- Upstream license file:
  <https://github.com/nanobrowser/nanobrowser/blob/322384f8b4d48d8614343e51efca68c85e64f90b/LICENSE>

MagicBrowse vendors and adapts browser, DOM, planner, navigator, message,
guardrail, and locale components from Nanobrowser. The adapted code lives under
`src/vendor/**` and related adapter locale files. The `vendor-notes/` directory
records source modules, adaptation choices, and behavior-preservation notes.

The Apache-2.0 licensed Nanobrowser portions remain subject to Apache-2.0.
aftercard-specific code is licensed under MIT unless a file says otherwise.
