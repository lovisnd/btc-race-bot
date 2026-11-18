// Dip-bounce mean-reversion bot for the cbBTC/USDC 1-minute bars replay.
//
// Strategy (long only, one position, all BigInt arithmetic so two runs agree
// byte for byte):
//
//   * Stay in cash almost all the time. The pool is thin and a full-size
//     round trip costs ~26 bps, so most minutes are not worth trading.
//   * Entry: the close is at least DIP_BPS below its 60-bar simple moving
//     average (the asset is oversold against its own recent hour) AND the
//     trailing 5-bar return has turned positive by at least TURN_BPS (the dip
//     is bouncing, not still falling). Buy with all cash.
//   * Exit, whole position, on whichever comes first:
//       - the position is worth TARGET_BPS over its cost (bank the bounce),
//       - the position is worth STOP_BPS under its cost (cut the knife),
//       - the close climbs back to the 60-bar average (mean reverted),
//       - MAX_HOLD bars have passed since entry (don't ride a dead bounce).
//   * No new entries in the last NO_ENTRY_TAIL bars: a position opened there
//     would be flattened at the window's last close with no time to revert.
//   * Insurance: if the primary entry has not fired once by mid-window
//     (INSURANCE_ARM_BAR), one looser dip trade (INSURANCE_DIP_BPS /
//     INSURANCE_TURN_BPS, same exits) is allowed, so a calm window still
//     leaves the entry with at least one trade instead of sitting out the
//     whole race in cash. It never fires on a window where the primary
//     entry already traded.
//
// Why this shape: on a 24h window the pool's price mostly grinds with the
// market and only occasionally snaps away from its hourly mean and snaps
// back. Chasing strength loses (up-moves revert within ~15 minutes), and
// buying a dip while it is still falling loses too; the turn filter is what
// separates a bounce from a falling knife. The exit on reversion to the
// average is the main profit taker: the bounce is sold back into the mean,
// not held hoping for a trend that rarely follows on this pool.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SMA_BARS = 60; // one hour of 1-minute closes
const DIP_BPS = 40n; // entry: close this far below the 60-bar average
const TURN_BPS = 10n; // entry: trailing 5-bar return at least this positive
const TARGET_BPS = 60n; // exit: position worth this much over its cost
const STOP_BPS = 150n; // exit: position worth this much under its cost
const MAX_HOLD = 600; // exit: bars since entry
const NO_ENTRY_TAIL = 120; // no new entries in the last this many bars
const WINDOW_BARS = 1440; // both windows are 1440 one-minute bars
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const INSURANCE_ARM_BAR = 720; // mid-window: primary must have fired by now
const INSURANCE_DIP_BPS = 30n; // insurance entry: a shallower dip suffices
const INSURANCE_TURN_BPS = 5n; // insurance entry: a smaller turn suffices

/** Closes of the symbol, oldest first, appended once per bar that carries it. */
const closes: bigint[] = [];
/** Bar index (count of bars seen) at which the current position was opened. */
let entryBar = -1;
/** How many bars of the symbol have been seen so far. */
let barsSeen = 0;
/** Whether the primary entry has fired at least once in this window. */
let traded = false;

/** The simple moving average of the last n closes, truncated to an integer. */
function sma(n: number): bigint {
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
  return sum / BigInt(n);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    if (state.warmingUp) return [];
    let bar = null;
    for (const b of batch.bars) {
      if (b.symbol === SYMBOL) {
        bar = b;
        break;
      }
    }
    if (bar === null) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    barsSeen += 1;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      // Exit: profit target, stop loss, reversion to the average, or stale.
      if (value * 10000n >= cost * (10000n + TARGET_BPS)) return [sell];
      if (value * 10000n <= cost * (10000n - STOP_BPS)) return [sell];
      if (barsSeen - 1 - entryBar >= MAX_HOLD) return [sell];
      if (closes.length >= SMA_BARS && close >= sma(SMA_BARS)) return [sell];
      return [];
    }

    // Flat: look for a dip that is turning up. Stop entering near the end of
    // the window, so a fresh position is not flattened at the last close
    // before it can revert.
    if (closes.length < SMA_BARS || closes.length < 6) return [];
    if (barsSeen > WINDOW_BARS - NO_ENTRY_TAIL) return [];
    // The insurance thresholds apply only while the primary entry has never
    // fired and mid-window has passed; otherwise the strict ones do.
    const dipBps = !traded && barsSeen - 1 >= INSURANCE_ARM_BAR ? INSURANCE_DIP_BPS : DIP_BPS;
    const turnBps = !traded && barsSeen - 1 >= INSURANCE_ARM_BAR ? INSURANCE_TURN_BPS : TURN_BPS;
    const avg = sma(SMA_BARS);
    if (close * 10000n >= avg * (10000n - dipBps)) return [];
    const fiveAgo = closes[closes.length - 6];
    if ((close - fiveAgo) * 10000n < fiveAgo * turnBps) return [];
    const notional = state.cash;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryBar = barsSeen - 1;
    traded = true;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
