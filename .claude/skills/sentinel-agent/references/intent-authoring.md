# Writing Tests and Intents (Agent Authoring Guide)

Rules and procedures for authoring Sentinel test code: brand-new specs, and filling the
`intent: 'TODO'` stubs `sentinel migrate` leaves behind. The intent is the healing
anchor — at Tier 2 it is the primary evidence an LLM uses to pick the right element, and
in escalations it is what a human reads to decide. Intent quality directly determines
healing quality.

## Autonomy policy

Write intents **directly into spec files** — the user reviews them like any code change
via git diff. Two exceptions that need a heads-up first:

- **Rewording an EXISTING intent.** Step identity derives from `action + intent text`, so
  rewording orphans that step's healing history and locator cache (one manual-fix or
  baseline cycle follows). Do it deliberately, state the consequence when proposing it,
  and never as a drive-by "improvement".
- **Changing assertions or test flow** while filling intents. Filling a TODO must not
  alter what the test verifies.

After writing intents, always finish the job: run the affected tests green once (the
baseline run that captures fingerprints), and summarize what was written.

## Intent quality rules

An intent is one sentence describing **what the element is for** and **where it is** —
written for a stranger who has the page open but has never seen the test.

1. **Function + location, not appearance.** "Submit button on the checkout payment form",
   never "the blue button". Colors, sizes, and styling die in redesigns; purpose doesn't.
2. **Never restate the selector.** The intent must survive the selector's death. If the
   locator is `#msg span`, the intent is "Order confirmation success message shown after
   purchase completes" — zero overlap with the CSS.
3. **Disambiguate repeats.** Pages repeat widgets (product cards, table rows, list
   items). Include the discriminating context: "on the first listed product", "in the
   header navigation", "inside the delete-confirmation modal", "for the admin user row".
4. **One intent = one element.** Never describe two things or a region.
5. **No test data.** Data goes in `value:`/`text:` arguments. "Email input in the
   checkout contact section" — not "fill email with john@example.com".
6. **Function over copy.** Don't anchor to exact marketing text that churns ("Get 20% off
   now!" button → "Primary promotional call-to-action button in the hero banner"). For
   `expectText`, the `text:` argument carries the exact-copy assertion; the intent
   describes the element's role.
7. **The litmus test:** could a colleague (or an LLM) with the page open point at exactly
   one element from the sentence alone? If not, add context until yes.

## Patterns by element type

| Element type          | Pattern                                              | Example                                                             |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Action button         | `<action> button <location>`                         | "Place order submit button at the bottom of the checkout form"      |
| Repeated-card button  | `<action> button on the <discriminator> <card type>` | "Add to cart button on the first product card (Aurora Desk Lamp)"   |
| Icon-only button      | `<purpose> icon button <location>`                   | "Close (X) icon button in the top-right corner of the signup modal" |
| Text input            | `<field name> input <location/form>`                 | "Email input field in the checkout contact section"                 |
| Select / checkbox     | `<choice being made> <control> <location>`           | "Country selector in the shipping address form"                     |
| Link                  | `Link to <destination/purpose> <location>`           | "Link to the returns policy in the page footer"                     |
| Status/message target | `<meaning> message shown <when>`                     | "Order confirmation success message shown after purchase completes" |
| Heading               | `<page/section> heading <when relevant>`             | "Dashboard page heading shown after successful login"               |

Duplicate intents inside one test are legal (Sentinel indexes repeat occurrences), but
distinct intents heal and report better — prefer adding the discriminator.

## Sourcing context for an intent

To learn what an element is actually for, in order of preference:

1. **The spec's flow** — the steps before and after reveal the journey ("this click
   follows filling the address form → it's the checkout submit").
2. **The locator itself** — `getByRole('button', { name: 'Sign in' })` carries role and
   accessible name; a bare CSS locator carries little (and is exactly why the intent
   matters).
3. **The live page** — when the app is runnable (demo: `pnpm demo:serve`), open/inspect
   it; nearby headings and container text supply the discriminator.
4. **Component source / templates** — labels, aria attributes, and testids in the app
   code.

Never guess blindly: an intent that misdescribes the element will heal to the wrong
element convincingly. If purpose cannot be established from the sources above, ask the
user rather than inventing.

## Procedure: filling `intent: 'TODO'` stubs after migrate

1. Enumerate: `grep -rn "intent: 'TODO'" <specs-dir>`.
2. Per stub: read the surrounding test (full flow), apply the sourcing order above, write
   the intent per the quality rules. Change nothing else on the line or in the step.
3. After a batch: run the suite (or affected files) green —
   `npx sentinel run [--grep <p>]` — to establish the healing baseline for the new step
   identities.
4. Report a summary table: file, locator, written intent — so review is one glance per
   row.

## Procedure: authoring a brand-new Sentinel test

1. Confirm the journey to test (steps + what to assert). If ambiguous, ask.
2. Import from the framework: `import { test, expect } from '@sentinel/core';` — the
   fixture signature is `async ({ page, s }) => { … }`.
3. Route every protected interaction through `s.*`: `s.goto`, `s.click`, `s.fill`,
   `s.expectVisible`, `s.expectText`. Group phases with `s.step('add items to cart', …)`.
   Interactions `s.*` cannot express (hover, drag, keyboard, uploads, iframes) stay plain
   Playwright — note in the summary that those steps are unprotected.
4. Prefer user-facing locators (`getByRole`, `getByLabel`, `getByTestId`) — they double
   as good Tier-0 fallback material.
5. End the test with at least one `s.expect*` assertion that captures the journey's
   success condition — that is what the golden rule protects.
6. Run it green once (baseline), confirm the steps recorded
   (`sentinel-query.mjs steps --all --test <substr>` or `sentinel report`), then present
   the diff.

## Anti-patterns (reject these in review, too)

- `intent: 'button'` / `intent: 'click this'` — vague; heals to anything.
- `intent: 'the #add-to-cart-1 button'` — selector echo; dies with the selector.
- `intent: 'blue CTA on the right'` — appearance/position styling; dies in redesign.
- `intent: 'fill email with test@example.com'` — data in the intent.
- Rewording existing intents wholesale during unrelated changes — orphans healing
  history (see autonomy policy).
- A `TODO` left in a merged PR — the step runs but has a worthless healing anchor.
