# Aprion Password Manager

Build a local password manager for Brave desktop. A website can have several saved accounts. Selecting one starts a switch in the current browser profile. The first release will target multiple accounts on the same HTTPS origin, including email-only and username-and-password forms.

## The toolbar popup

Use the compact menu in the first reference. Show the current website at the top. Give each account a row with an initial, a label such as Personal or Work, and the full email underneath. Reserve the blue highlight and labeled checkmark for a sign-in the site has confirmed. If Aprion only knows which account it filled last, label it “Last used.”

| Control | Behavior |
| --- | --- |
| Select an account | Start switching to that account in the current tab. Show progress in the popup when open. |
| Manage accounts | Open the full vault in a Brave tab with all saved accounts visible. |
| Add login account | Open a new entry for this website. Offer the most recent pending sign-in for this site, if one exists. Allow manual entry at any time after unlocking. |
| Lock vault | Hide account details and require the master password to use them again. The website controls its own signed-in session. |

When there are no entries, show the website and the Add login account action. When locked, show the unlock form before displaying names or emails.

## Switching from Personal to Work

1. On the current website, the user opens Aprion and selects Work. Keep only one switch in progress for this site and browser profile, even if another tab also has the site open.
2. If Personal is signed in, use the website’s own sign-out control. Wait until the signed-out state is confirmed. If already signed out, go straight to sign-in. Other tabs for the same site sharing the session may also be signed out.
3. At the matching sign-in page, fill the Work email. On a password-based site, fill the saved password when its field appears. The user reviews the form, submits it and completes any verification.
4. Mark Work as current only if the site confirms the identity. If the user cancels or signs in as someone else, show the observed state or “Last used.” Reopening the popup must reflect the actual stage of the switch.

Save the email and sign-in method for passwordless accounts. Let the provider handle its account chooser and let the user enter any verification code.

Discover sign-out and sign-in controls from the active page. Use the same logic for every origin. For a site with an unknown sign-out flow, remember the selected account briefly, prompt the user to sign out through the site, then offer to fill it on the matching login page. End a pending switch on timeout, vault lock or unexpected navigation. Leave unrelated browsing data intact.

## Saving at sign-in and sign-up

Enable save prompts by default on HTTPS pages where Brave grants access. Let the user disable prompts per site and place help beside the control. While the vault is unlocked, offer **Save account** for a new login and **Update password** when an existing account’s password changes. Show the site and username so the user can verify the destination. A second email on the same site creates a separate entry. [Extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

Hold a submitted login briefly in extension memory so the save prompt survives the website redirect. Save it to the encrypted vault only after confirmation. Discard the pending entry on dismissal, expiry or lock. Exclude one-time codes and passkey challenges. If the user missed the prompt, Add login account can recall the pending entry during that window.

## The full vault

Use the second reference for the desktop layout. Pair a charcoal background with navy panels, thin slate borders and bright blue primary actions. Reuse those colors and keyboard focus states in the popup.

- Place vault navigation on the left, searchable saved logins in the center and the selected account’s details on the right. On a narrow window, open details in place of the list with a Back action.
- Search by website, account label or email. Show each saved account as its own row so both logins for the same site remain visible together. Use real entry counts.
- In the detail panel, show the website, label, username, sign-in method and a masked password when applicable. Support reveal, copy, edit and delete. Require confirmation for deletion.

## Build order and release checks

| Stage | Deliverable | Check before moving on |
| --- | --- | --- |
| 1. Brave prototype | Load an unpacked Manifest V3 extension. Build both views with sample accounts. Verify sign-out and email sign-in across independent test websites. | Both references are recognizable, keyboard selection works, and the team can identify when a site has signed out. |
| 2. Local vault | Add master-password setup, an encrypted versioned vault, manual account management, explicit locking and inactivity locking. Use Web Crypto with a salted password-based key derivation function and authenticated encryption with a fresh nonce per write. | Two accounts for one website survive a browser restart. The vault starts locked. Persisted data and logs contain no readable credentials or unlock key. |
| 3. Save and fill | Connect the picker to the active tab and add automatic save and update prompts with a per-site off switch. Recheck the target tab, top-level HTTPS origin and matching form before filling. | Exercise sign-up, sign-in, multi-step sign-in, changed passwords, declined saves, a lookalike domain and a tab that navigates during a fill. |
| 4. Account switching | Implement and test the site-independent switching flow and the manual sign-out fallback. Keep the switch running if the popup closes. | Switch Personal → Work → Personal in Brave. Verify sign-out precedes filling, verification stays user-controlled, and an interrupted or failed login never receives the active checkmark. |
| 5. Browser support | Keep vault logic, account matching and UI shared. Isolate tab access, storage, permissions and background lifecycle behind a small browser-specific layer. | Release first for tested Brave desktop versions. Run the same flows in Chrome and Edge next, then adapt and test Firefox and Safari individually. |

Brave supports Chromium-compatible extensions, making Manifest V3 a practical first target. Use temporary active-tab access for user-triggered operations and request longer-lived site access when the user enables a feature that needs it. [Brave extension support](https://support.brave.app/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave) · [Active tab access](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
