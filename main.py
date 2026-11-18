"""Dip-bounce mean-reversion bot for the cbBTC/USDC 1-minute bars replay.

Strategy (long only, one position, all integer arithmetic so two runs agree
byte for byte):

  * Stay in cash almost all the time. The pool is thin and a full-size round
    trip costs ~26 bps, so most minutes are not worth trading.
  * Entry: the close is at least DIP_BPS below its 60-bar simple moving
    average (the asset is oversold against its own recent hour) AND the
    trailing 5-bar return has turned positive by at least TURN_BPS (the dip
    is bouncing, not still falling). Buy with all cash.
  * Exit, whole position, on whichever comes first:
      - the position is worth TARGET_BPS over its cost (bank the bounce),
      - the position is worth STOP_BPS under its cost (cut the knife),
      - the close climbs back to the 60-bar average (mean reverted),
      - MAX_HOLD bars have passed since entry (don't ride a dead bounce).
  * No new entries in the last NO_ENTRY_TAIL bars: a position opened there
    would be flattened at the window's last close with no time to revert.

Why this shape: on a 24h window the pool's price mostly grinds with the
market and only occasionally snaps away from its hourly mean and snaps
back. Chasing strength loses (up-moves revert within ~15 minutes), and
buying a dip while it is still falling loses too; the turn filter is what
separates a bounce from a falling knife. The exit on reversion to the
average is the main profit taker: the bounce is sold back into the mean,
not held hoping for a trend that rarely follows on this pool.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"
SMA_BARS = 60            # one hour of 1-minute closes
DIP_BPS = 40             # entry: close this far below the 60-bar average
TURN_BPS = 10            # entry: trailing 5-bar return at least this positive
TARGET_BPS = 60          # exit: position worth this much over its cost
STOP_BPS = 150           # exit: position worth this much under its cost
MAX_HOLD = 600           # exit: bars since entry
NO_ENTRY_TAIL = 120      # no new entries in the last this many bars
MAX_SLIPPAGE_BPS = 100   # 1% past the close the order was decided on

# Closes of the symbol, oldest first, appended once per bar that carries it.
closes = []
# Bar index (count of bars seen) at which the current position was opened.
entry_bar = -1
# How many bars of the symbol have been seen so far.
bars_seen = 0


def _sma(n):
    """The simple moving average of the last n closes, truncated to an int."""
    return sum(closes[-n:]) // n


def on_batch(state, batch):
    global entry_bar, bars_seen
    if state.warming_up:
        return []
    bar = None
    for b in batch["bars"]:
        if b["symbol"] == SYMBOL:
            bar = b
            break
    if bar is None:
        return []
    close = int(bar["c"])
    closes.append(close)
    bars_seen += 1

    held = state.positions.get(SYMBOL)
    if held is not None:
        value = state.value(SYMBOL, held.qty)
        cost = held.cost
        # Exit: profit target, stop loss, reversion to the average, or stale.
        if value * 10000 >= cost * (10000 + TARGET_BPS):
            return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
        if value * 10000 <= cost * (10000 - STOP_BPS):
            return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
        if bars_seen - 1 - entry_bar >= MAX_HOLD:
            return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
        if len(closes) >= SMA_BARS and close >= _sma(SMA_BARS):
            return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
        return []

    # Flat: look for a dip that is turning up. Stop entering near the end of
    # the window (both windows are 1440 bars), so a fresh position is not
    # flattened at the last close before it can revert.
    if len(closes) < SMA_BARS or len(closes) < 6:
        return []
    if bars_seen > 1440 - NO_ENTRY_TAIL:
        return []
    avg = _sma(SMA_BARS)
    if close * 10000 >= avg * (10000 - DIP_BPS):
        return []
    five_ago = closes[-6]
    if (close - five_ago) * 10000 < five_ago * TURN_BPS:
        return []
    notional = state.cash
    if notional < int(state.hello["fees"]["min_notional_quote_units"]):
        return []
    entry_bar = bars_seen - 1
    return [{"side": "buy", "symbol": SYMBOL, "notional_quote_units": notional,
             "max_slippage_bps": MAX_SLIPPAGE_BPS}]


makefun_bars.run(on_batch)
