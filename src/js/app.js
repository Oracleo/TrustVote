App = {
    web3Provider: null,
    contracts: {},
    account: '0x0',
    adminAddress: '0x0',
    isAdmin: false,
    isEligible: false,
    hasVoted: false,
    electionState: 0, // 0: Registration, 1: Voting, 2: Ended
    candidatesCount: 0,
    hasWallet: false,
    stateNames: ["Registration Phase", "Voting Phase (Active)", "Election Ended (Sealed)"],

    // HTML-escape on-chain strings (candidate name/party are admin-entered and
    // injected into the DOM; never trust them raw).
    escapeHtml: function (text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    },

    init: async function () {
        return await App.initWeb3();
    },

    initWeb3: async function () {
        // Modern dapp browsers with EIP-1193
        if (window.ethereum) {
            App.web3Provider = window.ethereum;
            try {
                // Don't wait forever for MetaMask: if a connection/unlock request is
                // sitting pending in the extension, resolve after 8s and let the page
                // render (the accountsChanged listener re-renders once approved).
                const accounts = await Promise.race([
                    window.ethereum.request({ method: 'eth_requestAccounts' }),
                    new Promise(function (resolve) {
                        setTimeout(function () {
                            console.info("MetaMask connection request still pending — rendering without an account. Open MetaMask to approve, then reload if needed.");
                            resolve([]);
                        }, 8000);
                    })
                ]);
                if (accounts && accounts.length > 0) {
                    App.account = accounts[0];
                }
            } catch (error) {
                console.error("MetaMask connection rejected by user:", error);
            }
            App.hasWallet = true;

            // Auto-reload on account change
            window.ethereum.on('accountsChanged', function (accounts) {
                if (accounts.length > 0) {
                    App.account = accounts[0];
                } else {
                    App.account = '0x0';
                }
                App.render();
            });

            // Auto-reload on chain/network change
            window.ethereum.on('chainChanged', function () {
                window.location.reload();
            });
        }
        // Legacy web3 providers...
        else if (window.web3) {
            App.web3Provider = window.web3.currentProvider;
        }
        // Local Ganache fallback
        else {
            App.web3Provider = new Web3.providers.HttpProvider('http://127.0.0.1:7545');
            App.hasWallet = false;
        }

        web3 = new Web3(App.web3Provider);
        return App.initContract();
    },

    initContract: function () {
        $.getJSON("Election.json", function (electionArtifact) {
            App.contracts.Election = TruffleContract(electionArtifact);
            App.contracts.Election.setProvider(App.web3Provider);

            App.listenForEvents();
            return App.render();
        }).fail(function (err) {
            console.error("Failed to load Election.json artifact:", err);
            $("#loader").hide();
            $("#content").show();
            var alertHtml = '<div class="alert alert-danger" style="margin: 20px;">' +
                '<strong>Contract Error:</strong> Could not load Election.json artifact. ' +
                'Ensure <code>truffle migrate --reset</code> has been executed and Ganache is running on 127.0.0.1:7545.' +
                '</div>';
            $("#content").prepend(alertHtml);
        });
    },

    listenForEvents: function () {
        App.contracts.Election.deployed().then(function (instance) {
            if (instance.VoteCast) {
                instance.VoteCast({}, { fromBlock: 'latest' }).watch(function (error, event) {
                    if (!error) {
                        console.log("On-chain VoteCast event received:", event);
                    }
                });
            }
        }).catch(function (err) {
            console.warn("Event subscription notice:", err);
        });
    },

    render: async function () {
        // UI-only guard: serialize concurrent renders (e.g. MetaMask
        // accountsChanged firing during the initial load) so async renders
        // never interleave and duplicate candidate rows. Logic is unchanged.
        if (App._renderInFlight) {
            App._renderQueued = true;
            return;
        }
        App._renderInFlight = true;

        var loader = $("#loader");
        var content = $("#content");

        loader.show();
        content.hide();

        try {
            // Re-fetch the ACTIVE MetaMask account on every render so that switching
            // accounts in MetaMask is always reflected, even if the site was only
            // granted access to a subset of accounts (common when accounts were
            // imported after the site was first connected).
            if (App.hasWallet && window.ethereum && window.ethereum.request) {
                try {
                    var activeAccounts = await window.ethereum.request({ method: 'eth_accounts' });
                    if (activeAccounts && activeAccounts.length > 0) {
                        App.account = activeAccounts[0];
                    } else {
                        App.account = '0x0';
                    }
                } catch (e) {
                    console.warn("Could not re-fetch active account:", e);
                }
            }

            // Retrieve current coinbase if not already set
            if (!App.account || App.account === '0x0') {
                var accounts = await new Promise(function (resolve) {
                    web3.eth.getAccounts(function (err, accs) {
                        resolve(accs && accs.length > 0 ? accs : ['0x0']);
                    });
                });
                App.account = accounts[0];
            }

            var instance = await App.contracts.Election.deployed();

            // Fetch on-chain election state
            var stateNum = await instance.getElectionState();
            App.electionState = stateNum.toNumber();

            // Fetch admin address
            var adminAddr = await instance.admin();
            App.adminAddress = adminAddr;
            App.isAdmin = (App.account && adminAddr && App.account.toLowerCase() === adminAddr.toLowerCase());

            // Fetch voter status for connected wallet
            App.isEligible = await instance.isVoterEligible(App.account);
            App.hasVoted = await instance.hasVoterVoted(App.account);

            // Fetch counts
            var count = await instance.candidatesCount();
            App.candidatesCount = count.toNumber();

            var totalVotes = await instance.totalVotesCast();
            var eligibleCount = await instance.eligibleVotersCount();

            // ----------------------------------------------------------------
            // Whitelisted voters list (admin panel) — read from VoterRegistered
            // event logs so the panel shows every authorized address.
            // ----------------------------------------------------------------
            $("#whitelistedVotersList").html("");
            try {
                instance.VoterRegistered({}, { fromBlock: 0, toBlock: 'latest' }).get(function (voterListErr, events) {
                    if (voterListErr) {
                        console.warn("Could not load whitelisted voter list:", voterListErr);
                        return;
                    }
                    if (!events || events.length === 0) {
                        return;
                    }
                    var voterItems = "";
                    for (var v = 0; v < events.length; v++) {
                        var voterAddr = events[v].args.voter;
                        voterItems += '<li class="list-group-item" style="padding: 4px 10px; font-family: monospace; font-size: 12px; word-break: break-all;">' + App.escapeHtml(voterAddr) + '</li>';
                    }
                    $("#whitelistedVotersList").html('<ul class="list-group" style="margin-top: 10px; max-height: 220px; overflow-y: auto;">' + voterItems + '</ul>');
                });
            } catch (voterListSetupErr) {
                console.warn("Could not load whitelisted voter list:", voterListSetupErr);
            }

            // ----------------------------------------------------------------
            // Update UI Elements
            // ----------------------------------------------------------------

            // Display connected wallet + inline account controls
            $("#accountAddress").html(
                "Connected Wallet: <code>" + App.account + "</code> " +
                '<button type="button" class="btn btn-sm btn-outline-secondary" style="font-size: 11px; padding: 2px 8px; vertical-align: middle;" onclick="App.switchAccount()">Switch Account</button> ' +
                '<button type="button" class="btn btn-sm btn-outline-secondary" style="font-size: 11px; padding: 2px 8px; vertical-align: middle;" onclick="window.location.reload()">Reload</button>'
            );
            $("#accountBadge").html(App.account);

            // Admin vs Voter status display
            if (App.isAdmin) {
                $("#roleBadge").html('<span class="badge bg-danger" style="background-color: #f82249; padding: 6px 12px; border-radius: 4px; font-weight: bold;">ELECTION ADMIN</span>');
                $("#adminAlert").html('<div class="alert alert-info">Connected as <strong>Election Administrator</strong>. You have permissions to manage candidates, voter whitelist, and election lifecycle.</div>');
                $(".admin-only").show();
            } else {
                $("#roleBadge").html('<span class="badge bg-secondary" style="background-color: #404041; padding: 6px 12px; border-radius: 4px;">VOTER WALLET</span>');
                $("#adminAlert").html(
                    '<div class="alert alert-warning">' +
                    'Connected as <strong>Standard Voter</strong>. Administrative actions are restricted at the smart-contract layer.<br/>' +
                    '<span style="font-size: 13px;">Voting happens on the <strong>Vote page</strong> &mdash; not here. Make sure MetaMask has your whitelisted voter account selected.</span><br/>' +
                    '<a href="vote.html" class="btn btn-sm" style="background-color: #f82249; color: #fff; font-weight: 600; margin: 8px 8px 0 0;">Go to Vote Page &rarr;</a>' +
                    '<button type="button" class="btn btn-sm btn-outline-secondary" style="margin-top: 8px;" onclick="App.switchAccount()">Switch Account</button>' +
                    '</div>'
                );
                $(".admin-only").hide();
            }

            // Election state display
            var stateBadgeClass = "bg-warning";
            if (App.electionState === 1) stateBadgeClass = "bg-success";
            if (App.electionState === 2) stateBadgeClass = "bg-secondary";

            var stateText = App.stateNames[App.electionState];
            $("#electionStateBadge").html('<span class="badge ' + stateBadgeClass + '" style="font-size: 14px; padding: 6px 12px;">' + stateText + '</span>');
            $("#electionStatusText").text(stateText);

            // Eligibility & Voting Status
            var eligibilityText = "";
            if (App.isEligible) {
                if (App.hasVoted) {
                    eligibilityText = '<div class="alert alert-success" style="font-size: 15px;"><strong>Status:</strong> Whitelisted | <strong>Ballot:</strong> CAST (Double-voting is prevented)</div>';
                } else {
                    eligibilityText = '<div class="alert alert-primary" style="background-color: #e8f4fd; color: #0c5460; font-size: 15px;"><strong>Status:</strong> Whitelisted Eligible Voter | <strong>Ballot:</strong> NOT CAST YET</div>';
                }
            } else {
                eligibilityText = '<div class="alert alert-warning" style="font-size: 15px;"><strong>Status:</strong> NOT WHITELISTED. Your address must be registered by the Election Admin before casting a vote.</div>';
            }
            $("#voterEligibilityBox").html(eligibilityText);

            // Admin-panel link is only relevant to the admin wallet.
            // Class-based toggle so the desktop nav, the mobile nav clone
            // (created by main.js), and the portal action card all stay in
            // sync. UI visibility only.
            if (App.isAdmin) {
                $('.admin-only-link, .eci-admin-gated').show();
            } else {
                $('.admin-only-link, .eci-admin-gated').hide();
            }

            // Stat counters (if present on page)
            $("#statCandidatesCount").text(App.candidatesCount);
            $("#statEligibleCount").text(eligibleCount.toNumber());
            $("#statVotesCast").text(totalVotes.toNumber());

            // Presentation-layer sync (widget.js): mirror the already-fetched
            // on-chain state into the ECI live widget and voter greeting.
            if (window.EciUI) {
                if (EciUI._lastAccount !== App.account) {
                    EciUI.congratsVisible = false;
                    EciUI._lastAccount = App.account;
                }
                EciUI.state.state = App.electionState;
                EciUI.state.eligible = eligibleCount.toNumber();
                EciUI.state.cast = totalVotes.toNumber();
                EciUI.state.candidates = App.candidatesCount;
                EciUI.state.account = App.account;
                EciUI.state.isAdmin = App.isAdmin;
                EciUI.state.isEligible = App.isEligible;
                EciUI.state.hasVoted = App.hasVoted;
                EciUI.paintWidget();
                EciUI.renderGreeting();
                if ($("#eciScheduleForm").length) {
                    EciUI.initScheduleForm();
                }
                EciUI.maybeResumeVoteRecord();
                if ($("#eciBarChart").length) {
                    EciUI.decorateResults();
                }
            }

            // ----------------------------------------------------------------
            // Populate Candidate Tables & Select Dropdowns
            // ----------------------------------------------------------------
            var candidatesResults = $("#candidatesResults");
            var candidatesSelect = $('#candidatesSelect');
            candidatesResults.empty();
            candidatesSelect.empty();

            if (App.candidatesCount === 0) {
                candidatesResults.append("<tr><td colspan='4' class='text-center'>No candidates registered yet.</td></tr>");
                candidatesSelect.append("<option value=''>No candidates available</option>");
            }

            for (var i = 1; i <= App.candidatesCount; i++) {
                var candidate = await instance.candidates(i);
                var id = candidate[0].toNumber();
                var name = candidate[1];
                var party = candidate[2];
                var voteCount = candidate[3].toNumber();

                // Candidate Table Row (escaped: name/party are free-text strings)
                var candidateTemplate = "<tr>" +
                    "<th>" + id + "</th>" +
                    "<td><strong>" + App.escapeHtml(name) + "</strong></td>" +
                    "<td>" + App.escapeHtml(party) + "</td>" +
                    "<td>" + voteCount + "</td>" +
                    "</tr>";
                candidatesResults.append(candidateTemplate);

                // Candidate Dropdown Option
                var candidateOption = "<option value='" + id + "'>#" + id + " - " + App.escapeHtml(name) + " (" + App.escapeHtml(party) + ")</option>";
                candidatesSelect.append(candidateOption);
            }

            // ----------------------------------------------------------------
            // Contextual Form Controls Based on State and Eligibility
            // ----------------------------------------------------------------
            var voteForm = $("#voteForm");
            var voteNotice = $("#voteNotice");

            if (App.electionState === 0) {
                voteForm.hide();
                voteNotice.html('<div class="alert alert-warning"><strong>Notice:</strong> The election is currently in the <strong>Registration Phase</strong>. Voting has not opened yet.</div>').show();
            } else if (App.electionState === 2) {
                voteForm.hide();
                voteNotice.html('<div class="alert alert-info"><strong>Notice:</strong> The election has <strong>Ended</strong>. Ballots are sealed. View final tallies below.</div>').show();
            } else if (App.electionState === 1) {
                if (!App.isEligible) {
                    voteForm.hide();
                    if (App.isAdmin) {
                        voteNotice.html('<div class="alert alert-info"><strong>Admin Wallet:</strong> The administrator wallet is not a voter and cannot cast a ballot. Use the <strong>Switch Account</strong> button above to change to a whitelisted voter account.</div>').show();
                    } else {
                        voteNotice.html('<div class="alert alert-danger"><strong>Ineligible Address:</strong> This wallet (' + App.account.substring(0, 8) + '...) is not on the voter whitelist. Direct contract voting calls will revert.</div>').show();
                    }
                } else if (App.hasVoted) {
                    voteForm.hide();
                    // While the congratulations screen is up, keep this notice
                    // from overwriting it (presentation only).
                    if (!(window.EciUI && EciUI.congratsVisible)) {
                        voteNotice.html('<div class="alert alert-success"><strong>Vote Recorded:</strong> You have already cast your ballot. The contract rejects duplicate votes.</div>').show();
                    }
                } else {
                    voteNotice.hide();
                    voteForm.show();
                }
            }

            // Admin lifecycle button states (only meaningful for the admin wallet)
            if (!App.isAdmin) {
                $("#btnStartElection, #btnEndElection").prop("disabled", true);
                $("#addCandidateSection, #whitelistSection").hide();
                $("#adminSwitchVoterHint").hide();
            } else if (App.electionState === 0) {
                $("#btnStartElection").prop("disabled", false).text("Start Election (Open Voting)");
                $("#btnEndElection").prop("disabled", true).text("End Election");
                $("#addCandidateSection").show();
                $("#whitelistSection").show();
                $("#adminSwitchVoterHint").hide();
            } else if (App.electionState === 1) {
                $("#btnStartElection").prop("disabled", true).text("Election Already Active");
                $("#btnEndElection").prop("disabled", false).text("End Election (Close Voting)");
                $("#addCandidateSection").hide();
                $("#whitelistSection").hide();
                // Admin + active voting: point to the voter account / vote page
                // (the admin wallet itself can never cast a ballot).
                $("#adminSwitchVoterHint").show();
            } else {
                $("#btnStartElection").prop("disabled", true).text("Election Concluded");
                $("#btnEndElection").prop("disabled", true).text("Election Concluded");
                $("#addCandidateSection").hide();
                $("#whitelistSection").hide();
                $("#adminSwitchVoterHint").hide();
            }

            loader.hide();
            content.show();

            App._releaseRenderLock();

        } catch (error) {
            console.error("Rendering error:", error);
            loader.hide();
            content.show();
            $("#content").prepend('<div class="alert alert-danger"><strong>Error communicating with contract:</strong> ' + (error.message || error) + '</div>');
            App._releaseRenderLock();
        }
    },

    // UI-only: release the render mutex and run a coalesced re-render if one
    // was requested while a render was in flight.
    _releaseRenderLock: function () {
        App._renderInFlight = false;
        if (App._renderQueued) {
            App._renderQueued = false;
            App.render();
        }
    },

    // ------------------------------------------------------------------------
    // Voting Operation
    // ------------------------------------------------------------------------
    castVote: async function () {
        var candidateId = $('#candidatesSelect').val();
        if (!candidateId) {
            alert("Please select a valid candidate.");
            return;
        }
        var selectedLabel = $('#candidatesSelect option:selected').text();

        $("#txStatus").html('<div class="alert alert-info">Submitting transaction to Ethereum network via MetaMask... Please confirm in your wallet.</div>');

        try {
            var instance = await App.contracts.Election.deployed();
            var receipt = await instance.vote(candidateId, { from: App.account });
            console.log("Vote transaction confirmed:", receipt);

            if (window.EciUI) {
                // Celebrate: congratulations screen with the confirmed
                // transaction record + 10-second auto account switch
                // (presentation only; the vote tx itself is the record).
                EciUI.captureVoteReceipt(receipt, selectedLabel);
            } else {
                $("#txStatus").html(
                    '<div class="alert alert-success">' +
                    '<strong>Vote Confirmed On Blockchain!</strong><br/>' +
                    'Tx Hash: <code>' + receipt.tx + '</code><br/>' +
                    'Block Number: ' + receipt.receipt.blockNumber + '<br/>' +
                    'Gas Used: ' + receipt.receipt.gasUsed +
                    '</div>'
                );
            }

            // Re-render UI to update status
            await App.render();
        } catch (err) {
            console.error("Vote failed:", err);
            var reason = App.extractRevertReason(err);
            $("#txStatus").html(
                '<div class="alert alert-danger">' +
                '<strong>Transaction Failed / Reverted by Smart Contract:</strong><br/>' +
                reason +
                '</div>'
            );
        }
    },

    // ------------------------------------------------------------------------
    // Candidate Addition (Admin Only)
    // ------------------------------------------------------------------------
    addCandidate: async function () {
        var name = $('#candidateName').val();
        var party = $('#candidateParty').val();

        if (!name || !name.trim()) {
            alert("Candidate name is required.");
            return;
        }
        if (!party || !party.trim()) {
            alert("Party name is required.");
            return;
        }

        $("#adminTxStatus").html('<div class="alert alert-info">Submitting candidate registration to blockchain... Please confirm in MetaMask.</div>');

        try {
            var instance = await App.contracts.Election.deployed();
            var receipt = await instance.addCandidate(name.trim(), party.trim(), { from: App.account });
            console.log("Candidate added successfully:", receipt);

            $("#adminTxStatus").html(
                '<div class="alert alert-success">' +
                '<strong>Candidate Added Successfully!</strong> Tx: <code>' + receipt.tx.substring(0, 16) + '...</code>' +
                '</div>'
            );

            $('#candidateName').val('');
            $('#candidateParty').val('');

            await App.render();
        } catch (err) {
            console.error("Candidate addition failed:", err);
            var reason = App.extractRevertReason(err);
            $("#adminTxStatus").html('<div class="alert alert-danger"><strong>Error Adding Candidate:</strong> ' + reason + '</div>');
        }
    },

    // ------------------------------------------------------------------------
    // Voter Whitelist Registration (Admin Only)
    // ------------------------------------------------------------------------
    registerVoter: async function () {
        var voterAddress = $('#voterAddressInput').val();
        if (!voterAddress || !web3.isAddress(voterAddress.trim())) {
            alert("Please enter a valid Ethereum hex address (0x...)");
            return;
        }

        $("#adminTxStatus").html('<div class="alert alert-info">Registering voter address on blockchain... Please confirm in MetaMask.</div>');

        try {
            var instance = await App.contracts.Election.deployed();
            var receipt = await instance.registerVoter(voterAddress.trim(), { from: App.account });
            console.log("Voter registered:", receipt);

            $("#adminTxStatus").html(
                '<div class="alert alert-success">' +
                '<strong>Voter Registered on Whitelist!</strong> Address: <code>' + voterAddress.trim() + '</code>' +
                '</div>'
            );

            $('#voterAddressInput').val('');
            await App.render();
        } catch (err) {
            console.error("Voter registration failed:", err);
            var reason = App.extractRevertReason(err);
            $("#adminTxStatus").html('<div class="alert alert-danger"><strong>Error Registering Voter:</strong> ' + reason + '</div>');
        }
    },

    // ------------------------------------------------------------------------
    // Election Lifecycle (Admin Only)
    // ------------------------------------------------------------------------
    startElection: async function () {
        if (!confirm("Are you sure you want to START the election? Once active, candidate additions and voter registration will close.")) {
            return;
        }

        $("#adminTxStatus").html('<div class="alert alert-info">Starting election on blockchain... Please confirm transaction in MetaMask.</div>');

        try {
            var instance = await App.contracts.Election.deployed();
            var receipt = await instance.startElection({ from: App.account });
            console.log("Election started:", receipt);

            $("#adminTxStatus").html(
                '<div class="alert alert-success">' +
                '<strong>Election Started! Voting is now active.</strong>' +
                '</div>'
            );

            await App.render();
        } catch (err) {
            console.error("Failed to start election:", err);
            var reason = App.extractRevertReason(err);
            $("#adminTxStatus").html('<div class="alert alert-danger"><strong>Failed to Start Election:</strong> ' + reason + '</div>');
        }
    },

    endElection: async function () {
        if (!confirm("Are you sure you want to END the election? Once concluded, no further votes can be cast.")) {
            return;
        }

        $("#adminTxStatus").html('<div class="alert alert-info">Ending election on blockchain... Please confirm transaction in MetaMask.</div>');

        try {
            var instance = await App.contracts.Election.deployed();
            var receipt = await instance.endElection({ from: App.account });
            console.log("Election ended:", receipt);

            $("#adminTxStatus").html(
                '<div class="alert alert-success">' +
                '<strong>Election Concluded! Final vote tally is permanently sealed.</strong>' +
                '</div>'
            );

            await App.render();
        } catch (err) {
            console.error("Failed to end election:", err);
            var reason = App.extractRevertReason(err);
            $("#adminTxStatus").html('<div class="alert alert-danger"><strong>Failed to End Election:</strong> ' + reason + '</div>');
        }
    },

    // ------------------------------------------------------------------------
    // Account Switching (MetaMask permission re-request)
    // ------------------------------------------------------------------------
    switchAccount: async function () {
        if (!App.hasWallet || !window.ethereum || !window.ethereum.request) {
            alert("This page is not connected to MetaMask. Start MetaMask and reload.");
            return;
        }
        try {
            // Reopening the permissions dialog lets the user pick a different
            // account. Works on MetaMask 10+; no-op error on older builds.
            await window.ethereum.request({
                method: 'wallet_requestPermissions',
                params: [{ eth_accounts: {} }]
            });
            var accounts = await window.ethereum.request({ method: 'eth_accounts' });
            if (accounts && accounts.length > 0) {
                App.account = accounts[0];
            }
            await App.render();
        } catch (err) {
            console.warn("switchAccount rejected or unsupported:", err);
            // Fallback: user can still switch inside MetaMask manually, then Reload.
            alert("Could not open the account picker. Switch the account inside MetaMask, then click Reload on this page.");
        }
    },

    // ------------------------------------------------------------------------
    // Error Parser Helper
    // ------------------------------------------------------------------------
    extractRevertReason: function (error) {
        if (!error) return "Unknown error occurred";
        var msg = error.message || error.toString();
        
        // Check for specific revert string in message
        var match = msg.match(/reason:\s*([^\n\r]+)/i) ||
                    msg.match(/revert\s+([^\n\r"]+)/i) ||
                    msg.match(/Error:\s*VM Exception while processing transaction:\s*revert\s*([^\n\r"]*)/i);
        if (match && match[1]) {
            return match[1].trim();
        }
        if (msg.includes("TrustVote:")) {
            var parts = msg.split("TrustVote:");
            if (parts.length > 1) {
                return "TrustVote: " + parts[1].split('"')[0].split('\n')[0].trim();
            }
        }
        if (msg.includes("User denied transaction signature")) {
            return "Transaction cancelled: User rejected signature in MetaMask.";
        }
        return msg;
    }
};

$(function () {
    // Initialize as soon as the DOM is ready — do NOT wait for window.load,
    // which blocks on every external asset (fonts, CDNs) and can leave the
    // page on the spinner forever if any one of them is slow or blocked.
    App.init();

    // Watchdog: if the loader is still showing after 12s, surface a hint
    // instead of spinning silently.
    setTimeout(function () {
        if ($("#loader").is(":visible") && !$("#content").is(":visible")) {
            $("#loader").hide();
            $("#content").show();
            $("#content").prepend(
                '<div class="alert alert-warning"><strong>Page did not finish loading.</strong> '
                + 'Most likely a MetaMask connection request is waiting for your approval — open the MetaMask extension, unlock it, '
                + 'make sure the <strong>Ganache Local</strong> network (127.0.0.1:7545) is selected, then reload this page. '
                + 'A blocked internet connection (fonts/CDN scripts) can also cause this.</div>'
            );
        }
    }, 12000);
});

