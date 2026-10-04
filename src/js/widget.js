/* ============================================================
   TrustVote UI runtime — presentation only.
   Reads the SAME on-chain state App.render() already fetched.
   Adds: live election widget bar, admin schedule countdown,
   voter greeting, post-vote congratulations screen with the
   confirmed transaction record, 10-second auto account-switch,
   and footer contact buttons (address revealed on click only).

   NOTE: contains no contract writes. Voting still flows
   exclusively through App.castVote() in app.js.
   ============================================================ */

(function ($) {
  "use strict";

  if (!$) return;

  var EciUI = window.EciUI || {};

  /* ----------------------------------------------------------
     Small helpers
     ---------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function shortAddr(a) {
    a = String(a || "");
    if (!a || a === "0x0" || a.length < 12) return a || "—";
    return a.slice(0, 6) + "…" + a.slice(-4);
  }

  function fmtWindow(sched) {
    try {
      var d = new Date(sched.start);
      var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return d.getDate() + " " + months[d.getMonth()] + ", " + sched.from;
    } catch (e) { return ""; }
  }

  /* ----------------------------------------------------------
     Schedule (admin-entered date + from/to, localStorage)
     ---------------------------------------------------------- */

  var SCHED_KEY = "trustvote.schedule.v1";

  function readSchedule() {
    try {
      var raw = window.localStorage.getItem(SCHED_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.date || !s.from || !s.to) return null;
      var start = new Date(s.date + "T" + s.from);
      var end = new Date(s.date + "T" + s.to);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
      return { start: start.getTime(), end: end.getTime(), date: s.date, from: s.from, to: s.to };
    } catch (e) {
      return null;
    }
  }

  function saveScheduleObject(s) {
    try {
      window.localStorage.setItem(SCHED_KEY, JSON.stringify(s));
    } catch (e) { /* storage unavailable */ }
  }

  /* ----------------------------------------------------------
     Vote record (captured from the confirmed vote receipt)
     ---------------------------------------------------------- */

  var VOTE_RECORD_KEY = "trustvote.lastVoteRecord.v1";
  var VOTE_RECORD_MAX_AGE = 5 * 60 * 1000; // fresh for 5 minutes

  function saveVoteRecord(rec) {
    try {
      window.localStorage.setItem(VOTE_RECORD_KEY, JSON.stringify(rec));
    } catch (e) { /* ignore */ }
  }

  function readVoteRecord() {
    try {
      var raw = window.localStorage.getItem(VOTE_RECORD_KEY);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || !rec.tx || !rec.at) return null;
      if (Date.now() - rec.at > VOTE_RECORD_MAX_AGE) return null;
      return rec;
    } catch (e) {
      return null;
    }
  }

  /* ----------------------------------------------------------
     Footer buttons — mail / phone revealed on click only
     (addresses are split + reversed in data attributes so they
     never appear as readable text in the page source either)
     ---------------------------------------------------------- */

  function wireFooter() {
    $(document).off("click.wvFooter").on("click.wvFooter", ".eci-f-btn", function (ev) {
      ev.preventDefault();
      var $b = $(this);
      if ($b.data("wv-done")) return;
      $b.data("wv-done", 1);

      var kind = $b.data("kind");
      var a = String($b.data("a") || "").split("").reverse().join("");
      var b = String($b.data("b") || "").split("").reverse().join("");
      var href;

      if (kind === "mail") {
        href = "mailto:" + a + "@" + b;
      } else {
        href = "tel:" + a + b;
      }

      window.location.href = href;
      setTimeout(function () { $b.removeData("wv-done"); }, 1500);
    });
  }

  /* ----------------------------------------------------------
     Copy chips (wallet address, tx hash)
     ---------------------------------------------------------- */

  function wireCopyChips() {
    $(document).off("click.wvCopy").on("click.wvCopy", ".eci-chip[data-copy]", function () {
      var $c = $(this);
      var text = String($c.data("copy") || "");
      var old = $c.html();
      var done = function () {
        $c.html('<i class="fa fa-check"></i> Copied');
        setTimeout(function () { $c.html(old); }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  }

  /* ==========================================================
     Global Live Election Widget
     ========================================================== */

  EciUI.state = {
    state: 0,        // 0 Registration, 1 Voting, 2 Ended (mirrors contract)
    eligible: null,  // eligibleVotersCount
    cast: 0,         // totalVotesCast
    candidates: 0,   // candidatesCount
    account: "0x0",
    isAdmin: false,
    isEligible: false,
    hasVoted: false
  };

  function statTile(value, label) {
    return '<div class="eci-w-stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  }

  function timerShell(icon, initialText, smallText) {
    return '<div class="eci-w-timer">' +
      '<i class="fa ' + icon + ' eci-clock-ic"></i>' +
      '<div><b id="eciWTimer">' + esc(initialText) + '</b><small id="eciWTimerLabel">' + esc(smallText) + '</small></div>' +
      '</div>';
  }

  EciUI.paintWidget = function () {
    var $body = $("#eciWidgetBody");
    if (!$body.length) return;

    var s = EciUI.state;
    var sched = readSchedule();
    var now = Date.now();

    /* State ribbon */
    var cls = "soon";
    var label = "Registration Phase";
    if (s.state === 1) {
      cls = "live";
      label = "VOTING LIVE";
    } else if (s.state === 2) {
      cls = "over";
      label = "Election Ended";
    } else if (s.state === 0 && sched && now >= sched.start) {
      cls = "soon";
      label = "Awaiting Official Start";
    }

    var html =
      '<div class="eci-w-inner">' +
        '<span class="eci-w-state ' + cls + '"><span class="eci-dot"></span>' + esc(label) + '</span>' +
        '<span class="eci-w-sep"></span>' +
        statTile(s.eligible == null ? "—" : s.eligible, "Total Voters") +
        statTile(s.cast, "Votes Cast") +
        statTile((s.eligible > 0 ? Math.round((s.cast / s.eligible) * 100) : 0) + "%", "Turnout") +
        statTile(s.candidates, "Candidates") +
        '<span class="eci-w-sep"></span>';

    /* Timer cell */
    if (s.state === 2) {
      html += timerShell("fa-flag-checkered", "Sealed", "Final Tally");
    } else if (!sched) {
      html += timerShell("fa-calendar", "—", "Window Not Scheduled");
    } else if (s.state === 1) {
      html += timerShell("fa-clock-o", "--", "Time Remaining");
    } else if (now < sched.start) {
      html += timerShell("fa-calendar", "--", "Opens " + fmtWindow(sched));
    } else {
      html += timerShell("fa-hourglass-half", "--", "Closes " + sched.to);
    }

    html += '</div>';

    $body.html(html);
    tickWidget();
  };

  function fmtCountdown(ms) {
    if (ms < 0) ms = 0;
    var t = Math.floor(ms / 1000);
    var d = Math.floor(t / 86400);
    var h = Math.floor((t % 86400) / 3600);
    var m = Math.floor((t % 3600) / 60);
    var sec = t % 60;
    var head = d > 0 ? d + "d " : "";
    return head + pad2(h) + "h " + pad2(m) + "m " + pad2(sec) + "s";
  }

  function tickWidget() {
    var $t = $("#eciWTimer");
    if (!$t.length) return;

    var s = EciUI.state;
    var sched = readSchedule();
    var now = Date.now();

    if (s.state === 2 || !sched) return;

    if (s.state === 1) {
      var left = sched.end - now;
      if (left <= 0) {
        $t.text("00h 00m 00s");
        $("#eciWTimerLabel").text("Voting Window Elapsed");
      } else {
        $t.text(fmtCountdown(left));
      }
    } else {
      var toStart = sched.start - now;
      if (toStart > 0) {
        $t.text(fmtCountdown(toStart));
      } else {
        $t.text(fmtCountdown(sched.end - now));
      }
    }
  }

  setInterval(tickWidget, 1000);

  /* ==========================================================
     Voter greeting (vote.html)
     ========================================================== */

  EciUI.renderGreeting = function () {
    var $g = $("#eciGreet");
    if (!$g.length) return;

    var s = EciUI.state;
    var sub = "Please cast your vote";
    if (s.hasVoted) {
      sub = "You have already cast your vote — thank you!";
    } else if (!s.isEligible) {
      sub = "This wallet is not on the voter whitelist.";
    } else if (s.isAdmin) {
      sub = "Admin wallet detected — switch to a voter account to vote.";
    }

    $g.html(
      '<h2>Namaste, Voter 👋</h2>' +
      '<p><span class="eci-chip" data-copy="' + esc(s.account) + '" title="Copy wallet address">' +
        esc(shortAddr(s.account)) + '</span>' +
      '<span class="eci-greet-sep">·</span>' + esc(sub) + '</p>'
    );
  };

  /* ==========================================================
     Post-vote congratulations + 10s auto account switch
     ========================================================== */

  var autoSwitchTimeout = null;
  var autoSwitchInterval = null;
  var RING_C = 163.4; // 2π × r(26)

  function clearAutoSwitch() {
    if (autoSwitchTimeout) { clearTimeout(autoSwitchTimeout); autoSwitchTimeout = null; }
    if (autoSwitchInterval) { clearInterval(autoSwitchInterval); autoSwitchInterval = null; }
  }

  function openAccountPicker() {
    if (window.ethereum && window.ethereum.request) {
      window.ethereum.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }]
      }).catch(function () { /* user closed the MetaMask picker */ });
    }
  }

  function armAutoSwitch() {
    clearAutoSwitch();
    var $ring = $("#eciLogoutRing");
    if (!$ring.length) return;

    var total = 10;
    var left = 10;

    var update = function () {
      $ring.find("b").text(left);
      $ring.find(".eci-ring-fg").css("stroke-dashoffset", String(RING_C * (1 - left / total)));
    };

    update();
    autoSwitchInterval = setInterval(function () {
      left -= 1;
      if (left < 0) return;
      update();
    }, 1000);

    autoSwitchTimeout = setTimeout(function () {
      clearAutoSwitch();
      openAccountPicker();
    }, 10000);
  }

  EciUI.congratsVisible = false;
  EciUI.currentVoteRecord = null;

  EciUI.showCongratulations = function (rec) {
    if (!rec) return;

    EciUI.currentVoteRecord = rec;
    EciUI.congratsVisible = true;
    clearAutoSwitch();

    var $box = $("#voteNotice");
    var $form = $("#voteForm");
    var $ballot = $("#eciBallotArea");
    var $tx = $("#txStatus");

    if ($form.length) $form.hide();
    if ($ballot.length) $ballot.hide();
    if ($tx.length) $tx.empty();

    var cand = rec.candidate ? esc(rec.candidate) : "";
    var txChip = "";
    if (rec.tx) {
      txChip =
        '<div class="col-sm-4" style="margin-bottom:10px;">' +
          '<div class="eci-stat">' +
            '<div class="eci-stat-label">Transaction Record</div>' +
            '<div style="margin-top:10px;">' +
              '<span class="eci-chip" data-copy="' + esc(rec.tx) + '" title="Copy transaction hash">' +
                esc(String(rec.tx).slice(0, 10)) + "…" + esc(String(rec.tx).slice(-6)) +
              '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    var html =
      '<div class="eci-congrats" id="eciCongrats">' +
        '<div class="eci-tick"><i class="fa fa-check"></i></div>' +
        '<h3 style="font-weight:700;color:var(--eci-green);margin:0 0 6px 0;">Congratulations!</h3>' +
        '<p style="margin:0 0 4px 0;font-size:15px;color:#33404f;">Your vote has been cast successfully' +
          (cand ? " for <b>" + cand + "</b>" : "") + '.</p>' +
        '<p class="eci-subtle" style="margin:0 0 18px 0;">Your ballot is permanently recorded on the Ethereum ledger.</p>' +
        '<div class="row" style="text-align:left;max-width:600px;margin:0 auto;">' +
          txChip +
          (rec.block !== "" && rec.block != null
            ? '<div class="col-sm-4" style="margin-bottom:10px;"><div class="eci-stat">' +
              '<div class="eci-stat-label">Block Number</div>' +
              '<div class="eci-stat-value" style="font-size:22px;">' + esc(rec.block) + '</div>' +
              '</div></div>'
            : "") +
          (rec.gas !== "" && rec.gas != null
            ? '<div class="col-sm-4" style="margin-bottom:10px;"><div class="eci-stat">' +
              '<div class="eci-stat-label">Gas Used</div>' +
              '<div class="eci-stat-value" style="font-size:22px;">' + esc(rec.gas) + '</div>' +
              '</div></div>'
            : "") +
        '</div>' +
        '<hr class="eci-divider">' +
        '<div style="font-family:var(--eci-font-head);font-weight:600;color:var(--eci-navy);">' +
          'Session ending — redirecting for the next voter…</div>' +
        '<div class="eci-logout-ring" id="eciLogoutRing">' +
          '<svg width="64" height="64">' +
            '<circle class="eci-ring-bg" cx="32" cy="32" r="26"></circle>' +
            '<circle class="eci-ring-fg" cx="32" cy="32" r="26"></circle>' +
          '</svg>' +
          '<b>10</b>' +
        '</div>' +
        '<div style="margin-top:6px;">' +
          '<button type="button" class="btn eci-btn ghost" id="eciCancelSwitch">Cancel &amp; stay on this page</button>' +
        '</div>' +
      '</div>';

    if ($box.length) {
      $box.html(html).show();
    } else if ($tx.length) {
      $tx.html(html);
    } else {
      return;
    }

    /* Widget: reflect the new vote immediately */
    var st = EciUI.state;
    if (st.eligible != null && st.eligible > 0) {
      st.cast = (st.cast || 0) + 1;
      EciUI.paintWidget();
    }

    armAutoSwitch();

    $("#eciCancelSwitch").off("click").on("click", function () {
      clearAutoSwitch();
      $(this).text("Auto-switch cancelled").prop("disabled", true);
      $("#eciLogoutRing").fadeOut(200);
    });
  };

  /* Called by app.js after the vote transaction is confirmed */
  EciUI.captureVoteReceipt = function (receipt, candidateLabel) {
    var rec = {
      tx: receipt && receipt.tx ? String(receipt.tx) : "",
      block: receipt && receipt.receipt && receipt.receipt.blockNumber != null ? String(receipt.receipt.blockNumber) : "",
      gas: receipt && receipt.receipt && receipt.receipt.gasUsed != null ? String(receipt.receipt.gasUsed) : "",
      candidate: candidateLabel || "",
      account: receipt && receipt.from ? String(receipt.from) : "",
      at: Date.now()
    };
    saveVoteRecord(rec);
    EciUI.showCongratulations(rec);
  };

  /* On page load (vote.html only): if this browser recorded a fresh vote,
     re-show the congratulations screen instead of the ballot. */
  var resumeChecked = false;

  EciUI.maybeResumeVoteRecord = function () {
    if (resumeChecked) return;
    resumeChecked = true;

    var rec = readVoteRecord();
    if (!rec) return;

    /* If the switched-in account is different from the one that voted,
       show the normal ballot view instead. */
    var s = EciUI.state;
    if (rec.account && s.account && rec.account.toLowerCase() === String(s.account).toLowerCase()) {
      EciUI.showCongratulations(rec);
    }
  };

  /* ==========================================================
     Admin schedule form (admin.html)
     ========================================================== */

  EciUI.readSchedule = readSchedule;

  EciUI.initScheduleForm = function () {
    var $form = $("#eciScheduleForm");
    if (!$form.length || $form.data("eciInit")) return;
    $form.data("eciInit", 1);

    var saved = readSchedule();
    if (saved) {
      $("#eciSchedDate").val(saved.date);
      $("#eciSchedFrom").val(saved.from);
      $("#eciSchedTo").val(saved.to);
    }

    $form.on("submit", function (ev) {
      ev.preventDefault();
      var $msg = $("#eciSchedMsg");
      var date = $("#eciSchedDate").val();
      var from = $("#eciSchedFrom").val();
      var to = $("#eciSchedTo").val();

      if (!date || !from || !to) {
        $msg.html('<div class="alert alert-warning" style="margin-top:12px;">Please fill in the date and both times.</div>');
        return;
      }

      var start = new Date(date + "T" + from);
      var end = new Date(date + "T" + to);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
        $msg.html('<div class="alert alert-warning" style="margin-top:12px;">The closing time must be after the opening time.</div>');
        return;
      }

      saveScheduleObject({ date: date, from: from, to: to });
      $msg.html('<div class="alert alert-success" style="margin-top:12px;"><i class="fa fa-check"></i> Voting window saved — the countdown is now live on every page.</div>');
      EciUI.paintWidget();
    });
  };

  /* ==========================================================
     Results decoration (results.html only)
     Reads the votes already rendered by app.js and adds rank
     badges + share bars. Display only — no data is changed.
     ========================================================== */

  EciUI.decorateResults = function () {
    var $rows = $("#candidatesResults tr");
    if (!$rows.length) return;

    var votes = [];
    $rows.each(function () {
      var $tds = $(this).find("td, th");
      var v = parseInt($tds.eq(3).text(), 10);
      votes.push(isNaN(v) ? 0 : v);
    });

    var max = Math.max.apply(null, votes.concat([0]));
    var total = votes.reduce(function (a, b) { return a + b; }, 0);

    $rows.each(function (i) {
      var $row = $(this);
      if ($row.data("eciDecorated")) return;
      $row.data("eciDecorated", 1);

      var $cells = $row.find("td, th");
      var v = votes[i] || 0;

      /* Rank badge in first cell */
      var rank = i + 1;
      var rankCls = rank === 1 ? " r1" : rank === 2 ? " r2" : rank === 3 ? " r3" : "";
      $cells.eq(0).html('<span class="eci-rank' + rankCls + '">' + rank + '</span>');

      /* Share bar in the votes cell */
      var pct = total > 0 ? Math.round((v / total) * 100) : 0;
      var width = max > 0 ? Math.max(6, Math.round((v / max) * 100)) : 6;
      $cells.eq(3).html(
        '<div style="min-width:180px;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<div class="eci-bar-track" style="flex:1;">' +
              '<div class="eci-bar-fill" style="width:' + width + '%;"></div>' +
            '</div>' +
            '<b style="font-family:var(--eci-font-head);color:var(--eci-navy);">' + v + '</b>' +
          '</div>' +
          '<small class="eci-subtle" style="display:block;margin-top:2px;">' + pct + '% of ballots</small>' +
        '</div>'
      );
    });
  };

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */

  wireFooter();
  wireCopyChips();

  window.EciUI = EciUI;

})(jQuery);
