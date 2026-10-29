/**
 * The ranked refill stack behind the loop's rolling worker pool (issue #902).
 *
 * Before this, the loop ran in ROUNDS: it planned a whole batch of tickets,
 * dispatched every worker into that batch, and waited for every single one to
 * finish — including a slow ticket's review/rework cycle — before planning the
 * next round. A round that shipped a one-line fix next to a multi-file
 * refactor left the fast ticket's slot idling for over an hour behind its
 * slowest sibling, because nothing could refill until the whole round drained.
 *
 * `Dealer` replaces the round with a single ranked stack a worker draws the
 * next card from. When the stack runs dry it refills (once, however many
 * workers ask at the same instant — see the single-flight guard below), so a
 * worker whose ticket just shipped can be handed a fresh one immediately
 * instead of waiting on its siblings. Ranking and picking live behind the
 * `plan()` seam (`planDeterministic` in `lib/state/eligible-set.ts`); this
 * module only tracks what has been dealt, what is still in flight, and when to
 * ask for more.
 *
 * ## Every parked worker must wake, not just the last one to park
 *
 * When the stack is empty but siblings are still in flight, a worker parks
 * instead of exiting (only "empty AND nothing in flight" is drained). With
 * `maxConcurrent` workers this can park more than one at a time — e.g. three
 * workers hit a just-emptied stack together while a fourth ticket is still
 * building. A SINGLE waiter slot would let the second parked call overwrite
 * the first's resolver, so `done()` would wake only the most recently parked
 * worker and strand the rest forever (an Opus review of the first cut of this
 * module caught exactly that: two parked `next()` calls + one `done()` left
 * one of them hanging). `waiters` is a list for this reason — `done()` drains
 * and resolves ALL of them; each one re-enters its loop, re-checks the stack,
 * and re-parks if there is still nothing for it.
 */

/**
 * How many refills in a row may produce nothing but REFUSED cards before
 * `next()` stops asking for more on this pass.
 *
 * Without this the pool can spin: `validate` refuses every card, the stack
 * empties, `refillOnce()` re-plans the same ranked set, and every card is
 * refused again — a tight loop, forever, because no ticket is ever attempted
 * and the `--max-tickets` cap is therefore never reached. (While planning was
 * an LLM call it also burned real money on every turn of that loop; the
 * planner is code now, so the cost is CPU and a `gh` round-trip per refill —
 * the spin is the problem either way.) It is reachable whenever a per-card
 * gate refuses everything for a reason the PLAN could not see: a `gh` outage
 * making the deal-time `Blocked-by:` gate fail closed on every card
 * (`blockedByGate` in `main.mts`), or a card whose `type:` label changed while
 * it sat on the stack. One retry is
 * allowed because a single refusal can be stale-listing noise; two in a row
 * means the world is not going to change by asking again.
 */
const BARREN_REFILL_LIMIT = 2;

/** The minimal shape of a dealt unit of work — decoupled from main.mts's `PlanIssue`. */
export interface DealerCard {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
}

export interface DealerDeps<C extends DealerCard> {
  /**
   * Produce a fresh ranked stack. Called at most once at a time — see the
   * single-flight guard in `createDealer` — with the current in-flight set so
   * a ticket a sibling worker already claimed is not re-offered.
   */
  plan(ctx: {
    stackSize: number;
    deal: number;
    inFlight: readonly C[];
  }): Promise<readonly C[]>;
  /**
   * Re-check a card immediately before handing it to a worker — the stack can
   * go stale between a plan call and a pickup (another host claimed it, a
   * blocker reopened, its label changed). `false` drops the card and tries the
   * next one; a THROW is treated as valid (fail-open — the lease-acquire step
   * right after pickup is the real gate, so a flaky validate check must never
   * stall the whole pool).
   */
  validate?(card: C): Promise<boolean>;
  /**
   * How many jobs are queued or running on the merge lane right now (see
   * `SerialQueue.pending()` in `serial-queue.ts`). Consulted only when the
   * stack is empty AND nothing is in flight — before concluding the queue is
   * genuinely drained, a pending merge might be the very thing that flips a
   * `Blocked-by:` dependent's blocker label to `shipped-local` and makes it
   * plannable. Optional: omitted in tests/deployments with no merge lane.
   */
  pendingMerges?(): number;
  /**
   * Waits for every job currently on the merge lane to settle (see
   * `SerialQueue.drain()`). Called once, only when `pendingMerges()` was
   * non-zero at the "nothing in flight" check, so a dependent whose blocker
   * just landed gets one extra refill before `next()` gives up and returns
   * `null`.
   */
  drainMerges?(): Promise<void>;
  log?(line: string): void;
}

export interface Dealer<C extends DealerCard> {
  /**
   * Next card to work, or `null` once the stack is drained AND nothing is in
   * flight. A call after `null` has already been returned calls `plan()`
   * again and returns `null` again if the plan is still empty and nothing is
   * in flight — draining is not latched, since a `Blocked-by:` dependent can
   * become freshly dealable after this call returns.
   */
  next(): Promise<C | null>;
  /** Frees the in-flight slot for `card` and wakes EVERY worker parked in `next()`. */
  done(card: C): void;
  isEmpty(): boolean;
  stack(): readonly C[];
  inFlight(): readonly C[];
  /** How many times `plan()` has been called — the total refill count. */
  deals(): number;
}

export function createDealer<C extends DealerCard>(opts: {
  stackSize: number;
  deps: DealerDeps<C>;
}): Dealer<C> {
  if (opts.stackSize < 1) {
    throw new Error("createDealer: stackSize must be ≥ 1");
  }
  const stack: C[] = [];
  const inFlight = new Map<string, C>();
  let deals = 0;
  // Single-flight guard: two workers hitting an empty stack at once must
  // trigger exactly one `plan()` call, both awaiting the same promise.
  let refill: Promise<void> | undefined;
  // Every worker currently parked in `waitForCompletion()`, in park order.
  // See the module doc for why this must be a list, not a single slot.
  const waiters: Array<() => void> = [];

  const waitForCompletion = (): Promise<void> =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
    });

  async function refillOnce(): Promise<void> {
    if (refill === undefined) {
      refill = (async () => {
        deals += 1;
        const cards = await opts.deps.plan({
          stackSize: opts.stackSize,
          deal: deals,
          inFlight: [...inFlight.values()],
        });
        const seen = new Set([...inFlight.keys(), ...stack.map((c) => c.id)]);
        for (const c of cards) {
          if (stack.length >= opts.stackSize) break;
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          stack.push(c);
        }
      })().finally(() => {
        refill = undefined;
      });
    }
    await refill;
  }

  return {
    async next() {
      // See BARREN_REFILL_LIMIT: cards refused since the last refill, and how
      // many refills in a row have been wholly refused.
      let refusedSinceRefill = 0;
      let barrenRefills = 0;
      // Every card THIS call has already offered to `validate` and had
      // refused. The barren trip below drops these and ONLY these — see the
      // comment there for why clearing the whole stack was wrong.
      const refusedIds = new Set<string>();
      for (;;) {
        const card = stack.shift();
        if (card !== undefined) {
          // Reserve the card in `inFlight` IMMEDIATELY on taking it off the
          // stack — before the `await validate?.()` below, not after.
          // `validate` is async, so leaving the reservation until after it
          // opens a window where the card is neither on the stack nor in
          // `inFlight`; a second `next()` call racing this one (both woken
          // by the same refill, or one parked on `waitForCompletion`) can
          // land its own "stack empty, nothing in flight" check inside that
          // window and wrongly declare the queue drained while this card is
          // still very much being claimed. Delete it again below if
          // `validate` rejects it.
          inFlight.set(card.id, card);
          let ok = true;
          try {
            ok = (await opts.deps.validate?.(card)) ?? true;
          } catch (err) {
            opts.deps.log?.(
              `dealer: validate #${card.id} threw (${(err as Error).message}) — treating as valid`,
            );
          }
          if (!ok) {
            inFlight.delete(card.id);
            refusedSinceRefill += 1;
            refusedIds.add(card.id);
            opts.deps.log?.(
              `dealer: #${card.id} no longer dealable — skipping`,
            );
            continue;
          }
          return card;
        }
        await refillOnce();
        const refillWasBarren = refusedSinceRefill > 0;
        if (refillWasBarren) {
          barrenRefills += 1;
          refusedSinceRefill = 0;
        }
        // `refillWasBarren &&` is what lets `barrenRefills` stay counted for
        // the whole call instead of being zeroed on every trip. Zeroing it
        // handed a woken worker a fresh full allowance of refills, so a pool
        // that parks and wakes repeatedly could still re-plan far more often
        // than the limit's name suggests. The
        // counter now only ever goes up within one `next()` call, and the trip
        // fires only on a refill that was ACTUALLY barren — so a refill that
        // finally produced a dealable card falls straight through to the
        // `continue` below instead of having its card thrown away.
        if (refillWasBarren && barrenRefills >= BARREN_REFILL_LIMIT) {
          // Every card the last few refills produced was refused. Drop THOSE
          // cards and fall through to the ordinary drained/park paths below
          // rather than re-planning: with siblings still in flight this parks
          // (a completion is the only thing that can change the answer), and
          // with nothing in flight it ends the pass cleanly.
          //
          // ⚠️ `refusedIds`, not `stack.length = 0`. A blanket clear also
          // dropped cards this call had never OFFERED to `validate` — and the
          // refill that trips the guard is exactly where such a card appears,
          // because a `Blocked-by:` dependent becomes dealable the moment its
          // blocker's label flips, which can happen between two refills. The
          // blanket clear threw that card away unexamined and then parked, so
          // the one ticket that had just become workable waited for an
          // unrelated completion to wake the pool again.
          opts.deps.log?.(
            `dealer: ${BARREN_REFILL_LIMIT} refills in a row produced only cards that were refused — not asking the planner again on this pass`,
          );
          const kept = stack.filter((c) => !refusedIds.has(c.id));
          stack.length = 0;
          stack.push(...kept);
        }
        if (stack.length > 0) continue;
        if (inFlight.size === 0) {
          // #1191 finding C: a `Blocked-by:` dependent can look unplannable
          // for a reason that has nothing to do with the queue being empty —
          // the completing worker's refill re-plans BEFORE its own merge (on
          // the separate serial merge lane) has landed, so the blocker's label
          // is still unresolved in the listing the plan reads. Give a pending merge one chance to land before declaring
          // the queue drained: if the lane still has work queued, wait for
          // it, then refill once more.
          const pending = opts.deps.pendingMerges?.() ?? 0;
          if (pending > 0) {
            await opts.deps.drainMerges?.();
            await refillOnce();
            if (stack.length > 0) continue;
          }
          return null;
        }
        await waitForCompletion();
      }
    },
    done(card) {
      inFlight.delete(card.id);
      // Drain the whole waiter list before resolving any of them — a waiter's
      // continuation runs synchronously enough (microtask) that resolving one
      // while iterating a live array can re-enter and mutate it mid-loop.
      const toWake = waiters.splice(0, waiters.length);
      for (const w of toWake) w();
    },
    isEmpty: () => stack.length === 0,
    stack: () => [...stack],
    inFlight: () => [...inFlight.values()],
    deals: () => deals,
  };
}
