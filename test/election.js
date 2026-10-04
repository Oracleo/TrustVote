const Election = artifacts.require("./Election.sol");

contract("Election Security & Lifecycle Test Suite", (accounts) => {
    let election;

    const admin = accounts[0];
    const eligibleVoter1 = accounts[1];
    const eligibleVoter2 = accounts[2];
    const ineligibleVoter = accounts[3];
    const attacker = accounts[4];

    // Helper to assert that an async transaction reverts
    async function assertRevert(promise, expectedReason) {
        try {
            await promise;
            assert.fail("Transaction was expected to revert, but succeeded");
        } catch (error) {
            assert(
                error.message.includes("revert"),
                `Expected revert, got: ${error.message}`
            );
            if (expectedReason) {
                assert(
                    error.message.includes(expectedReason),
                    `Expected reason containing '${expectedReason}', got: '${error.message}'`
                );
            }
        }
    }

    beforeEach(async () => {
        // Deploy a fresh contract instance for each test to guarantee state isolation
        election = await Election.new({ from: admin });
    });

    // ------------------------------------------------------------------------
    // Deployment & Initialization
    // ------------------------------------------------------------------------

    it("ST-01: Contract deploys in Registration state with 0 initial candidates", async () => {
        const state = await election.getElectionState();
        const count = await election.candidatesCount();
        const totalVotes = await election.totalVotesCast();

        assert.equal(state.toNumber(), 0, "Initial state must be Registration (0)");
        assert.equal(count.toNumber(), 0, "Candidates count must initialize to 0");
        assert.equal(totalVotes.toNumber(), 0, "Total votes cast must initialize to 0");
    });

    it("ST-02: Deployer is correctly assigned as admin", async () => {
        const contractAdmin = await election.admin();

        assert.equal(contractAdmin, admin, "Admin must match deployer address");
    });

    // ------------------------------------------------------------------------
    // Candidate Management & Access Control
    // ------------------------------------------------------------------------

    it("ST-03: Non-admin cannot add candidate (reverts)", async () => {
        await assertRevert(
            election.addCandidate("Alice", "Party A", { from: attacker }),
            "Caller is not the election admin"
        );
    });

    it("ST-04: Admin cannot add candidate with empty name or party", async () => {
        await assertRevert(
            election.addCandidate("", "Party A", { from: admin }),
            "Candidate name cannot be empty"
        );
        await assertRevert(
            election.addCandidate("Alice", "", { from: admin }),
            "Candidate party cannot be empty"
        );
    });

    it("ST-05: Admin can add candidates and emits CandidateAdded event", async () => {
        const receipt1 = await election.addCandidate("Alice Smith", "Technocrat Party", { from: admin });
        assert.equal(receipt1.logs.length, 1, "One event should be emitted");
        assert.equal(receipt1.logs[0].event, "CandidateAdded");
        assert.equal(receipt1.logs[0].args.candidateId.toNumber(), 1);
        assert.equal(receipt1.logs[0].args.name, "Alice Smith");
        assert.equal(receipt1.logs[0].args.party, "Technocrat Party");

        const receipt2 = await election.addCandidate("Bob Jones", "Progressive Party", { from: admin });
        assert.equal(receipt2.logs.length, 1);
        assert.equal(receipt2.logs[0].event, "CandidateAdded");
        assert.equal(receipt2.logs[0].args.candidateId.toNumber(), 2);
        assert.equal(receipt2.logs[0].args.name, "Bob Jones");
        assert.equal(receipt2.logs[0].args.party, "Progressive Party");

        const count = await election.candidatesCount();
        assert.equal(count.toNumber(), 2, "Candidate count must be 2");

        const c1 = await election.getCandidate(1);
        assert.equal(c1.id.toNumber(), 1);
        assert.equal(c1.name, "Alice Smith");
        assert.equal(c1.party, "Technocrat Party");
        assert.equal(c1.voteCount.toNumber(), 0);
    });

    // ------------------------------------------------------------------------
    // Voter Eligibility Whitelist
    // ------------------------------------------------------------------------

    it("ST-06: Non-admin cannot register an eligible voter (reverts)", async () => {
        await assertRevert(
            election.registerVoter(eligibleVoter1, { from: attacker }),
            "Caller is not the election admin"
        );
    });

    it("ST-07: Admin can register eligible voters individually and in batch", async () => {
        const receipt = await election.registerVoter(eligibleVoter1, { from: admin });
        assert.equal(receipt.logs.length, 1);
        assert.equal(receipt.logs[0].event, "VoterRegistered");
        assert.equal(receipt.logs[0].args.voter, eligibleVoter1);

        let isEligible1 = await election.isVoterEligible(eligibleVoter1);
        let isEligible2 = await election.isVoterEligible(eligibleVoter2);
        assert.isTrue(isEligible1, "Voter 1 should be eligible");
        assert.isFalse(isEligible2, "Voter 2 should not be eligible yet");

        // Batch registration
        await election.registerVoters([eligibleVoter2, attacker], { from: admin });
        isEligible2 = await election.isVoterEligible(eligibleVoter2);
        assert.isTrue(isEligible2, "Voter 2 should be eligible after batch");

        const totalEligible = await election.eligibleVotersCount();
        assert.equal(totalEligible.toNumber(), 3, "Total eligible voters count should match");
    });

    it("ST-08: Admin cannot register zero address or duplicate voter", async () => {
        await assertRevert(
            election.registerVoter("0x0000000000000000000000000000000000000000", { from: admin }),
            "Invalid voter address"
        );

        await election.registerVoter(eligibleVoter1, { from: admin });
        await assertRevert(
            election.registerVoter(eligibleVoter1, { from: admin }),
            "Voter is already registered as eligible"
        );
    });

    // ------------------------------------------------------------------------
    // Election Lifecycle & Pre-Voting Invariants
    // ------------------------------------------------------------------------

    it("ST-09: Non-admin cannot start election (reverts)", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });

        await assertRevert(
            election.startElection({ from: attacker }),
            "Caller is not the election admin"
        );
    });

    it("ST-10: Cannot start election with fewer than 2 candidates", async () => {
        // 0 candidates
        await assertRevert(
            election.startElection({ from: admin }),
            "At least 2 candidates required"
        );

        // 1 candidate
        await election.addCandidate("Alice", "Party A", { from: admin });
        await assertRevert(
            election.startElection({ from: admin }),
            "At least 2 candidates required"
        );
    });

    it("ST-11: Whitelisted voter cannot vote before election starts (Registration state)", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.registerVoter(eligibleVoter1, { from: admin });

        await assertRevert(
            election.vote(1, { from: eligibleVoter1 }),
            "Invalid election state for this operation"
        );
    });

    it("ST-12: Admin can start election and emits ElectionStarted event", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });

        const receipt = await election.startElection({ from: admin });
        assert.equal(receipt.logs.length, 1);
        assert.equal(receipt.logs[0].event, "ElectionStarted");

        const state = await election.getElectionState();
        assert.equal(state.toNumber(), 1, "State should be Voting (1)");
    });

    it("ST-13: Admin cannot add candidates or voters after election starts", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.startElection({ from: admin });

        await assertRevert(
            election.addCandidate("Charlie", "Party C", { from: admin }),
            "Invalid election state for this operation"
        );

        await assertRevert(
            election.registerVoter(eligibleVoter1, { from: admin }),
            "Invalid election state for this operation"
        );
    });

    // ------------------------------------------------------------------------
    // Voting Mechanics, Whitelist Enforcement, and Double-Voting
    // ------------------------------------------------------------------------

    it("ST-14: Ineligible voter cannot vote during active election (reverts)", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.registerVoter(eligibleVoter1, { from: admin });
        await election.startElection({ from: admin });

        await assertRevert(
            election.vote(1, { from: ineligibleVoter }),
            "Voter is not eligible to vote"
        );
    });

    it("ST-15: Eligible voter can vote; increments tally and emits VoteCast event", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.registerVoter(eligibleVoter1, { from: admin });
        await election.startElection({ from: admin });

        const receipt = await election.vote(1, { from: eligibleVoter1 });
        
        // Verify VoteCast event
        const voteCastEvent = receipt.logs.find(log => log.event === "VoteCast");
        assert.isOk(voteCastEvent, "VoteCast event should be emitted");
        assert.equal(voteCastEvent.args.voter, eligibleVoter1);
        assert.equal(voteCastEvent.args.candidateId.toNumber(), 1);

        // Verify voter marked as voted
        const hasVoted = await election.hasVoterVoted(eligibleVoter1);
        assert.isTrue(hasVoted, "Voter status must be marked as hasVoted = true");

        // Verify candidate vote tally
        const c1 = await election.getCandidate(1);
        assert.equal(c1.voteCount.toNumber(), 1, "Candidate 1 must have 1 vote");

        const c2 = await election.getCandidate(2);
        assert.equal(c2.voteCount.toNumber(), 0, "Candidate 2 must have 0 votes");

        const totalVotes = await election.totalVotesCast();
        assert.equal(totalVotes.toNumber(), 1, "Total votes cast must be 1");
    });

    it("ST-16: Eligible voter cannot vote twice (double-voting prevention)", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.registerVoter(eligibleVoter1, { from: admin });
        await election.startElection({ from: admin });

        // First vote succeeds
        await election.vote(1, { from: eligibleVoter1 });

        // Second vote must revert
        await assertRevert(
            election.vote(2, { from: eligibleVoter1 }),
            "Voter has already cast a ballot"
        );

        // Tally must remain unchanged
        const c1 = await election.getCandidate(1);
        const c2 = await election.getCandidate(2);
        assert.equal(c1.voteCount.toNumber(), 1);
        assert.equal(c2.voteCount.toNumber(), 0);
    });

    it("ST-17: Voting for an invalid candidate ID reverts", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.registerVoter(eligibleVoter1, { from: admin });
        await election.startElection({ from: admin });

        // Candidate ID 0
        await assertRevert(
            election.vote(0, { from: eligibleVoter1 }),
            "Invalid candidate ID"
        );

        // Candidate ID 99 (out of range)
        await assertRevert(
            election.vote(99, { from: eligibleVoter1 }),
            "Invalid candidate ID"
        );
    });

    // ------------------------------------------------------------------------
    // Election Conclusion & Post-Election Invariants
    // ------------------------------------------------------------------------

    it("ST-18: Non-admin cannot end election (reverts)", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.startElection({ from: admin });

        await assertRevert(
            election.endElection({ from: attacker }),
            "Caller is not the election admin"
        );
    });

    it("ST-19: Admin can end election and emits ElectionEnded event", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.startElection({ from: admin });

        const receipt = await election.endElection({ from: admin });
        assert.equal(receipt.logs.length, 1);
        assert.equal(receipt.logs[0].event, "ElectionEnded");

        const state = await election.getElectionState();
        assert.equal(state.toNumber(), 2, "State should be Ended (2)");
    });

    it("ST-20: Eligible voter cannot vote after election has ended (reverts)", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });
        await election.registerVoter(eligibleVoter1, { from: admin });
        await election.startElection({ from: admin });
        await election.endElection({ from: admin });

        await assertRevert(
            election.vote(1, { from: eligibleVoter1 }),
            "Invalid election state for this operation"
        );
    });

    it("ST-21: State transition abuse is prevented (cannot restart or jump states)", async () => {
        await election.addCandidate("Alice", "Party A", { from: admin });
        await election.addCandidate("Bob", "Party B", { from: admin });

        // Cannot end election while still in Registration
        await assertRevert(
            election.endElection({ from: admin }),
            "Invalid election state for this operation"
        );

        await election.startElection({ from: admin });

        // Cannot start election again while in Voting
        await assertRevert(
            election.startElection({ from: admin }),
            "Invalid election state for this operation"
        );

        await election.endElection({ from: admin });

        // Cannot restart election after Ended
        await assertRevert(
            election.startElection({ from: admin }),
            "Invalid election state for this operation"
        );

        // Cannot end election again after Ended
        await assertRevert(
            election.endElection({ from: admin }),
            "Invalid election state for this operation"
        );
    });
});