/**
 * Kill switch — hard kill (design §5).
 *
 * The local bridge flag is authoritative; an optional HA `input_boolean` mirror
 * can engage it but can never override the local flag back off. Engaging blocks
 * all new commands (guaranteed) and returns the in-flight cover entities so the
 * caller can issue `cover.stop_cover` to each (best-effort). Status and help
 * replies remain available in safe mode.
 */
export class KillSwitch {
  private engagedFlag = false;

  engaged(): boolean {
    return this.engagedFlag;
  }

  /** Engage the hard kill. Returns the in-flight cover entities to stop. */
  engage(inFlightCoverEntities: readonly string[] = []): string[] {
    this.engagedFlag = true;
    return [...inFlightCoverEntities];
  }

  release(): void {
    this.engagedFlag = false;
  }

  /**
   * An HA mirror may *engage* the kill (true) but a false reading never releases
   * the local authoritative flag.
   */
  syncHaMirror(haEngaged: boolean): void {
    if (haEngaged) this.engagedFlag = true;
  }

  blocksCommands(): boolean {
    return this.engagedFlag;
  }

  allowsStatusAndHelp(): boolean {
    return true;
  }
}
