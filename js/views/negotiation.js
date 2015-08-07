/**
 * @name views.negotiation
 * @namespace Contract negotiation.
 */
define(["dao", "globals", "ui", "core/contractNegotiation", "core/freeAgents", "core/player", "core/team", "lib/knockout", "util/bbgmView", "util/helpers", "lib/bluebird"], function (dao, g, ui, contractNegotiation, freeAgents, player, team, ko, bbgmView, helpers, Promise) {
    "use strict";

    // Show the negotiations list if there are more ongoing negotiations
    function redirectNegotiationOrRoster(cancelled) {
        dao.negotiations.getAll().then(function (negotiations) {
            if (cancelled) {
                ui.realtimeUpdate([], helpers.leagueUrl(["free_agents"]));
            } else {
                ui.realtimeUpdate([], helpers.leagueUrl(["roster"]));
            }
        });
    }

    function get(req) {
        var pid;

        pid = parseInt(req.params.pid, 10);

        return {
            pid: pid >= 0 ? pid : null // Null will load whatever the active one is
        };
    }

    function post(req) {
        var notDelete, pid, teamAmountNew, teamYearsNew;

        pid = parseInt(req.params.pid, 10);
        notDelete = g.phase === g.PHASE.RESIGN_PLAYERS;

        if (req.params.hasOwnProperty("cancel")) {
            contractNegotiation.cancel(pid, notDelete).then(function () {
                redirectNegotiationOrRoster(true);
            });
        } else if (req.params.hasOwnProperty("accept")) {
            contractNegotiation.accept(pid).then(function (error) {
                if (error !== undefined && error) {
                    helpers.errorNotify(error);
                }
                redirectNegotiationOrRoster(false);
            });
        } else if (req.params.hasOwnProperty("new")) {
            // If there is no active negotiation with this pid, create it
            dao.negotiations.get({key: pid}).then(function (negotiation) {
                var tx;
                if (!negotiation) {
                    tx = dao.tx(["gameAttributes", "messages", "negotiations", "players"], "readwrite");
                    contractNegotiation.create(tx, pid, false).then(function (error) {
                        tx.complete().then(function () {
                            if (error !== undefined && error) {
                                helpers.errorNotify(error);
                                ui.realtimeUpdate([], helpers.leagueUrl(["free_agents"]));
                            } else {
                                ui.realtimeUpdate([], helpers.leagueUrl(["negotiation", pid]));
                            }
                        });
                    });
                } else {
                    ui.realtimeUpdate([], helpers.leagueUrl(["negotiation", pid]));
                }
            });
        } else {
            // Make an offer to the player;
            teamAmountNew = parseInt(req.params.teamAmount * 1000, 10);
            teamYearsNew = parseInt(req.params.teamYears, 10);

            // Any NaN?
            if (teamAmountNew !== teamAmountNew || teamYearsNew !== teamYearsNew) {
                ui.realtimeUpdate([], helpers.leagueUrl(["negotiation", pid]));
            } else {
                contractNegotiation.offer(pid, teamAmountNew, teamYearsNew).then(function (error) {
                    if (error !== undefined && error ) {
                        helpers.errorNotify(error);
                    }
                    ui.realtimeUpdate([], helpers.leagueUrl(["negotiation", pid]));
                });
            }
        }
    }

    function updateNegotiation(inputs) {
        // Call getAll so it works on null key
        return dao.negotiations.getAll({key: inputs.pid}).then(function (negotiations) {
            var negotiation;

            if (negotiations.length === 0) {
                return {
                    redirectUrl: helpers.leagueUrl(["free_agents"])
                };
            }

            negotiation = negotiations[0];

            negotiation.player.expiration = negotiation.player.years + g.season;
            negotiation.team.expiration = negotiation.team.years + g.season;
            // Adjust to account for in-season signings
            if (g.phase <= g.PHASE.AFTER_TRADE_DEADLINE) {
                negotiation.player.expiration -= 1;
                negotiation.team.expiration -= 1;
            }

            // Can't flatten more because of the return errorMessage above
            return dao.players.get({
                key: negotiation.pid
            }).then(function (p) {
                p = player.filter(p, {
                    attrs: ["pid", "name", "freeAgentMood", "born", "draft", "salaries"],
                    ratings: ["ovr", "pot"],
                    season: g.season,
                    showNoStats: true,
                    showRookies: true,
                    fuzz: true
                });

                // This can happen if a negotiation is somehow started with a retired player
                if (!p) {
                    contractNegotiation.cancel(negotiation.pid);
                    return {
                        errorMessage: "Invalid negotiation. Please try again."
                    };
                }

                // See views.freeAgents for moods as well
                if (p.freeAgentMood[g.userTid] < 0.25) {
                    p.mood = '<span class="text-success"><b>Eager to reach an agreement.</b></span>';
                } else if (p.freeAgentMood[g.userTid] < 0.5) {
                    p.mood = '<b>Willing to sign for the right price.</b>';
                } else if (p.freeAgentMood[g.userTid] < 0.75) {
                    p.mood = '<span class="text-warning"><b>Annoyed at you.</b></span>';
                } else {
                    p.mood = '<span class="text-danger"><b>Insulted by your presence.</b></span>';
                }
                p.grade = negotiation.grade * 100;
                p.gradep = ((p.grade)/100) * 100;
                p.age = g.season - p.born.year;
                p.yearsPro = g.season - p.draft.year;
                p.maxContract = helpers.vetMaxContract(p) / 1000;
                p.cutoff = (g.phase === g.PHASE.RESIGN_PLAYERS) ? freeAgents.OFFER_GRADE_CUTOFF : freeAgents.OFFER_GRADE_CUTOFF_FA;
                p.cutoff *= 100;
                if (p.salaries.length > 0) {
                    p.lastSalary = _.last(p.salaries).amount;
                } else {
                    p.lastSalary = 0;
                }
                delete p.freeAgentMood;

                return Promise.join(
                    team.getPayroll(null, g.userTid).get(0),
                    contractNegotiation.getAllNegoWithAmount(null, g.userTid),
                    function (payroll, allNego) {
                        return {
                            salaryCap: g.salaryCap / 1000,
                            payroll: payroll / 1000,
                            projectedPayroll: (payroll + allNego.amount) / 1000,
                            negoSpace: Math.max((g.salaryCap - payroll - allNego.amount) / 1000, 0.5),
                            team: {region: g.teamRegionsCache[g.userTid], name: g.teamNamesCache[g.userTid]},
                            player: p,
                            negotiation: {
                                team: {
                                    amount: ((negotiation.team.amount) ? negotiation.team.amount : negotiation.player.amount) / 1000,
                                    years: (negotiation.team.years) ? negotiation.team.years : negotiation.player.years,
                                    expiration: (negotiation.team.expiration) ? negotiation.team.expiration : negotiation.player.expiration
                                },
                                player: {
                                    amount: negotiation.player.amount / 1000,
                                    expiration: negotiation.player.expiration,
                                    years: negotiation.player.years
                                },
                                resigning: negotiation.resigning
                            }
                        };
                    });
            });
        });
    }

    function uiFirst(vm) {
        ko.computed(function () {
            ui.title("Contract Negotiation - " + vm.player.name());
        }).extend({throttle: 1});
    }

    return bbgmView.init({
        id: "negotiation",
        get: get,
        post: post,
        runBefore: [updateNegotiation],
        uiFirst: uiFirst
    });
});
