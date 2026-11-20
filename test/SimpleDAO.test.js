const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine, time } = require("@nomicfoundation/hardhat-network-helpers");

const e18 = (n) => ethers.parseUnits(n.toString(), 18);
const State = { Pending: 0, Active: 1, Defeated: 2, Succeeded: 3, Executed: 4, Canceled: 5 };
const Vote = { Against: 0, For: 1, Abstain: 2 };

const VOTING_DELAY = 5;     // blocks
const VOTING_PERIOD = 50;   // blocks
const TIMELOCK = 2 * 24 * 60 * 60; // 2 days
const THRESHOLD = e18(1000);
const QUORUM = 10;          // 10% of supply

describe("SimpleDAO", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol, grantee] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("GovToken");
    const token = await Token.deploy(deployer.address, e18(100_000));

    const DAO = await ethers.getContractFactory("SimpleDAO");
    const dao = await DAO.deploy(await token.getAddress(), VOTING_DELAY, VOTING_PERIOD, TIMELOCK, THRESHOLD, QUORUM);

    // Distribute: alice 30k, bob 20k, carol 500 (below threshold). Deployer keeps 49.5k without delegating.
    await token.transfer(alice.address, e18(30_000));
    await token.transfer(bob.address, e18(20_000));
    await token.transfer(carol.address, e18(500));
    for (const s of [alice, bob, carol]) await token.connect(s).delegate(s.address);

    // Fund the treasury with 10 ETH.
    await deployer.sendTransaction({ to: await dao.getAddress(), value: e18(10) });

    return { token, dao, deployer, alice, bob, carol, grantee };
  }

  // Alice proposes sending 1 ETH from the treasury to the grantee.
  async function proposalFixture() {
    const ctx = await deployFixture();
    await ctx.dao.connect(ctx.alice).propose(ctx.grantee.address, e18(1), "0x", "Grant: 1 ETH for community tooling");
    return { ...ctx, id: 1n };
  }

  async function passedFixture() {
    const ctx = await proposalFixture();
    await mine(VOTING_DELAY + 1);
    await ctx.dao.connect(ctx.alice).castVote(ctx.id, Vote.For, "");
    await mine(VOTING_PERIOD);
    return ctx;
  }

  describe("Proposing", function () {
    it("creates a pending proposal", async function () {
      const { dao, alice, grantee } = await loadFixture(deployFixture);
      await expect(dao.connect(alice).propose(grantee.address, 0, "0x", "Hello DAO")).to.emit(dao, "ProposalCreated");
      expect(await dao.state(1)).to.equal(State.Pending);
      const p = await dao.getProposal(1);
      expect(p.proposer).to.equal(alice.address);
      expect(p.description).to.equal("Hello DAO");
    });

    it("requires the proposal threshold", async function () {
      const { dao, carol, grantee } = await loadFixture(deployFixture);
      await expect(dao.connect(carol).propose(grantee.address, 0, "0x", "x"))
        .to.be.revertedWithCustomError(dao, "BelowProposalThreshold")
        .withArgs(e18(500), THRESHOLD);
    });

    it("unknown proposals revert", async function () {
      const { dao } = await loadFixture(deployFixture);
      await expect(dao.state(42)).to.be.revertedWithCustomError(dao, "UnknownProposal").withArgs(42);
    });
  });

  describe("Voting", function () {
    it("cannot vote while pending", async function () {
      const { dao, alice, id } = await loadFixture(proposalFixture);
      await expect(dao.connect(alice).castVote(id, Vote.For, ""))
        .to.be.revertedWithCustomError(dao, "WrongState")
        .withArgs(State.Pending);
    });

    it("counts votes by snapshot voting power", async function () {
      const { dao, alice, bob, carol, id } = await loadFixture(proposalFixture);
      await mine(VOTING_DELAY + 1);
      expect(await dao.state(id)).to.equal(State.Active);

      await expect(dao.connect(alice).castVote(id, Vote.For, "LGTM"))
        .to.emit(dao, "VoteCast")
        .withArgs(id, alice.address, Vote.For, e18(30_000), "LGTM");
      await dao.connect(bob).castVote(id, Vote.Against, "");
      await dao.connect(carol).castVote(id, Vote.Abstain, "");

      const p = await dao.getProposal(id);
      expect(p.forVotes).to.equal(e18(30_000));
      expect(p.againstVotes).to.equal(e18(20_000));
      expect(p.abstainVotes).to.equal(e18(500));
    });

    it("prevents double voting, including by moving tokens after the snapshot", async function () {
      const { token, dao, alice, grantee, id } = await loadFixture(proposalFixture);
      await mine(VOTING_DELAY + 1);
      await dao.connect(alice).castVote(id, Vote.For, "");
      await expect(dao.connect(alice).castVote(id, Vote.For, "")).to.be.revertedWithCustomError(dao, "AlreadyVoted");

      // Tokens moved after the snapshot carry no voting power for this proposal.
      await token.connect(alice).transfer(grantee.address, e18(10_000));
      await token.connect(grantee).delegate(grantee.address);
      await expect(dao.connect(grantee).castVote(id, Vote.For, "")).to.be.revertedWithCustomError(dao, "NoVotingPower");
    });

    it("undelegated holders have no voting power", async function () {
      const { dao, deployer, id } = await loadFixture(proposalFixture);
      await mine(VOTING_DELAY + 1);
      await expect(dao.connect(deployer).castVote(id, Vote.For, "")).to.be.revertedWithCustomError(dao, "NoVotingPower");
    });
  });

  describe("Outcome", function () {
    it("succeeds with majority and quorum", async function () {
      const { dao, id } = await loadFixture(passedFixture);
      expect(await dao.state(id)).to.equal(State.Succeeded);
      expect(await dao.quorum((await dao.getProposal(id)).snapshot)).to.equal(e18(10_000));
    });

    it("is defeated when against >= for", async function () {
      const { dao, alice, bob, id } = await loadFixture(proposalFixture);
      await mine(VOTING_DELAY + 1);
      await dao.connect(bob).castVote(id, Vote.For, "");
      await dao.connect(alice).castVote(id, Vote.Against, "");
      await mine(VOTING_PERIOD);
      expect(await dao.state(id)).to.equal(State.Defeated);
    });

    it("is defeated without quorum", async function () {
      const { dao, carol, id } = await loadFixture(proposalFixture);
      await mine(VOTING_DELAY + 1);
      await dao.connect(carol).castVote(id, Vote.For, ""); // 500 < 10k quorum
      await mine(VOTING_PERIOD);
      expect(await dao.state(id)).to.equal(State.Defeated);
    });
  });

  describe("Execution", function () {
    it("executes after the timelock and moves treasury funds", async function () {
      const { dao, grantee, id } = await loadFixture(passedFixture);
      await expect(dao.queue(id)).to.emit(dao, "ProposalQueued");
      await expect(dao.execute(id)).to.be.revertedWithCustomError(dao, "TimelockNotPassed");

      await time.increase(TIMELOCK);
      await expect(dao.execute(id)).to.changeEtherBalances([dao, grantee], [-e18(1), e18(1)]);
      expect(await dao.state(id)).to.equal(State.Executed);
      await expect(dao.execute(id)).to.be.revertedWithCustomError(dao, "WrongState").withArgs(State.Executed);
    });

    it("cannot execute without queueing or queue twice", async function () {
      const { dao, id } = await loadFixture(passedFixture);
      await expect(dao.execute(id)).to.be.revertedWithCustomError(dao, "TimelockNotPassed");
      await dao.queue(id);
      await expect(dao.queue(id)).to.be.revertedWithCustomError(dao, "WrongState");
    });

    it("defeated proposals cannot be queued", async function () {
      const { dao, id } = await loadFixture(proposalFixture);
      await mine(VOTING_DELAY + VOTING_PERIOD + 2);
      await expect(dao.queue(id)).to.be.revertedWithCustomError(dao, "WrongState").withArgs(State.Defeated);
    });

    it("bubbles up failed calls", async function () {
      const { dao, alice } = await loadFixture(deployFixture);
      // Ask the DAO to send more ETH than it has.
      await dao.connect(alice).propose(alice.address, e18(1000), "0x", "Too much");
      await mine(VOTING_DELAY + 1);
      await dao.connect(alice).castVote(1, Vote.For, "");
      await mine(VOTING_PERIOD);
      await dao.queue(1);
      await time.increase(TIMELOCK);
      await expect(dao.execute(1)).to.be.revertedWithCustomError(dao, "ExecutionFailed");
    });
  });

  describe("Cancel and self-governance", function () {
    it("proposer can cancel while pending only", async function () {
      const { dao, alice, bob, id } = await loadFixture(proposalFixture);
      await expect(dao.connect(bob).cancel(id)).to.be.revertedWithCustomError(dao, "NotProposer");
      await expect(dao.connect(alice).cancel(id)).to.emit(dao, "ProposalCanceled").withArgs(id);
      expect(await dao.state(id)).to.equal(State.Canceled);
    });

    it("settings can only change through a proposal", async function () {
      const { dao, alice } = await loadFixture(deployFixture);
      await expect(dao.connect(alice).updateSettings(1, 10, 0, 0, 20)).to.be.revertedWithCustomError(dao, "OnlyDAO");

      const data = dao.interface.encodeFunctionData("updateSettings", [2, 100, TIMELOCK, THRESHOLD, 20]);
      await dao.connect(alice).propose(await dao.getAddress(), 0, data, "Raise quorum to 20%");
      await mine(VOTING_DELAY + 1);
      await dao.connect(alice).castVote(1, Vote.For, "");
      await mine(VOTING_PERIOD);
      await dao.queue(1);
      await time.increase(TIMELOCK);
      await dao.execute(1);

      expect(await dao.quorumPercent()).to.equal(20);
      expect(await dao.votingPeriod()).to.equal(100);
    });

    it("rejects invalid settings", async function () {
      const { token } = await loadFixture(deployFixture);
      const DAO = await ethers.getContractFactory("SimpleDAO");
      const addr = await token.getAddress();
      await expect(DAO.deploy(addr, 1, 0, 0, 0, 10)).to.be.revertedWithCustomError(DAO, "InvalidSettings");
      await expect(DAO.deploy(addr, 1, 10, 0, 0, 101)).to.be.revertedWithCustomError(DAO, "InvalidSettings");
    });
  });
});
