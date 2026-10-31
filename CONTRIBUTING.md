# Contributing

Thanks for helping. The most useful contribution is a **speaker profile** for a component or
speaker that isn't covered yet.

## Sharing a profile

1. Write and test the profile with your own speaker (see "Writing a profile" in the README).
   Check that discovery maps the entities, a fit applies cleanly, and the exported YAML passes
   `esphome config`.
2. Put it in `custom_components/speaker_tuner/frontend/profiles/contrib/`, named after its `id`.
3. Make sure it holds **no personal data**: no entity IDs, device names, URLs or tokens.
   Those belong in a device mapping, which stays in your browser.
4. Run `npm test`. The tests validate every profile against the schema and render its YAML
   template.
5. Open a pull request saying which component (with a link) and hardware you tested it on.

Mic profiles (`mics/`) and target curves (`targets/`) work the same way.

## Code

- Plain JavaScript modules with JSDoc types and `// @ts-check`. No framework, no build step,
  no runtime dependencies.
- New DSP or measurement logic comes with tests in `test/`. The simulated speaker in
  `src/demo/` is the place to try guided steps end to end.
- `npm test`, `npx -p typescript tsc --noEmit` and `python -m pytest` must pass; CI runs them,
  plus hassfest and the HACS validator.
