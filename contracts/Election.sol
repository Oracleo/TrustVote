pragma solidity ^0.5.16;

contract Election {
    // ------------------------------------------------------------------------
    // Election State
    // ------------------------------------------------------------------------
    // Registration : admin adds candidates and registers eligible voters
    // Voting       : eligible voters may cast exactly one ballot
    // Ended        : terminal state; final tally stays in blockchain state
    //
    // Allowed transitions: Registration -> Voting -> Ended (no reverse transitions)

    enum ElectionState {
        Registration,
        Voting,
        Ended
    }

    ElectionState public state;

    address public admin;

    struct Candidate {
        uint id;
        string name;
        string party;
        uint voteCount;
    }

    uint public candidatesCount;
    mapping(uint => Candidate) public candidates;

    // Voter eligibility whitelist (who MAY vote) - kept separate from hasVoted (who DID vote)
    mapping(address => bool) public eligibleVoters;
    uint public eligibleVotersCount;

    // One ballot per eligible address
    mapping(address => bool) public hasVoted;
    uint public totalVotesCast;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    event CandidateAdded(uint indexed candidateId, string name, string party);
    event VoterRegistered(address indexed voter);
    event ElectionStarted();
    event ElectionEnded();
    event VoteCast(address indexed voter, uint indexed candidateId);

    // ------------------------------------------------------------------------
    // Modifiers (access control and lifecycle guards)
    // ------------------------------------------------------------------------

    modifier onlyAdmin() {
        require(msg.sender == admin, "TrustVote: Caller is not the election admin");
        _;
    }

    modifier inState(ElectionState _expectedState) {
        require(state == _expectedState, "TrustVote: Invalid election state for this operation");
        _;
    }

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    constructor() public {
        admin = msg.sender;
        state = ElectionState.Registration;
    }

    // ------------------------------------------------------------------------
    // Candidate Management (admin only, Registration state only)
    // ------------------------------------------------------------------------

    function addCandidate(string memory _name, string memory _party)
        public
        onlyAdmin
        inState(ElectionState.Registration)
    {
        require(bytes(_name).length > 0, "TrustVote: Candidate name cannot be empty");
        require(bytes(_party).length > 0, "TrustVote: Candidate party cannot be empty");

        candidatesCount++;
        candidates[candidatesCount] = Candidate({
            id: candidatesCount,
            name: _name,
            party: _party,
            voteCount: 0
        });

        emit CandidateAdded(candidatesCount, _name, _party);
    }

    // ------------------------------------------------------------------------
    // Voter Eligibility Management (admin only, Registration state only)
    // ------------------------------------------------------------------------

    function registerVoter(address _voter)
        public
        onlyAdmin
        inState(ElectionState.Registration)
    {
        require(_voter != address(0), "TrustVote: Invalid voter address");
        require(!eligibleVoters[_voter], "TrustVote: Voter is already registered as eligible");

        eligibleVoters[_voter] = true;
        eligibleVotersCount++;

        emit VoterRegistered(_voter);
    }

    function registerVoters(address[] memory _voters)
        public
        onlyAdmin
        inState(ElectionState.Registration)
    {
        for (uint i = 0; i < _voters.length; i++) {
            address voter = _voters[i];
            if (voter != address(0) && !eligibleVoters[voter]) {
                eligibleVoters[voter] = true;
                eligibleVotersCount++;
                emit VoterRegistered(voter);
            }
        }
    }

    // ------------------------------------------------------------------------
    // Election Lifecycle (admin only)
    // ------------------------------------------------------------------------

    function startElection()
        public
        onlyAdmin
        inState(ElectionState.Registration)
    {
        require(candidatesCount >= 2, "TrustVote: At least 2 candidates required to start election");
        state = ElectionState.Voting;
        emit ElectionStarted();
    }

    function endElection()
        public
        onlyAdmin
        inState(ElectionState.Voting)
    {
        state = ElectionState.Ended;
        emit ElectionEnded();
    }

    // ------------------------------------------------------------------------
    // Voting (eligible voters, Voting state only)
    // ------------------------------------------------------------------------

    function vote(uint _candidateId)
        public
        inState(ElectionState.Voting)
    {
        require(eligibleVoters[msg.sender], "TrustVote: Voter is not eligible to vote");
        require(!hasVoted[msg.sender], "TrustVote: Voter has already cast a ballot");
        require(_candidateId > 0 && _candidateId <= candidatesCount, "TrustVote: Invalid candidate ID");

        hasVoted[msg.sender] = true;

        candidates[_candidateId].voteCount++;
        totalVotesCast++;

        emit VoteCast(msg.sender, _candidateId);
    }

    // ------------------------------------------------------------------------
    // Public View Helpers
    // ------------------------------------------------------------------------

    function getCandidate(uint _candidateId)
        public
        view
        returns (uint id, string memory name, string memory party, uint voteCount)
    {
        require(_candidateId > 0 && _candidateId <= candidatesCount, "TrustVote: Candidate does not exist");
        Candidate memory c = candidates[_candidateId];
        return (c.id, c.name, c.party, c.voteCount);
    }

    function isVoterEligible(address _voter) public view returns (bool) {
        return eligibleVoters[_voter];
    }

    function hasVoterVoted(address _voter) public view returns (bool) {
        return hasVoted[_voter];
    }

    function getElectionState() public view returns (uint) {
        return uint(state);
    }
}
