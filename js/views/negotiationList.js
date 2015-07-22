/**
 * @name views.negotiationList
 * @namespace List of re-signing negotiations in progress.
 */
define(["dao", "globals", "ui", "core/freeAgents", "core/player", "core/team", "lib/bluebird", "lib/jquery", "lib/knockout", "lib/underscore", "util/bbgmView", "util/helpers"], function (dao, g, ui, freeAgents, player, team, Promise, $, ko, _, bbgmView, helpers) {
    "use strict";

    var mapping;

    function get() {
        if (g.phase !== g.PHASE.RESIGN_PLAYERS) {
            return {
                redirectUrl: helpers.leagueUrl(["negotiation", -1])
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

    function updateNegotiationList() {
        // Get all free agents, filter array based on negotiations data, pass to player.filter, augment with contract data from negotiations
        return Promise.all([
            dao.negotiations.getAll(),
            dao.players.getAll({
                index: "tid",
                key: g.PLAYER.FREE_AGENT,
                statsSeasons: [g.season],
                statsTid: g.userTid
            })
        ]).spread(function (negotiations, players) {
            var i, j, negotiationPids;

            // For Multi Team Mode, might have other team's negotiations going on
            negotiations = negotiations.filter(function (negotiation) {
                return negotiation.tid === g.userTid;
            });

            negotiationPids = _.pluck(negotiations, "pid");

            players = players.filter(function (p) {
                return negotiationPids.indexOf(p.pid) >= 0;
            });

            players = player.filter(players, {
                attrs: ["pid", "name", "age", "freeAgentMood", "injury", "watch"],
                ratings: ["ovr", "pot", "skills", "pos"],
                stats: ["min", "pts", "trb", "ast", "per"],
                season: g.season,
                tid: g.userTid,
                showNoStats: true,
                fuzz: true
            });

            for (i = 0; i < players.length; i++) {
                for (j = 0; j < negotiations.length; j++) {
                    if (players[i].pid === negotiations[j].pid) {
                        players[i].contract = {};
                        players[i].contract.amount = negotiations[j].player.amount / 1000;
                        players[i].contract.exp = g.season + negotiations[j].player.years;
                        break;
                    }
                }

                players[i].mood = player.moodColorText(players[i]);
            }

            return team.getPayroll(null, g.userTid).get(0).then(function(payroll) {
                return {
                    players: players,
                    payroll: payroll / 1000,
                    capText: (g.salaryCap - payroll > 0) ? "below" : "above",
                    salaryCap: g.salaryCap / 1000,
                    luxuryPayroll: g.luxuryPayroll / 1000,
                    taxText: (g.luxuryPayroll - payroll > 0) ? "below" : "above",
                    luxuryTax: Math.max((payroll - g.luxuryPayroll), 0) * g.luxuryTax / 1000
                };
            });
        });
    }

    function uiFirst(vm) {
        ui.title("Re-sign Players");

        ko.computed(function () {
            ui.datatable($("#negotiation-list"), 4, _.map(vm.players(), function (p) {
                var negotiateButton;
                if (freeAgents.refuseToNegotiate(p.contract.amount * 1000, p.freeAgentMood[g.userTid])) {
                    negotiateButton = "Refuses!";
                } else {
                    // This can be a plain link because the negotiation has already been started at this point.
                    negotiateButton = '<a href="' + helpers.leagueUrl(["negotiation", p.pid]) + '" class="btn btn-default btn-xs">Negotiate</a>';
                }
                return [helpers.playerNameLabels(p.pid, p.name, p.injury, p.ratings.skills, p.watch), p.ratings.pos, String(p.age), String(p.ratings.ovr), String(p.ratings.pot), helpers.round(p.stats.min, 1), helpers.round(p.stats.pts, 1), helpers.round(p.stats.trb, 1), helpers.round(p.stats.ast, 1), helpers.round(p.stats.per, 1), helpers.formatCurrency(p.contract.amount, "M") + ' thru ' + p.contract.exp, '<div title="' + p.mood.text + '" style="width: 100%; height: 21px; background-color: ' + p.mood.color + '"><span style="display: none">' + p.freeAgentMood[g.userTid] + '</span></div>', negotiateButton];
            }));
        }).extend({throttle: 1});

        ui.tableClickableRows($("#negotiation-list"));
    }

    return bbgmView.init({
        id: "negotiationList",
        get: get,
        mapping: mapping,
        runBefore: [updateNegotiationList],
        uiFirst: uiFirst
    });
});
