// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC5805} from "@openzeppelin/contracts/interfaces/IERC5805.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SimpleDAO
 * @notice Minimal on-chain governance: token holders propose, vote and execute arbitrary calls
 *         from the DAO treasury (this contract).
 *
 * Proposal lifecycle:
 *   Pending ─(votingDelay)─► Active ─(votingPeriod)─► Succeeded ─(timelock)─► executable ─► Executed
 *                                                  └► Defeated
 *   The proposer can cancel while the proposal is Pending.
 *
 * Rules:
 *  - Voting power is read from token checkpoints at the proposal's snapshot block, so tokens
 *    bought or transferred after the proposal was created can't be used to vote twice.
 *  - Proposing requires at least `proposalThreshold` votes.
 *  - A proposal succeeds if `for > against` and `for + abstain >= quorum`, where quorum is a
 *    percentage of the total supply at the snapshot.
 *  - Succeeded proposals wait `timelock` seconds before execution, giving holders time to react.
 *  - All parameters can only be changed by the DAO itself (via a proposal).
 */
contract SimpleDAO is ReentrancyGuard {
    enum ProposalState {
        Pending,
        Active,
        Defeated,
        Succeeded,
        Executed,
        Canceled
    }

    enum VoteType {
        Against,
        For,
        Abstain
    }

    struct Proposal {
        address proposer;
        address target;
        uint256 value;
        bytes data;
        string description;
        uint48 snapshot;      // block number for voting power
        uint48 voteEnd;       // last block of voting
        uint64 eta;           // earliest execution timestamp, set by queue()
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        bool executed;
        bool canceled;
    }

    IERC5805 public immutable token;

    uint48 public votingDelay;        // blocks between proposal and voting start
    uint48 public votingPeriod;       // blocks of voting
    uint64 public timelock;           // seconds between success and execution
    uint256 public proposalThreshold; // votes needed to propose
    uint8 public quorumPercent;       // % of total supply

    uint256 public proposalCount;
    mapping(uint256 proposalId => Proposal) private _proposals;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;

    event ProposalCreated(uint256 indexed id, address indexed proposer, address target, uint256 value, string description, uint48 snapshot, uint48 voteEnd);
    event VoteCast(uint256 indexed id, address indexed voter, VoteType support, uint256 weight, string reason);
    event ProposalQueued(uint256 indexed id, uint64 eta);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCanceled(uint256 indexed id);
    event SettingsUpdated(uint48 votingDelay, uint48 votingPeriod, uint64 timelock, uint256 proposalThreshold, uint8 quorumPercent);
    event Deposit(address indexed from, uint256 amount);

    error BelowProposalThreshold(uint256 votes, uint256 threshold);
    error InvalidSettings();
    error InvalidTarget();
    error UnknownProposal(uint256 id);
    error WrongState(ProposalState current);
    error AlreadyVoted();
    error NoVotingPower();
    error NotProposer();
    error OnlyDAO();
    error TimelockNotPassed(uint64 eta);
    error ExecutionFailed(bytes returnData);

    modifier onlyDAO() {
        if (msg.sender != address(this)) revert OnlyDAO();
        _;
    }

    constructor(
        IERC5805 token_,
        uint48 votingDelay_,
        uint48 votingPeriod_,
        uint64 timelock_,
        uint256 proposalThreshold_,
        uint8 quorumPercent_
    ) {
        token = token_;
        _setSettings(votingDelay_, votingPeriod_, timelock_, proposalThreshold_, quorumPercent_);
    }

    /// @notice The DAO treasury accepts ETH.
    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // ─────────────────────────────── Proposals ───────────────────────────────

    /**
     * @notice Creates a proposal to call `target` with `value` ETH and calldata `data`.
     * @return id Proposal id.
     */
    function propose(address target, uint256 value, bytes calldata data, string calldata description)
        external
        returns (uint256 id)
    {
        if (target == address(0)) revert InvalidTarget();
        uint256 votes = token.getVotes(msg.sender);
        if (votes < proposalThreshold) revert BelowProposalThreshold(votes, proposalThreshold);

        uint48 snapshot = uint48(block.number) + votingDelay;
        uint48 voteEnd = snapshot + votingPeriod;

        id = ++proposalCount;
        Proposal storage p = _proposals[id];
        p.proposer = msg.sender;
        p.target = target;
        p.value = value;
        p.data = data;
        p.description = description;
        p.snapshot = snapshot;
        p.voteEnd = voteEnd;

        emit ProposalCreated(id, msg.sender, target, value, description, snapshot, voteEnd);
    }

    /// @notice Votes on an active proposal with the caller's voting power at the snapshot.
    function castVote(uint256 id, VoteType support, string calldata reason) external returns (uint256 weight) {
        if (state(id) != ProposalState.Active) revert WrongState(state(id));
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();

        Proposal storage p = _proposals[id];
        weight = token.getPastVotes(msg.sender, p.snapshot);
        if (weight == 0) revert NoVotingPower();

        hasVoted[id][msg.sender] = true;
        if (support == VoteType.For) p.forVotes += weight;
        else if (support == VoteType.Against) p.againstVotes += weight;
        else p.abstainVotes += weight;

        emit VoteCast(id, msg.sender, support, weight, reason);
    }

    /// @notice Starts the timelock for a succeeded proposal.
    function queue(uint256 id) external {
        if (state(id) != ProposalState.Succeeded) revert WrongState(state(id));
        Proposal storage p = _proposals[id];
        if (p.eta != 0) revert WrongState(ProposalState.Succeeded);
        p.eta = uint64(block.timestamp) + timelock;
        emit ProposalQueued(id, p.eta);
    }

    /// @notice Executes a queued proposal once its timelock has passed. Anyone can call it.
    function execute(uint256 id) external nonReentrant returns (bytes memory result) {
        if (state(id) != ProposalState.Succeeded) revert WrongState(state(id));
        Proposal storage p = _proposals[id];
        if (p.eta == 0 || block.timestamp < p.eta) revert TimelockNotPassed(p.eta);

        p.executed = true; // effects before the external call
        (bool ok, bytes memory ret) = p.target.call{value: p.value}(p.data);
        if (!ok) revert ExecutionFailed(ret);

        emit ProposalExecuted(id);
        return ret;
    }

    /// @notice The proposer can cancel before voting starts.
    function cancel(uint256 id) external {
        if (state(id) != ProposalState.Pending) revert WrongState(state(id));
        Proposal storage p = _proposals[id];
        if (msg.sender != p.proposer) revert NotProposer();
        p.canceled = true;
        emit ProposalCanceled(id);
    }

    // ─────────────────────────────── Views ───────────────────────────────

    function state(uint256 id) public view returns (ProposalState) {
        Proposal storage p = _proposals[id];
        if (p.proposer == address(0)) revert UnknownProposal(id);
        if (p.executed) return ProposalState.Executed;
        if (p.canceled) return ProposalState.Canceled;
        if (block.number <= p.snapshot) return ProposalState.Pending;
        if (block.number <= p.voteEnd) return ProposalState.Active;
        return _succeeded(p) ? ProposalState.Succeeded : ProposalState.Defeated;
    }

    /// @notice Votes required for quorum at a given block.
    function quorum(uint256 blockNumber) public view returns (uint256) {
        return (token.getPastTotalSupply(blockNumber) * quorumPercent) / 100;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        Proposal memory p = _proposals[id];
        if (p.proposer == address(0)) revert UnknownProposal(id);
        return p;
    }

    // ─────────────────────────────── Governance ───────────────────────────────

    /// @notice Changes DAO parameters. Callable only through a successful proposal.
    function updateSettings(
        uint48 votingDelay_,
        uint48 votingPeriod_,
        uint64 timelock_,
        uint256 proposalThreshold_,
        uint8 quorumPercent_
    ) external onlyDAO {
        _setSettings(votingDelay_, votingPeriod_, timelock_, proposalThreshold_, quorumPercent_);
    }

    // ────────────────────────────── Internal ─────────────────────────────

    function _succeeded(Proposal storage p) private view returns (bool) {
        return p.forVotes > p.againstVotes && p.forVotes + p.abstainVotes >= quorum(p.snapshot);
    }

    function _setSettings(uint48 delay, uint48 period, uint64 lock, uint256 threshold, uint8 quorumPct) private {
        if (period == 0 || quorumPct == 0 || quorumPct > 100) revert InvalidSettings();
        votingDelay = delay;
        votingPeriod = period;
        timelock = lock;
        proposalThreshold = threshold;
        quorumPercent = quorumPct;
        emit SettingsUpdated(delay, period, lock, threshold, quorumPct);
    }
}
