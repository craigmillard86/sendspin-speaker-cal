// @ts-check
// Share a profile with the project: a copy without anything personal, sent as a GitHub issue
// (issue form "profile.yml") that a maintainer turns into profiles/contrib/<id>.json.

import { redactSecrets } from './esphome-yaml.js';

export const REPO = 'https://github.com/craigmillard86/sendspin-speaker-cal';
/** GitHub's practical URL limit is about 8 KB; above this the JSON goes by clipboard instead. */
const URL_LIMIT = 7500;

/**
 * The profile as shared: settings, recommended values and the board, but not the user's own
 * YAML file (it holds their network and device names) or where it came from on their disk.
 * @param {any} profile @param {Record<string, any>} profiles to restore the base template
 * @returns {{ profile: any, left: string[] }} left: what was left out, to tell the user
 */
export function shareableProfile(profile, profiles) {
  const p = structuredClone(profile);
  const left = [];
  if (p.source?.kind === 'esphome-yaml') {
    const { kind, chip, dac, components, project } = p.source;
    p.source = { kind, chip, dac, components: (components ?? []).filter((/** @type {string} */ c) => /^(github:|https?:)/.test(c)), project };
    const base = profiles[p.based_on];
    if (base?.yaml_template) {
      p.yaml_template = base.yaml_template;
      left.push('your YAML file (the shared profile exports the usual snippet instead)');
    }
  }
  if (p.yaml_template) {
    const r = redactSecrets(p.yaml_template);
    p.yaml_template = r.text;
    if (r.redacted.length) left.push(`secrets (${r.redacted.join(', ')})`);
  }
  if (p.recommended?.tuned_with) {
    const { tier, target, positions, rms_after } = p.recommended.tuned_with;
    p.recommended.tuned_with = { tier, target, positions, rms_after };
  }
  return { profile: p, left };
}

/**
 * The GitHub "new issue" link with the form filled in as far as fits.
 * @param {any} profile a shareable profile
 * @returns {{ url: string, json: string, inUrl: boolean }}
 */
export function shareLink(profile) {
  const json = JSON.stringify(profile, null, 2);
  const params = new URLSearchParams({
    template: 'profile.yml',
    title: `Profile: ${profile.name}`,
    board: profile.board?.name ?? profile.source?.dac ?? '',
  });
  const withJson = new URLSearchParams(params);
  withJson.set('profile', json);
  const full = `${REPO}/issues/new?${withJson}`;
  if (full.length <= URL_LIMIT) return { url: full, json, inUrl: true };
  return { url: `${REPO}/issues/new?${params}`, json, inUrl: false };
}
