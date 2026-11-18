[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/c/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/lovisnd/btc-race-bot/rank.svg)](https://make.fun/c/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/lovisnd/btc-race-bot/reward.svg)](https://make.fun/c/btc-race-24h-20261118-1444)

# btc-race-bot

A dip-bounce mean-reversion bot for [Race a BTC trading bot live for 24 hours](https://make.fun/c/btc-race-24h-20261118-1444) on [make.fun](https://make.fun). It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, starting with $1,000 of paper money, long only.

## Strategy

- **Stay in cash almost all the time.** A full-size round trip costs ~26 bps in fees, slippage and price impact, so most minutes are not worth trading.
- **Entry:** the close is at least 40 bps below its 60-bar simple moving average (oversold against its own recent hour) **and** the trailing 5-bar return has turned positive by at least 10 bps (the dip is bouncing, not still falling). Buy with all cash.
- **Exit** (whole position, whichever comes first): worth 60 bps over cost, worth 150 bps under cost, close back at the 60-bar average (mean reverted), or 600 bars since entry.
- **No new entries in the last 120 bars** of the window, so a fresh position is not flattened at the last close before it can revert.
- **Insurance:** if the entry has not fired once by mid-window (bar 720), one looser dip trade (30 bps dip, 5 bps turn, same exits) is allowed, so a calm window still leaves the entry with at least one trade.

## Dev-window result (local grade)

- Net PnL **+7.487 USDC** (+0.75%), 4 trades (2 round trips, win rate 100%), max drawdown 0.41%, guardrails met. For comparison, buy-and-hold lost $31.63 and every kit baseline lost money on the same window.

## Run

`main.ts` speaks `agent-fun/bars-replay/v1` (NDJSON on stdin/stdout) via the vendored SDK shim in `vendor/`; Node 22, standard library only, all-integer arithmetic, no network, no wall clock, deterministic.

## License

MIT — see [LICENSE](LICENSE).
