# Contributing

Thanks for helping. The most useful contribution is a **speaker profile** for a component or
speaker that isn't covered yet.

## Sharing a profile

The quickest way: in Speaker Tuner, set up your speaker (ideally with **Upload ESPHome YAML**
and, after tuning, **Save as recommended for this build**), then press **Share profile** in
Set up › Speaker. It opens a GitHub issue with the profile filled in, without your YAML file,
entity IDs or secrets. A maintainer checks it and adds it to `profiles/contrib/`, and the next
release offers it to everyone.

To add one yourself as a pull request:

1. Write and test the profile with your own speaker (see "Writing a profile" in the README).
   Check that discovery maps the entities, a fit applies cleanly, and the exported YAML passes
   `esphome config`.
2. Put it in `custom_components/speaker_tuner/frontend/profiles/contrib/`, named after its `id`,
   and add the `id` to `profiles/contrib/index.json` (the app loads the profiles listed there).
3. Make sure it holds **no personal data**: no entity IDs, device names, URLs or tokens.
   Those belong in a device mapping, which stays with your Home Assistant.
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
