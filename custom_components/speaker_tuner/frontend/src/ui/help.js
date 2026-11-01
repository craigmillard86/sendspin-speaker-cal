// @ts-check
// Detailed help for each section and Tune step: what to do, why, and what you get. Opened
// from the "?" next to a section's or step's title, and from Help in the header.

/**
 * @typedef {{ title: string, step: string, intro: string, todo: string[], why: string, outcome: string, tips?: string[] }} HelpTopic
 */

/** @type {Record<string, HelpTopic>} */
export const HELP = {
  ready: {
    title: 'Ready to measure',
    step: 'Set up',
    intro: 'The checklist of everything the tool needs before it can measure: a connection to Home Assistant, the speaker, a microphone and the test noise.',
    todo: [
      'Work down the list. Each item that is not ticked has a button that opens the part that sorts it out.',
      'Use ‹ Back to the checklist to return here.',
      'When all four are ticked, press Next: Measure.',
    ],
    why: 'Measuring needs all four at once: the tool plays the noise through Home Assistant on the speaker and records it with the mic in this browser. Measure and Tune stay locked until the list is complete, so nothing fails half way.',
    outcome: 'Four ticks, and Measure and Tune unlocked.',
    tips: ['The microphone has to be opened again after every page reload: browsers do not keep mic access for a page between visits.'],
  },
  connect: {
    title: 'Connect',
    step: 'Set up',
    intro: 'Connects this page to Home Assistant. In the sidebar panel this is automatic; only the standalone page needs it.',
    todo: [
      'Enter your Home Assistant address, for example https://homeassistant.local:8123.',
      'Paste a long-lived access token: in Home Assistant open your profile, then Security, then Long-lived access tokens, then Create token.',
      'Press Connect. Or press Try the demo to explore with a simulated speaker.',
    ],
    why: 'Every measurement plays through Home Assistant, and every setting is written to the speaker through it. Nothing talks to the speaker directly.',
    outcome: 'A Connected status. The address and token are kept in this browser only.',
    tips: ['The token gives full access to your Home Assistant. Delete it from your profile when you no longer use the standalone page.'],
  },
  speaker: {
    title: 'Speaker',
    step: 'Set up',
    intro: 'Tells the tool what kind of speaker it is tuning, which Home Assistant entities control it, and where the test noise file lives.',
    todo: [
      'Press Discover devices and pick your ESPHome speaker. Its sub-devices (for example Tweeter, Mid, Crossover) are included.',
      'The tool says what board it recognises (for example a Sonocotta Louder-ESP32-S3) and picks the profile that fits it best; the profile list shows how many of each profile\'s settings the device has. Change the profile if it picked the wrong one.',
      'Open Entity roles and check the guesses: each role (such as Mid PEQ 3 Gain or Mute tweeter) should point at the matching entity. Leave a role as not used if the speaker does not have it; features that need it hide themselves.',
      'Media player: pick the player that plays files. On Louder boards with Sendspin that is the … Player, not the … Sendspin Player.',
      'Optional: press Upload ESPHome YAML and pick the speaker\'s YAML file. The tool builds a profile with exactly the settings it exposes, takes its crossover: values as recommended settings, and makes Save export that same file with the tuned values in it. Passwords and keys are replaced by !secret references and never stored.',
      'Give it a name and press Save speaker.',
      'Under Test noise, press Upload to Home Assistant, then Play 3 s to check you hear it.',
    ],
    why: 'The profile knows the speaker\'s DSP (how many PEQ bands per driver, the crossover, the sample rate) and how to write the ESPHome YAML. The roles connect that knowledge to your entities, so the tool can read and write every setting.',
    outcome: 'A saved speaker with every role it needs mapped, and a pink noise file in Home Assistant\'s media folder (/media/speaker-tuner/).',
    tips: [
      'Entity roles shows what discovery found ("Found 87 entities…"). If a kind of entity is missing, it is not exposed in the device YAML.',
      'You can set up several speakers; switch between them from the name at the top.',
      'Recognition is "certain" when the firmware names its board (Sonocotta\'s factory firmware does, through ESPHome\'s project: setting) and "looks like" when it comes from the DAC\'s entities and the ESP32 chip. Adding project: to your YAML makes it certain.',
      'HiFi, Loud and Amped boards have no DSP the tool can adjust: they can be measured, not tuned.',
    ],
  },
  mic: {
    title: 'Mic and target',
    step: 'Set up',
    intro: 'Chooses the microphone, its calibration, and the response you are aiming for.',
    todo: [
      'Pick the microphone input and press Use microphone. Allow microphone access when the browser asks.',
      'Pick the mic profile that matches it (for example miniDSP UMIK-1). For a measurement mic, load its calibration file.',
      'Pick a target curve. Gentle tilt (−1 dB per octave above 1 kHz) sounds natural in most rooms; Flat is for nearfield or studio work.',
    ],
    why: 'The mic profile sets how far the tool trusts the measurement. A calibrated measurement mic allows corrections from 60 Hz to 16 kHz with boosts up to +6 dB. An unknown mic is held to 300 Hz – 8 kHz, cuts only, because its own response would be corrected into the speaker.',
    outcome: 'A live level meter in the activity bar while measuring, and the tier (calibrated, uncalibrated or unknown) that sets the fit rules.',
    tips: [
      'If the meter shows "digital silence", the browser gets zeros from that input. Try another browser (Edge works where Chrome does not with some Realtek arrays), or another input.',
      'Echo cancellation, noise suppression and auto gain are switched off: they would change the measurement.',
    ],
  },
  measure: {
    title: 'Measure',
    step: 'Measure',
    intro: 'Plays pink noise through the speaker, records it with the mic and turns it into a frequency response on the chart.',
    todo: [
      'Put the mic where you listen, at ear height, pointing at the speaker (or straight up, if its calibration is for 90°).',
      'Press Set level once. The tool raises the volume step by step until the mic hears about −30 dBFS, never above 60%.',
      'Pick Whole speaker and 3 positions, then press Measure. Between positions, move the mic about 30 cm (left, right, up) when asked.',
      'Keep the room quiet while it records.',
    ],
    why: 'One mic position mostly measures the room: reflections make sharp peaks and dips that move when you move. Averaging a few positions keeps what the speaker does and averages out what the room does, so the fit corrects the speaker, not one spot in the room. Pink noise has equal energy per octave, so every part of the range is measured evenly.',
    outcome: 'A curve on the chart, shown next to the baseline (the first measurement of the session), and saved in this browser. Hatched areas on the chart are low-confidence (too close to the background noise, or the positions disagreed) and are ignored by the fit.',
    tips: [
      'Tweeter alone and Mid alone (needs the mute roles) measure one driver with the other muted. Driver levels does this for you.',
      'Every measurement this session uses the same volume, so curves compare directly. Use Set level again only if the mic or its gain changed.',
      'The legend above the chart is the switch: tap a measurement to show or hide it; Ctrl/⌘-click or hold one to show only that one.',
      'CSV and REW import/export are here for working with other tools.',
    ],
  },
  tune: {
    title: 'Tune',
    step: 'Tune',
    intro: 'A sequence of steps that each measure one thing, suggest values, and write them only when you press Apply.',
    todo: [
      'If the profile has recommended settings (from your YAML, or saved after tuning a speaker of the same build), Recommended settings at the top lists what differs; Apply them first as a starting point.',
      'Work down the list in order: the low end, then how the two drivers join (levels, polarity, crossover, timing), then broad shaping (baffle, air), and the PEQ fit last.',
      'Open a step, read what it needs, press Run. Check the suggestion against Now, then press Apply, or move on without applying.',
      'Use Next step to go on. Steps can be run again in any order.',
    ],
    why: 'The order matters: each step assumes the ones before it are right. The PEQ fit comes last because it corrects whatever is left, and would otherwise be undone by later changes.',
    outcome: 'A speaker whose drivers join cleanly and whose response follows the target. Every value is saved on the speaker; the session start is kept so you can revert.',
    tips: [
      'Tests put back what they changed. Nothing on the speaker changes until you press Apply.',
      'Revert to session start puts every setting back to how it was when this session began.',
      'Wait a minute after the last change before power-cycling the speaker: ESPHome saves settings about once a minute.',
    ],
  },
  lowEnd: {
    title: 'Low end (nearfield)',
    step: 'Tune',
    intro: 'Measures the bass driver up close to find the enclosure\'s tuning, and suggests a subsonic filter that protects the driver below it.',
    todo: [
      'Hold or stand the mic 1 cm from the centre of the mid/bass cone (dust cap), not touching it.',
      'Press Run. The PEQ and other filters are switched off for the test and put back afterwards.',
      'Check the suggested subsonic frequency, then Apply.',
    ],
    why: 'With passive radiators or a port, the cone barely moves at the tuning frequency: the radiators do the work, so the nearfield response shows a dip there. Below that frequency the cone is barely held back and its excursion climbs fast, so filtering it out stops distortion and protects the driver at volume. For a sealed box the step fits the box\'s resonance and Q instead, for a Linkwitz transform.',
    outcome: 'The tuning frequency (fb) or box resonance, a suggested subsonic filter just below it, and a bass floor for the PEQ fit: it will not boost below 1.3 × fb.',
    tips: ['If the dip isn\'t clear (a noisy room, or the mic too far away), the step says so; move closer and run it again.'],
  },
  level: {
    title: 'Driver levels',
    step: 'Tune',
    intro: 'Measures each driver alone and evens out their levels where they meet.',
    todo: ['Keep the mic at the listening position.', 'Press Run. Each driver is muted in turn while the other plays.', 'Apply the suggested gain cut.'],
    why: 'Tweeters are usually more sensitive than mid/bass drivers. If one driver is louder, the speaker sounds bright or dull, and the crossover sums wrongly. The louder driver is cut, never boosted, so there is no loss of headroom.',
    outcome: 'A gain cut on the louder driver so both are level around the crossover, plus tweeter-alone and mid-alone measurements that later steps use.',
  },
  polarity: {
    title: 'Polarity',
    step: 'Tune',
    intro: 'Checks the two drivers add up at the crossover rather than cancel.',
    todo: ['Press Run. If the whole speaker has a dip of more than 3 dB at the crossover, the tool tries the tweeter inverted and keeps whichever is flatter.', 'Apply if it suggests inverting.'],
    why: 'Crossover filters shift the phase of each driver. With some filter types (for example Linkwitz-Riley 2nd order) or wiring, the drivers arrive out of phase at the crossover and cancel, leaving a hole there. Flipping one driver fixes it.',
    outcome: 'The tweeter polarity that sums best, or Nothing to change.',
  },
  crossover: {
    title: 'Crossover point',
    step: 'Tune',
    intro: 'Tries several crossover frequencies (and, optionally, filter types) and keeps the one with the flattest sum.',
    todo: [
      'Enter the frequencies to try, for example 1800, 2000, 2200, 2500, 2800. The current one is always included.',
      'Tick Also try each filter type to compare LR2, LR4 and the Butterworth types too (takes longer).',
      'Press Run, compare the curves on the chart (each point stays on it; tap them in the legend, or use Show in the results, to compare), then Apply.',
    ],
    why: 'Too low, and the tweeter is pushed into its resonance and distorts. Too high, and the mid/bass beams and sounds narrow. The best point joins the drivers smoothly. A change is only suggested if it is clearly flatter than now, not on measurement noise.',
    outcome: 'A table of each point\'s spread over ±1 octave around the crossover and the depth of any dip, and the suggested crossover.',
    tips: ['Frequencies below the tweeter\'s minimum (tweeter_min_frequency in the device YAML) are skipped to protect the tweeter.'],
  },
  delay: {
    title: 'Time alignment',
    step: 'Tune',
    intro: 'Finds the delay that lines up the two drivers in time.',
    todo: ['Press Run. It takes a few minutes: about 30 short measurements.', 'Apply the suggested delay.'],
    why: 'The tweeter usually sits further forward than the mid/bass\'s acoustic centre, so its sound arrives first. With the tweeter flipped for the test, the two cancel at the crossover, and the cancellation is deepest when they are perfectly aligned. The scan finds that deepest null, then measures once the normal way to check the real sum is no worse.',
    outcome: 'A delay in mm on one driver (+ delays the tweeter, − the mid), and a smoother join through the crossover.',
    tips: ['The fork\'s delay is an all-pass approximation, so the best value can differ from the physical offset between the drivers.'],
  },
  baffle: {
    title: 'Baffle step',
    step: 'Tune',
    intro: 'Compensates the bass the cabinet loses because of its front panel width.',
    todo: ['Enter the width of the front of the cabinet in cm and press Use this width, or press Run to estimate it from a measurement.', 'Check Baffle placement in All settings: freestanding, near a wall, or in a corner.', 'Apply the suggestion.'],
    why: 'Above a frequency set by the baffle width, sound only radiates forwards; below it, it spreads all round, so the speaker sounds about 6 dB quieter in the bass in open space. A wall or corner gives some or all of that back, so the compensation depends on placement: +6 dB freestanding, +3 dB near a wall, none in a corner.',
    outcome: 'A baffle step shelf that restores the balance between bass and treble.',
  },
  notch: {
    title: 'Tweeter breakup and air',
    step: 'Tune',
    intro: 'Tames a tweeter\'s top-end resonance and sets the overall level of the top octave.',
    todo: ['Run Driver levels first: this step uses its tweeter-alone and whole-speaker measurements.', 'Press Run, then Apply.'],
    why: 'Dome tweeters often have a sharp breakup peak above 10 kHz that sounds harsh. A narrow notch removes it. The air shelf then sets the top octave relative to the target. Both need an accurate mic up there, so the step only runs with a calibrated mic.',
    outcome: 'A notch at the breakup frequency (if there is one) and an air shelf gain.',
  },
  peq: {
    title: 'PEQ fit',
    step: 'Tune',
    intro: 'Fits parametric EQ bands on each driver to bring the response close to the target, writes them, measures again and refines.',
    todo: [
      'Measure the whole speaker with 3 positions after the other steps (Measure, or the latest pass).',
      'Pick that measurement and press Fit. Read What it found and What it will set; the dotted line on the chart is the predicted result.',
      'Press Apply and measure again. It writes the bands, measures the same way, and repeats up to 3 times while it keeps improving.',
    ],
    why: 'Even a well-designed speaker has peaks and dips from the drivers and cabinet. The fit finds the biggest deviation from the target, picks the width and gain that best removes it, and repeats until nothing over 1 dB is left or the bands run out (6 per driver). It cuts more readily than it boosts (−12 vs +6 dB), never boosts below the bass floor, and leaves narrow dips alone: those are room cancellations that boosting cannot fill and that move as you move.',
    outcome: 'What it found (each peak or dip, and what it left alone), the bands it set read back from the speaker, and the deviation from the target before and after each pass. A pass that makes things worse is undone automatically.',
    tips: [
      'Measuring before and after with the same method matters: the tool repeats the baseline\'s number of positions.',
      'If the speaker warns of clipping after a big boost, turn on headroom compensation.',
    ],
  },
  ab: {
    title: 'Listen: A/B',
    step: 'Tune',
    intro: 'Switches the speaker between how it was at the session start (A) and the tuning (B), so you can listen to the difference.',
    todo: ['Play your own music on the speaker.', 'Switch between A and B. Leave Level match on.'],
    why: 'A louder version always sounds better at first. Level match turns the louder one down by the measured difference, so you compare the tuning, not the volume.',
    outcome: 'Your own judgement. Leave it on B to keep the tuning; A is only for listening.',
  },
  copy: {
    title: 'Copy to another speaker',
    step: 'Tune',
    intro: 'Copies every setting to a second speaker of the same build, then measures it once to check.',
    todo: ['Pick the other speaker (set up with the same profile).', 'Put the mic in the same place relative to it.', 'Press Copy settings. It then asks you to measure the other speaker once.'],
    why: 'Two cabinets of the same build are close enough to share a tuning, which saves running every step twice. The check measurement catches a driver or wiring difference.',
    outcome: 'The second speaker with the same settings. If its response differs by more than 1.5 dB, the tool suggests tuning it separately.',
  },
  export: {
    title: 'Export',
    step: 'Save',
    intro: 'Writes the tuning into the speaker\'s ESPHome YAML, and saves files for other tools.',
    todo: [
      'Download or Copy the YAML and paste its substitutions and crossover block into your device YAML.',
      'Flash the speaker with ESPHome.',
      'Optional: after flashing, press Reset speaker to YAML to check the speaker comes back to the same values.',
      'Press Save as recommended for this build to keep the tuned values in the profile: the next speaker of the same build is offered them in Tune.',
    ],
    why: 'The values are already saved on the speaker and survive a restart. But a reflash, a reset or a new board starts from the YAML; putting the tuning there makes it the speaker\'s defaults, and keeps it with your configuration.',
    outcome: 'A YAML file with every setting in ESPHome\'s units (your whole file, ready to flash, if the profile was built from your YAML), a REW filter file, and a tuning report (HTML) with before and after charts and every changed setting.',
  },
};

/** Section keys that differ from their help topic. */
export const HELP_ALIAS = { 'mic-and-target': 'mic' };

/** Order of the topics in the Help index, grouped by step. */
export const HELP_ORDER = ['ready', 'connect', 'speaker', 'mic', 'measure', 'tune', 'lowEnd', 'level', 'polarity', 'crossover', 'delay', 'baffle', 'notch', 'peq', 'ab', 'copy', 'export'];
