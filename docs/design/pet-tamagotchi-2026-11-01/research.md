# Research: Tamagotchi-style presentation without gamification

Status: proposal input for `brief.md`. Dated 2026-11-01. Web sources were read as
secondary material; nothing here changes product truth in NIAR-243/246.

## 1. What makes the Tamagotchi presentation work

The original 1996 Bandai Tamagotchi is an egg-shaped shell around a 32×32 px LCD,
three physical buttons (A select, B confirm, C cancel) and a fixed **icon row**
drawn around the screen. The pet lives on the single screen; every function is
an icon in the row: feed, light, game, medicine, bathroom, health meter,
discipline, attention ([tamagotchi.com guide][t1], [Recalbox emulator notes][t2],
[Tamagotchi manual][t3]).

What carries the feeling, in order of importance:

1. **A device, not a page.** The shell frames one small screen. Everything the
   user can do is visible at once on its rim. Nothing scrolls; the screen changes.
2. **The creature is always on screen.** Status, menus and reactions happen
   *around* or *on top of* the pet; the pet never leaves.
3. **Icon row = the whole command set.** Highlight-then-confirm navigation, no
   labels. Later devices (Pix 2021, Uni 2023) kept the row and added a colour
   screen and touch, and reviewers still describe the menu as "easy to get
   around" ([MobileSyrup Pix hands-on][t4], [Inverse Pix vs On][t5]).
4. **One status screen.** The "health meter" icon opens age/weight, discipline,
   hunger, happiness as plain readouts ([tamagotchi.com guide][t1]). The
   readout is the thing we can borrow: a small screen that answers "what does
   it know / need" in numbers.
5. **Idle animation + small signs.** The pet wanders, sleeps with the light off,
   shows a skull when sick, a highlighted attention icon when it wants something.
   Signs are few and legible at 32 px.
6. **Care metaphors** (feed, clean, medicine) are the gamification layer. They
   are what the owner explicitly does *not* want. The *frame* (shell, screen,
   icon row, readout, sleep/light) survives without them.

## 2. How modern companion apps handle it

| App | Borrow | Leave |
| --- | --- | --- |
| **Finch** (self-care bird) | Pet front and centre on its own "room"; a bottom row of a few big icon tabs; the bird reacts to taps; gentle tone, missing a day is "a pause", the bird is still glad to see you ([Make Headway review][f1], [IU wellness blog][f2], [Comic Watch interview][f3]). | Energy/streak currency, outfits, daily quests. Even Finch's streak can reset and users complain ([Appbot review analysis][f4]). |
| **Pou** | One creature, rooms switched by two corner icons, zero text ([Pou listing][p1], [Tamadog/Livly screens][p2]). | Hunger/health/energy bars, coins, minigames. |
| **Tamagotchi Pix / Uni** | Colour screen inside a physical shell, icon menu, pet keeps living on screen, screen sleeps when idle ([MobileSyrup][t4], [Alibaba comparison][t6]). | Meters, feeding, trading. |
| **Duolingo widget / Duo** | Home-screen widget with a reacting mascot proves a *tiny* pet frame is enough. | Escalating guilt notifications, sad/"dead" icons; widely called a dark pattern ([Design Buddy][d1], [University XP][d2], [JTBD case study][d3]). Nothing in Niaro's pet may become sadder because the user stayed away. |
| **StepDog (Apple Watch)** | Pet in a watch-face complication; it rests after the day's goal ([BGR face apps][a1]). watchOS itself has no pet face, only Photos faces with pets ([iDropNews][a2]). | Step goal as the pet's mood driver. |
| **Desktop/terminal pets** (ChatGPT desktop pets, Mocha Casa, Code-IQ "buddy") | React to app events through a small event→reaction mapping; never interrupt the primary task ([OpenAI community proposal][c1], [Mocha Casa][c2], [design history][c3]). | Random moods that pretend to be state. |
| **Maslo / Mira companion** | "Every movement is an emotion"; time-of-day awareness makes the companion feel present ([Maslo best practices][c4], [Mira case study][c5]). Niaro already has day/evening/night and weather mood. | Companion "memories" that change its look beyond what the data says. |

## 3. What to borrow for Niaro (no gamification)

- **Shell + screen + icon row** as the page's visual grammar. The screen holds
  the existing `PetView`, name and one honest status line. The rim holds the six
  profile sections and the three "device buttons" (saved, about you, appearance).
- **Status screen = counts.** The Tamagotchi readout becomes "what Niaro knows":
  number of observations per section, last-learned time, nothing else. No bar
  that can go down "because you neglected it".
- **Light switch = memory switch.** Tamagotchi's light off puts the pet to sleep
  ([tamagotchi.com guide][t1]). Niaro's existing `resting` state already maps
  to memory off/unavailable. This is the only mood driven by a setting, and it
  is true: with memory off Niaro really does stop learning.
- **Attention icon → honest exception badge only.** Use a badge only for an
  actual state (memory unavailable, save unconfirmed, conflict), never for
  "come back".
- **Reactions stay local.** Touch signs (hearts, sparkle, zz) remain as built;
  the page does not fire them on save or on open.
- **Cosiness, not care.** Project Horseshoe's cosy pillars are safety (no fear
  of loss), abundance (needs easy to meet) and softness (sensory signals of a
  low-stress place) ([80.lv summary][z1], [Kitfox: Designing for coziness][z2]).
  For a memory page: nothing can be lost by not visiting, nothing has to be
  "fed", and the shell is soft (rounded, dim screen, quiet motion).

## 4. What to avoid

- Fake meters: hunger, happiness, health, affection, growth bars. The existing
  spec's "growth stages" line stays on demand, never as a permanent meter
  (see previous round, `docs/design/web-pet-profile-2026-10-30/design.md`).
- Guilt loops: sad face after absence, "it missed you", streak counters,
  escalating reminders ([Design Buddy][d1], [Screenwise parent guide][d4]).
- Counting history rows as "memories" (previous round's warning).
- Mood that lies: the pet looks sick on a network error. Error is a text state
  inside the screen; the pet keeps its last honest state or the still fallback.
- Minigames, coins, outfits, rooms, "tap to feed".

## 5. Accessibility

- **Reduced motion.** WCAG 2.3.3 (AAA) asks that interaction-triggered motion
  can be disabled; `prefers-reduced-motion` is the sufficient technique
  ([W3C Understanding 2.3.3][w1], [Technique C39][w2]). WCAG 2.2.2 (A) covers
  the idle animation: moving content that starts automatically and runs longer
  than 5 s needs pause/stop/hide ([W3C Understanding 2.2.2][w3]). Niaro already
  has the per-user **Animate** switch and still-frame fallback; the brief keeps
  both and adds no new motion that is not also instant under reduced motion.
- **Screen readers.** The screen is a `group`/`region` named by the pet; status
  line is text, not colour; icon-row buttons carry names with counts ("Work,
  12 observations"); selected state via `aria-pressed`/`accessibilityState`;
  focus moves to the detail heading and back to the opener (both already built).
- **Large fonts.** At font scale 2 on 320 dp the icon row wraps to two rows of
  three, counts stay beside icons, the pet shrinks (existing `petSize/fontScale`
  rule). Apple HIG: honour Reduce Motion with crossfades and let Dynamic Type
  reflow rather than truncate ([HIG summary][h1]). No text inside the pet.
- **Contrast.** Screen surface uses the existing `--background` on `--card`;
  text stays `--foreground`/`--muted-foreground`, which already pass on dark.

## Sources

[t1]: https://tamagotchi.com/?p=5111 "Tamagotchi official care guide"
[t2]: https://wiki-next.recalbox.com/en/emulators/ports/tamagotchi "Recalbox Tamagotchi port (button roles)"
[t3]: https://manuals.plus/asin/B08XWNK5TF "Tamagotchi Original manual"
[t4]: https://mobilesyrup.com/2021/06/27/tamagotchi-pix-review-hands-on/ "MobileSyrup: Tamagotchi Pix hands-on"
[t5]: https://www.inverse.com/input/reviews/tamagotchi-pix-compared-to-tamagotchi-on-review "Inverse: Pix vs On"
[t6]: https://www.alibaba.com/product-insights/tamagotchi-uni-vs-pix-looking-back-at-which-virtual-pet-offered-more-fun.html "Uni vs Pix comparison (low authority)"
[f1]: https://makeheadway.com/blog/finch-app-review/ "Make Headway: Finch after 30 days"
[f2]: https://geneticslab.medicine.iu.edu/blogs/md-student-news/wellness-corner-a-digital-pet-is-your-self-care-best-friend "IU: a digital pet as self-care friend"
[f3]: https://comic-watch.com/news/comic-book-news/finch-the-self-care-mobile-teams-with-supergirl-ahead-of-movie-release "Comic Watch: Finch co-founder quotes"
[f4]: https://appbot.co/blog/finch-app-reviews-emotional-attachment-user-retention-product-loyalty/ "Appbot: Finch review analysis"
[p1]: https://apps.apple.com/app/575154654 "Pou on the App Store"
[p2]: https://screensdesign.com/apps/tamadog-puppy-pet-dog-games/ "screensdesign: Tamadog screens"
[d1]: https://designbuddy.substack.com/p/is-duolingo-unethical "Design Buddy: Is Duolingo unethical?"
[d2]: https://www.universityxp.com/news/2025/7/25/we-havent-seen-you-in-a-while-duolingos-passive-aggressive-strategy-for-keeping-users-hooked "University XP: Duolingo's passive-aggressive strategy"
[d3]: https://jtbdux-protocol.pages.dev/adoption-and-behavior/behavior-design-patterns/how-duolingo-engineered-50-million-daily-users-and-the-backlash-that-came-with-it "JTBD: Duolingo backlash case study"
[d4]: https://screenwiseapp.com/guides/managing-duolingo-streaks-when-gamification-becomes-stressful "Screenwise: when gamification becomes stressful"
[a1]: https://bgr.com/1947022/best-face-apps-apple-watch/ "BGR: Apple Watch face apps (StepDog)"
[a2]: https://idropnews.com/news/7-smaller-changes-coming-in-watchos-9/189681/4 "iDropNews: Portraits of your pets"
[c1]: https://community.openai.com/t/expand-chatgpt-pets-into-custom-interactive-desktop-companions/1395667 "OpenAI community: desktop companion reactions"
[c2]: https://peerlist.io/dailiminlj/project/mocha-casa-desktop-pets "Mocha Casa desktop pets"
[c3]: https://claude-buddy-checker.vercel.app/blog/from-tamagotchi-to-terminal-virtual-pet-design-history "From Tamagotchi to terminal: design history"
[c4]: https://medium.com/maslo/best-practices-for-building-companions-b2141bad4fae "Maslo: best practices for companions"
[c5]: https://contra.com/p/WookgLs7-design-and-animation-for-mira-wellness-app "Mira wellness app animation case"
[z1]: https://80.lv/articles/using-coziness-in-game-design "80.lv: Using coziness in game design (Project Horseshoe 2017)"
[z2]: https://medium.com/kitfox-games/designing-for-coziness-d33d2519a59e "Kitfox Games: Designing for coziness"
[w1]: https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions "W3C: Understanding SC 2.3.3"
[w2]: https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html "W3C: Technique C39 prefers-reduced-motion"
[w3]: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide "W3C: Understanding SC 2.2.2"
[h1]: https://developer.apple.com/design/human-interface-guidelines/motion "Apple HIG: Motion"
