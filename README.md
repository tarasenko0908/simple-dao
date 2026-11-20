# Simple DAO

Lightweight on-chain governance: token holders create proposals, vote, and execute arbitrary calls from the DAO treasury after a timelock.
Built from scratch on top of OpenZeppelin `ERC20Votes` checkpoints, without the full Governor framework, to keep the logic small and easy to audit.

## Proposal lifecycle

```
propose ──► Pending ──(voting delay)──► Active ──(voting period)──► Succeeded ──queue──► (timelock) ──execute──► Executed
               │                                                └─► Defeated
               └── cancel (proposer) ──► Canceled
```

A proposal **succeeds** when `for > against` and `for + abstain ≥ quorum` (a % of total supply at the snapshot).

## Features

- **Snapshot voting** — power is read at the proposal's snapshot block, so tokens moved after the proposal was created can't be used to vote twice
- **For / Against / Abstain** votes with an optional reason
- **Proposal threshold** against spam
- **Timelock** between success and execution, giving holders time to react
- **Treasury** — the DAO holds ETH and can call any contract (grants, upgrades, parameter changes)
- **Self-governed settings** — `updateSettings` can only be called by the DAO itself through a proposal
- Failed calls bubble up the revert reason; `ReentrancyGuard` on execution

## Contracts

| Contract | Description |
|---|---|
| `GovToken.sol` | ERC-20 + `ERC20Permit` + `ERC20Votes` governance token |
| `SimpleDAO.sol` | Proposals, voting, timelock and execution |

| Function | Who | Description |
|---|---|---|
| `propose(target, value, data, description)` | holders ≥ threshold | Create a proposal |
| `castVote(id, support, reason)` | holders | Vote with snapshot power |
| `queue(id)` | anyone | Start the timelock for a succeeded proposal |
| `execute(id)` | anyone | Execute after the timelock |
| `cancel(id)` | proposer | Cancel before voting starts |
| `state(id)` / `quorum(block)` | view | Status and quorum |
| `updateSettings(...)` | DAO only | Change delay, period, timelock, threshold, quorum |

> Holders must call `delegate(self)` on the token to activate their voting power — standard `ERC20Votes` behaviour.

## Getting started

```bash
npm install
npx hardhat compile
npx hardhat test
npm run coverage
```

## Tests

17 tests: proposing and thresholds, snapshot voting, double-vote protection, quorum and majority, timelock and execution, treasury transfers, failed calls, cancellation, self-governance.

```
  17 passing
```

Line coverage: ~99%.

## Tech stack

Solidity 0.8.24 · OpenZeppelin Contracts 5 · Hardhat · Ethers v6 · Chai

## License

MIT
