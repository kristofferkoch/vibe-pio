# Level curve — a didactics exploration (2026-09-04)

Session notes for the level track: what the programming-education
research says about the slope, a concept DAG derived from it, a
chapter/level sketch, and the open questions this leaves for the
grilling. **Chapters 0–1 were promoted to KANBAN C34–C37 by the
2026-09-04 grilling — the owner decisions made that day are recorded
on the cards and resolve five of the six open questions below.
Chapter 2 was promoted to KANBAN C39–C41 by the 2026-09-06 grilling
(decisions on the cards and recorded under the chapter 2 sketch
below); chapters 3+ remain pre-grilling input.** This file stays the
design spec for the promoted chapters the way DESIGN-NOTES is the
spec for the sandbox. The owner's starting instincts on the record:
first level = a very reduced view of the UI, few instructions, the
loop comes from wrap, `jmp` only later. The research leg, done
2026-09-04, backs all three — see the mapping below.

## What the research says, translated to this game

- **The notional machine is the first curriculum** (du Boulay et al.
  1989, "Some difficulties of learning to program"; Sorva 2013,
  "Notional machines and introductory programming education"). Novices'
  deepest failures are "onset problems" — no mental model of the
  machine executing their text; misconceptions are the model diverging
  from the machine. Translation: this game's structural advantage over
  any Python course is that the machine is *on screen* (CYCLE, the PC
  highlight, the wave). Chapter 0 teaches the machine, not the
  language — the first levels are a notional-machine lesson that
  happens to be playable.
- **Sequence → repetition → conditionals** (Rich, Strickland, Binkowski,
  Moran & Franklin, ICER 2017 — K-8 learning trajectories synthesized
  from 100+ studies). Loops are tractable before branches; conditionals
  are the late hurdle. Translation: wrap (a loop with *zero syntax*) →
  `jmp` unconditional (explicit loop control) → conditional `jmp`. The
  owner's ordering, confirmed. Human Resource Machine, the closest
  shipped analogue, does the same at coarser grain: its Year 2 makes
  JUMP the loop primitive before any arithmetic (Year 6) and before the
  first conditional (Year 7, JUMPZ). We can start gentler than HRM
  because wrap gives us a loop HRM does not have.
- **Worked example → completion → generation, faded** (Atkinson, Derry,
  Renkl & Wortham 2000; Renkl 2014; van Merriënboer's completion
  strategy). Novices learn more from studying worked solutions than
  open problem-solving, but only if scaffolding fades as skill grows.
  Translation: no level ever hands over a blank listing on a *new*
  concept — first a prefilled program to watch, then a one-cell
  modification, then authoring. The fade is also structural: predict
  tasks dominate early chapters, make tasks dominate late ones.
- **Parsons problems and subgoal labels** (Morrison, Margulieux &
  Guzdial, ICER 2015 — subgoal labels statistically improve Parsons
  performance; Margulieux, Guzdial & Morrison 2016 — subgoal-labeled
  worked examples halved CS1 withdrawal/failure; Haynes & Ericson, CHI
  2021 — faded Parsons problems are lower-load than writing from
  scratch). Translation: two level types fall out — *scrambled-row*
  levels (reorder given instructions to match a target wave; tests
  comprehension without generation) and *subgoal-annotated targets*:
  the monitor's protocol annotations (START/D0..D7/STOP) already ARE
  subgoal labels written on the wave. The level's goal text should name
  subgoals, not steps.
- **Predict before you run** (predict-observe-explain, White &
  Gunstone 1992; Sorva, Laakso & Kaila's program-visualization survey —
  the "responding" engagement level beats viewing; Nevalainen &
  Sajaniemi 2006). Committing a prediction before observing execution
  measurably improves engagement and learning. Translation: on levels
  presenting a program the player did not write, Run stays locked until
  a prediction is committed — pick the resulting waveform from
  candidates. Cheap to build (the wave renderer already exists), and it
  converts every "watch the demo" level into retrieval practice.
- **Cognitive load: intrinsic = concepts combined, extraneous =
  panels** (Sweller; split-attention and redundancy effects). A level
  that teaches delay does not need the FIFO panel on screen. Expertise
  reversal warns the same scaffolding *hurts* later — so reveals are
  monotone per chapter but the campaign ends at the full sandbox.
  Translation: **the level shell's UI state is the player's knowledge
  state** — panels unlock exactly when their concept does (gating table
  below).
- **Flow: under-challenge is the biggest flow-killer** (Csikszentmihalyi
  1990; Larche et al. 2020 — players felt *least* flow on easy games;
  Wilson et al. 2019, "The eighty five percent rule"). Translation:
  do not make early levels trivial — make them small but genuine
  (the predict gate keeps even a 2-row program uncertain), and give
  every level a stretch goal beyond passing: the par line and the
  next monitor profile up. Struggling players dial down via the
  profile ladder instead of skipping content.
- **Roles, not block diagrams** (Sajaniemi's roles of variables,
  2002). Registers teach better as roles-in-use: X/Y = the stepper
  (counter), ISR = the gatherer, OSR = the feeder. Translation: each
  register debuts in the level whose task *needs its role* — never as
  a labeled diagram up front. This also sequences the panels: ISR
  appears with reading, OSR with the feeder, X/Y with counting.

## The concept DAG

Prerequisites in parentheses. Each node = one level's worth of new
knowledge; a level may combine a new node with any subset of its
ancestors (interleaving is free here — timing is in every program).

```
cycle            the SM executes one word per tick; CYCLE, Step/Run/Reset
listing          rows are the program; PC highlight; address gutter
pin              a pin is a wire; the wave row remembers its history
wrap             (cycle, listing, pin) the free loop: PC falls off the
                 end and re-enters at the wrap target; the arc flashes
set-pins         (pin) drive a constant onto a pin: `set pins, n`
delay            (set-pins) `[n]` stretches the row; the ds column
jmp-always       (wrap, delay) explicit loop control; the cost lesson:
                 jmp eats a slot AND a cycle, wrap eats neither
in-push          (pin) reading: `in pins, n` gathers into ISR; `push`
                 hands the word to the RX FIFO; ISR panel debuts (gatherer)
jmp-pin          (jmp-always, in-push) the first conditional: react to
                 the world (the JMP_PIN wiring)
x-y              (jmp-always) scratch as stepper; `jmp x--` and the
                 fencepost: always decrements, tests the PRE-decrement
                 value (SPEC-3.1-4) — a designed off-by-one level
pull-out         (delay) the feeder: `pull` loads OSR, `out pins, n`
                 drives pins from it; TX feed + OSR panel debut; the
                 empty-FIFO stall as a designed investigate task
out-count        (pull-out) shift counts, LSB/MSB direction, OSRE —
                 the byte becomes visible on the wave
autopull         (pull-out) the machine does the pull; reward = slots
                 freed; drawn flow arrows debut
mov              (x-y, pull-out) plumbing between registers; the ~ and
                 :: operators stay late
sideset          (delay, out-count) a second action every cycle, free;
                 the ds allocator debuts — and garbles (SPEC-4-7)
wait             (jmp-pin) synchronization; clean sampling of a slow
                 external clock (the clocked-input example, CC-23)
irq-multi-sm     (wait) the second SM; handoff; the SM bar debuts
join-exec-clkdiv (everything) endgame: FIFO join, out pc/exec, the real
                 divider, DMA pacing (IDEAS: DMA at most late-game)
```

Ordering notes: this puts **wrap before jmp** (repetition before
explicit control transfer) and **conditional jmp after input** (Rich et
al.'s conditionals-last, plus each condition needs something to test —
`jmp pin` needs pins-as-input to be more than a magic bit). It defers
every concept whose teaching value does not survive the fun gate:
sideset after the player has felt the cost of separate cycles, mov
until two registers have met each other in a task.

## The chapter/level sketch

Task type per level uses the PRIMM verbs (Sentance & Waite 2017:
Predict, Run, Investigate, Modify, Make) — read before write, fading to
write. Monitor = the level's receiver profile (owner-decided:
conformance acceptance, never golden traces).

**Chapter 0 — First light** (the notional machine; no authoring at all)
- **L0 First light** [predict→run]. Prefilled 2-row program
  (`set pins,1` / `set pins,0`); UI shows: title bar with CYCLE,
  transport (Run/Step/Reset), the listing, one wave row (gpio0).
  Nothing else — no FIFOs, no ISR/OSR, no regs, no pin strip, no SM
  bar, no monitor, no config drawings. The predict question: "the PC
  has passed the last row — what happens next?" The wrap arc flashes
  the answer into the margin. Concepts: cycle, listing, pin, wrap.
- **L1 Metronome** [modify]. Same program; insert `[n]` delays to slow
  the blink to a target period. The delay column debuts. Monitor: a
  period/timing profile. One-cell modification — the fade's first rung.
- **L2 Author's hand** [make]. Write a 1:3 duty wave from scratch. Row
  editor completions scoped to the unlocked opcode set (the C31/C32
  slot-aware candidate machinery makes a level opcode whitelist nearly
  free).

**Chapter 1 — Time and loops**
- **L3 Two ways to loop** [make + the aha]. A task wrap cannot do:
  run a preamble once, then loop a *different* region — `jmp` debuts
  with a job, not as syntax. Then the cost lesson: the same wave from
  L2 is one cycle faster with wrap alone; the par line (cycles) makes
  the player *discover* that wrap is free and jmp is not. This is the
  game's first genuinely PIO-native insight.
- **L4 Scrambler** [Parsons]. Rows shuffled; reorder to match the wave.
  Comprehension rung for jmp+delay; zero generation load.
- **L5 The long blink** [make, stretch]. `[31]` ceiling; first brush
  with the 5-bit ds budget (all 5 bits are delay until sideset exists —
  the allocator itself stays hidden).

**Chapter 2 — Reading the world**
- **L6 Listen** [predict→run]. Prefilled `in pins,1` / `push`; the ISR
  panel and RX FIFO debut (green data leg). Predict: ISR contents after
  three ins.
- **L7 Echo** [make]. `jmp pin` debuts — the wave becomes a reaction to
  stimulus. The monitor flips to receiver conformance: decoded bytes,
  the SPEC-16-9 machinery, first contact with acceptance-by-decode.
- **L8 Fencepost** [make, designed off-by-one]. `set x` + `jmp x--` to
  gather exactly N bits. The profile is tuned so the classic
  pre/post-decrement error (SPEC-3.1-4) produces a *legible* near-miss
  (one bit too many/few visible on the decoded value), not a mystery
  red. Misconception inoculation by design.

**Chapter 2 grilling (2026-09-06, promoted as C39–C41):** the stimulus
draws on the wave — one row per driven pin above the lens row, shared
px/clk; the pattern panel stays absent. L6 passes by RX judge (the
pushed words decode to the driven bits; no tier ladder on a value).
L7 is the gated echo (data + enable; `jmp pin` load-bearing, the
unconditional copy reds at the freeze). The monitor flips at L7
(decoded bytes over the output wave, SPEC-16-9 skew-window tiers).
Par keeps honest axes on readers (words × echo latency; words ×
clks/bit). Full perturbation sets per level. The fun gate read clean
on chapters 0–1 (no riders). The breather defers — first candidate
after ch3's L12, revisited at the ch3 grilling.

**Chapter 3 — The feeder**
- **L9 Words** [predict→run]. Prefilled `pull` / `out pins,1`; the TX
  feed and OSR panel debut. The stall is the lesson: run the feed dry,
  watch the pull go red, an investigate prompt asks why. Red as
  curriculum, not accident.
- **L10 Eight bits** [make]. Out-count and shifting; serialize a word
  LSB-first; the monitor decodes bytes — START/D0.. annotations land as
  subgoal labels on the wave.
- **L11 Autopull** [make]. Same wave as L9, now with autopull — the
  reward is slots freed (the words counter drops) and a loop shed. The
  drawn flow arrows debut (config as structure).
- **L12 The demo, earned** [make]. Chapter boss: re-derive the
  sandbox's own UART TX demo (`side-set` start/stop bits + `out` +
  `jmp x--`… minus the sideset, which chapter 4 has not taught — its
  slot plays the delay game instead). The campaign's poster child is a
  level, and the player exits the chapter able to *read* the demo they
  could already load.

**Chapter 4 — Two things at once** — `sideset` debuts (free second
action per cycle), the ds allocator appears and garbles (SPEC-4-7
side-beats-out made visible), and L12 is re-solved properly with
side-set: the same wave, fewer cycles, par tightens. A re-solve level
is deliberate: fading in reverse — applying a new concept to a known
solution is the cheapest transfer task (Renkl's faded examples again).

**Chapter 5 — Synchronization** — `wait` debuts (clean sampling of a
slow external clock — the repo's clocked-input example is a level
waiting to happen); then `irq` and the second SM (the SM bar debuts;
the C22–C24 multi-SM machinery shrunk to a level).

**Endgame** — FIFO join, `out pc`/`out exec`, the real clkdiv, DMA as
fixed-function pacing. Explicitly the last 10%: IDEAS already pins DMA
as "at most late-game", and clkdiv-abstraction answers the open
1-tick-1-cycle question for levels: abstract early chapters, real
divider only when a task needs it.

**Between chapters** — breather levels in the Coffee Time idiom (HRM's
Year 5): no monitor, no profile, "draw something on the strip" — free
play with everything unlocked so far. Pacing valve and effect
playground in one; also where the sandbox gets advertised.

## UI gating = knowledge state

| after level | newly visible |
|---|---|
| L0 | CYCLE, transport, listing, one wave row |
| L1 | delay column (side column still hidden) |
| L6 | ISR panel, RX FIFO |
| L9 | OSR panel, TX feed |
| L11 | drawn flow arrows / autopull threshold |
| L12 | words/free budget as a *score*, not just a counter |
| ch.4 | ds allocator pips, side column |
| ch.5 | SM bar, per-SM identity colors |

The sandbox keeps everything always — the contrast is the motivator
(the campaign *is* the unlock sequence of the sandbox). The row
editor's completion tables scope to unlocked ops; the C32
candidates-match-the-slot work means a whitelist is a filter, not new
machinery. Listings keep all 32 rows in every level (owner decision,
2026-09-04 grilling — the machine is honest from cycle one, `·` rows
dim; row-count honesty resolved). Config drawings unlock
with the concepts they wire: set-base/count pinned invisibly until the
pin strip debuts, wrap steppers only when a level asks for a non-default
wrap, thresholds at autopull time.

## The fun layer

- **Pass = receiver conformance** (owner-decided) — and the monitor
  shows partial decode, so failure is a *near-miss*, visibly one bit
  from passing. Near-miss feedback is the one-more-try engine.
- **Par = the Pareto front** (cycles × words) from the hyperoptimizer —
  the natural par line, per level, already owner-noted as the score
  fit. Hidden until first solve (expertise reversal: par pressure on a
  novice is extraneous load), then the mastery hook and the self-chosen
  style axis (small-program people vs fast-program people — autonomy).
- **Profile ladder** = within-level difficulty tiers (relaxed → exact →
  strict tolerances over one receiver skeleton, per the IDEAS entry).
  This is the 85% dial: struggling players re-run one tier down;
  strong players never see a ceiling until endgame.
- **The predict gate** only on programs the player did not author —
  never punish re-runs of your own work.
- **Failure must be legible**: the first-divergence marker on the
  decoded stream, the red stall with its cause in the tooltip, the wrap
  arc flash. Feedback specificity is a learning effect, not just
  politeness.

## Deliberately deferred (and why)

putget/join (RP2350-only aux modes — the model has open questions about
them anyway), `out pc`/`out exec`, irq index modes, `mov`'s `~`/`::`,
FIFO-depth pressure, real clkdiv, DMA. Nothing here reaches the first
three chapters; the fun gate can cut deeper.

## Open questions for the grilling

- How few rows is honest? — **Resolved 2026-09-04: all 32 rows,
  always** (the machine is honest from cycle one; the budget becomes
  curriculum the first time a solution does not fit, not by reveal
  mechanics).
- Does the predict gate survive replay? — **Resolved 2026-09-04:
  first run of a non-authored program only.**
- Par visibility — **Resolved 2026-09-04: after first solve** (dimmed
  but present once passed).
- Level shell dressing — **Resolved 2026-09-04: inherit the era skin
  verbatim + a level band** (name, goal, monitor/profile status, pass
  state) as a group frame under the toolbar.
- Chapter 2 before 3 or swapped — **Resolved 2026-09-04:
  output-first stands** (chapters 0–1 output-only; reading second,
  feeder third).
- Does L12's "re-solve with sideset in ch.4" pattern generalize
  (re-solve levels as a standing chapter-capstone type)? — **Still
  open**, with the chapter 3+ grilling.
