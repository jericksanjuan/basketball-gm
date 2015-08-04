/**
 * @name views.freeAgents
 * @namespace List of free agents.
 */
define(["dao", "globals", "ui", "core/freeAgents", "core/player", "core/team", "lib/bluebird", "lib/jquery", "lib/knockout", "lib/underscore", "util/bbgmView", "util/helpers", "core/contractNegotiation"], function (dao, g, ui, freeAgents, player, team, Promise, $, ko, _, bbgmView, helpers, contractNegotiation) {
    "use strict";

    var mapping;

    function disableButtons() {
        $("#free-agents button").attr("disabled", "disabled");
        $("#game-sim-warning").show();
    }

    function enableButtons() {
        $("#free-agents button").removeAttr("disabled");
        $("#game-sim-warning").hide();
    }

    function get() {
        if (g.phase >= g.PHASE.AFTER_TRADE_DEADLINE && g.phase <= g.PHASE.RESIGN_PLAYERS) {
            if (g.phase === g.PHASE.RESIGN_PLAYERS) {
                return {
                    redirectUrl: helpers.leagueUrl(["negotiation"])
                };
            }

            return {
                errorMessage: "You're not allowed to sign free agents now."
            };
        }
    }

    mapping = {
        players: {
            create: function (options) {
                return options.data;
            }
        }
    };

    function updateFreeAgents() {
        return Promise.all([
            team.getPayroll(null, g.userTid).get(0),
            dao.players.getAll({
                index: "tid",
                key: g.userTid
            }),
            dao.players.getAll({
                index: "tid",
                key: g.PLAYER.FREE_AGENT,
                statsSeasons: [g.season, g.season - 1]
            }),
            contractNegotiation.getAllNegoWithAmount(null, g.userTid)
        ]).spread(function (payroll, userPlayers, players, allNego) {
            var capSpace, i, negoRosterSpots, negoSpace, negotiations, negotiationsOffered, negotiationsPids, numRosterSpots;

            capSpace = (g.salaryCap - payroll) / 1000;
            if (capSpace < 0) {
                capSpace = 0;
            }
            numRosterSpots = g.maxRosterSize - userPlayers.length;

            players = player.filter(players, {
                attrs: ["pid", "name", "age", "contract", "freeAgentMood", "injury", "watch"],
                ratings: ["ovr", "pot", "skills", "pos"],
                stats: ["min", "pts", "trb", "ast", "per"],
                season: g.season,
                showNoStats: true,
                showRookies: true,
                fuzz: true,
                oldStats: true
            });

            // For Multi Team Mode, might have other team's negotiations going on
            negotiations = allNego.objects.filter(function (negotiation) {
                return negotiation.tid === g.userTid;
            });

            negotiationsOffered = negotiations.filter(function(negotiation) {
                return negotiation.team.years > 0 && negotiation.team.amount > 0;
            })
            negotiationsPids = _.pluck(negotiationsOffered, "pid")
            negotiationsOffered = _.groupBy(negotiationsOffered, "pid")

            negoSpace = Math.max(capSpace - allNego.amount / 1000, 0.5);
            negoRosterSpots = numRosterSpots - negotiationsPids.length;

            for (i = 0; i < players.length; i++) {
                players[i].mood = player.moodColorText(players[i]);

                if (negotiationsPids.indexOf(players[i].pid) >= 0) {
                    players[i].offered = true
                    players[i].contract.amount = negotiationsOffered[players[i].pid][0].team.amount / 1000;
                    players[i].contract.exp = negotiationsOffered[players[i].pid][0].team.years + g.season;
                }
            }

            return {
                capSpace: capSpace,
                negoSpace: negoSpace,
                numRosterSpots: numRosterSpots,
                negoRosterSpots: negoRosterSpots,
                negoLen: negotiationsPids.length,
                negoAmount: allNego.amount / 1000,
                players: players
            };
        });
    }

    function uiFirst(vm) {
        ui.title("Free Agents");

        $("#help-salary-cap").popover({
            title: "Cap Space",
            html: true,
            content: "<p>\"Cap space\" is the difference between your current payroll and the salary cap. You can sign a free agent to any valid contract as long as you don't go over the cap.</p>You can only exceed the salary cap to sign free agents to minimum contracts ($" + g.minContract + "k/year)."
        });

        ko.computed(function () {
            ui.datatable($("#free-agents"), 4, _.map(vm.players(), function (p) {
                var negotiateButton;
                if (p.offered) {
                    negotiateButton = '<form action="' + helpers.leagueUrl(["negotiation", p.pid], {noQueryString: true}) + '" method="POST" style="margin: 0"><input type="hidden" name="new" value="1"><button type="submit" class="btn btn-info btn-xs">Change Offer</button></form>';
                } else {
                    negotiateButton = '<form action="' + helpers.leagueUrl(["negotiation", p.pid], {noQueryString: true}) + '" method="POST" style="margin: 0"><input type="hidden" name="new" value="1"><button type="submit" class="btn btn-default btn-xs">Negotiate</button></form>';
                }
                // The display: none for mood allows sorting, somehow
                return [helpers.playerNameLabels(p.pid, p.name, p.injury, p.ratings.skills, p.watch), p.ratings.pos, String(p.age), String(p.ratings.ovr), String(p.ratings.pot), helpers.round(p.stats.min, 1), helpers.round(p.stats.pts, 1), helpers.round(p.stats.trb, 1), helpers.round(p.stats.ast, 1), helpers.round(p.stats.per, 1), helpers.formatCurrency(p.contract.amount, "M") + ' thru ' + p.contract.exp, '<div title="' + p.mood.text + '" style="width: 100%; height: 21px; background-color: ' + p.mood.color + '"><span style="display: none">' + p.freeAgentMood[g.userTid] + '</span></div>', negotiateButton];
            }));
        }).extend({throttle: 1});

        ui.tableClickableRows($("#free-agents"));

        // Form enabling/disabling
        $("#free-agents").on("gameSimulationStart", function () {
            disableButtons();
        });
        $("#free-agents").on("gameSimulationStop", function () {
            enableButtons();
        });
    }

    function uiEvery() {
        // Wait for datatable
        setTimeout(function () {
            if (g.gamesInProgress) {
                disableButtons();
            } else {
                enableButtons();
            }
        }, 10);
    }

    return bbgmView.init({
        id: "freeAgents",
        get: get,
        mapping: mapping,
        runBefore: [updateFreeAgents],
        uiFirst: uiFirst,
        uiEvery: uiEvery
    });
});
