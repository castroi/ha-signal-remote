import { describe, it, expect } from 'vitest';
import { KillSwitch } from './kill-switch.js';

describe('KillSwitch (design §5, go-live gate 5)', () => {
  it('starts disengaged and allows commands', () => {
    const ks = new KillSwitch();
    expect(ks.engaged()).toBe(false);
    expect(ks.blocksCommands()).toBe(false);
  });

  it('hard kill blocks all new commands (guaranteed)', () => {
    const ks = new KillSwitch();
    ks.engage();
    expect(ks.engaged()).toBe(true);
    expect(ks.blocksCommands()).toBe(true);
  });

  it('engaging returns the in-flight cover entities to stop (best-effort)', () => {
    const ks = new KillSwitch();
    const toStop = ks.engage(['cover.living_room', 'cover.kitchen']);
    expect(toStop).toEqual(['cover.living_room', 'cover.kitchen']);
  });

  it('can be released, re-allowing commands', () => {
    const ks = new KillSwitch();
    ks.engage();
    ks.release();
    expect(ks.engaged()).toBe(false);
    expect(ks.blocksCommands()).toBe(false);
  });

  it('the local flag is authoritative regardless of any HA mirror', () => {
    const ks = new KillSwitch();
    ks.engage();
    // an HA mirror reporting "off" must not override the local authoritative flag
    ks.syncHaMirror(false);
    expect(ks.engaged()).toBe(true);
  });

  it('status and help are never blocked by the kill switch', () => {
    const ks = new KillSwitch();
    ks.engage();
    expect(ks.allowsStatusAndHelp()).toBe(true);
  });
});
