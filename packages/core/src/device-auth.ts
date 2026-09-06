/**
 * Interactive credential acquisition, for a provider that supports it.
 *
 * Onboarding otherwise means reading a list of permissions, creating a token by hand, ticking the
 * right boxes and pasting it — every step a place to get it wrong. Two shapes of flow fit this one
 * contract: the OAuth *device* flow (GitHub), where the user types a short code into a page the
 * provider hosts, and the *authorization-code* flow with a local callback (Linear, with PKCE), where
 * the user only approves in the browser and the provider redirects back to a listener on
 * localhost. The caller shows what it is given and waits; which of the two happened is the
 * adapter's business.
 */

/** What the user has to be shown to complete the flow, and how long they have to do it. */
export interface DeviceCodePrompt {
  /**
   * The short code the user types into the browser. Absent for a callback flow, where there is
   * nothing to type — opening the page and approving is the whole step.
   */
  readonly userCode?: string | undefined;
  /** Where to go: the provider's device page, or the authorization URL itself. */
  readonly verificationUri: string;
  /**
   * The same page with the code already in the query string, when the provider offers one. Always
   * present it alongside `verificationUri` rather than instead of it: it is optional in the spec, it
   * is the wrong thing to read aloud or copy into another machine, and a browser that opens it still
   * asks the user to confirm the code shown on screen matches.
   */
  readonly verificationUriComplete?: string | undefined;
  readonly expiresInSeconds: number;
}

export interface DeviceAuth {
  /**
   * Run the whole flow: hand what the user must see to `onPrompt`, wait for their approval, and
   * return the token. Rejects with an actionable BaronError on denial or expiry — never returns an
   * empty string.
   */
  authorize(onPrompt: (prompt: DeviceCodePrompt) => void): Promise<string>;
}
