/**
 * @name core.contractNegotiation
 * @namespace All aspects of contract negotiation.
 */
define(["dao", "globals", "ui", "core/freeAgents", "core/player", "core/team", "lib/bluebird", "util/eventLog", "util/helpers", "util/lock", "util/random", "lib/bbgm-notifications"], function (dao, g, ui, freeAgents, player, team, Promise, eventLog, helpers, lock, random, bbgmNotifications) {
    "use strict";

    /**
     * Convert a negotiation object to a contract offer object.
     * @param  {Object} nego negotiation object
     * @return {Object}      contract offer object
     */
    function negotiationToOffer(nego) {
        var offer = {
            tid: nego.tid,
            pid: nego.pid,
            amount: nego.team.amount,
            exp: g.season + nego.team.years - +(g.phase >= g.PHASE.PRESEASON && g.phase <= g.PHASE.REGULAR_SEASON),
            skill: [],
            signingScore: 0.6,
            grade: nego.grade,
        }
        return offer;
    }

    /**
     * Convenience function to get all current negotiations as contract offer objects.
     * @param  {IDBTransaction|null} tx An IndexedDB transaction
     * @return {Array.Object}    list of contract offer objects.
     */
    function getAllUserOffers(tx) {
        tx = dao.tx(["negotiations"], "readwrite", tx);
        return dao.negotiations.getAll({
            ot: tx
        })
        .then(function(userNego) {
            var offers;
            // Exclude newly created negotiations (not offered)
            userNego = userNego.filter(function(n) {
                return n.team.years > 0;
            });
            offers = userNego.map(negotiationToOffer);
            return _.sortBy(offers, "pid");
        });
    }

    /**
     * Get total amount of all negotiations made.
     * @param  {IDBTransaction|null} tx  An IndexedDB transaction
     * @param  {number|null} tid team id, filter by tid if given.
     * @return {Object}     Object containing total amount and Array of all negotiations.
     */
    function getAllNegoWithAmount(tx, tid) {
        tid = (tid === undefined) ? -1 : tid;
        tx = dao.tx(["negotiations"], "readwrite", tx);
        return dao.negotiations.getAll({
            ot: tx
        })
        .then(function(allNego) {
            var totalAmount;
            if (tid > -1) {
                allNego = _.where(allNego, {tid: tid});
            }

            totalAmount = _.reduce(allNego, function(a, b) {
                return a + b.team.amount;
            }, 0);
            return {
                objects: allNego,
                amount: totalAmount
            }
        });
    }

    function decidePlayerResignOffers(tx, notResign) {
        notResign = notResign || false;

        tx = dao.tx(["negotiations", "players", "playerStats", "releasedPlayers", "teams"], "readwrite", tx);
        return getAllUserOffers(tx)
            .then(function(offers) {
                var cutoff, i, j, keys, offers, perPlayer, text;
                cutoff = (g.phase === g.PHASE.RESIGN_PLAYERS) ? freeAgents.OFFER_GRADE_CUTOFF : freeAgents.OFFER_GRADE_CUTOFF_FA;
                perPlayer = _.groupBy(offers, 'pid')
                keys = _.keys(perPlayer);
                return Promise.map(keys, function(pid) {
                    return dao.players.get({ot: tx, key: +pid})
                })
                .each(function(p) {
                    offers = perPlayer[p.pid].sort(function(a, b) { return b.grade - a.grade; });
                    for (j = 0; j < offers.length; j++ ) {
                        // slightly random passing grade
                        if (offers[j].grade > random.uniform(cutoff - 0.02, cutoff + 0.02)) {
                            return freeAgents.acceptContract(p, offers[j], [], tx, (notResign) ? 'freeAgent' : 'reSigned');
                        } else {
                            if (notResign) {
                                text = '<a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + helpers.playerNameOvr(p) + '</a> refuses to sign contract with your team, ' + 'the <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[offers[j].tid], g.season]) + '">' + g.teamNamesCache[offers[j].tid] + '</a>.'
                            } else {
                                text = '<a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + helpers.playerNameOvr(p) + '</a> refuses to sign contract to remain on your team, ' + 'the <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[offers[j].tid], g.season]) + '">' + g.teamNamesCache[offers[j].tid] + '</a>.'
                            }
                            bbgmNotifications.notify(text, 'Free Agency', true);
                        }
                    }
                });
            });
    }

    /**
     * Start a new contract negotiation with a player.
     *
     * @memberOf core.contractNegotiation
     * @param {IDBTransaction|null} tx An IndexedDB transaction on gameAttributes, messages, negotiations, and players, readwrite; if null is passed, then a new transaction will be used.
     * @param {number} pid An integer that must correspond with the player ID of a free agent.
     * @param {boolean} resigning Set to true if this is a negotiation for a contract extension, which will allow multiple simultaneous negotiations. Set to false otherwise.
     * @param {number=} tid Team ID the contract negotiation is with. This only matters for Multi Team Mode. If undefined, defaults to g.userTid.
     * @return {Promise.<string=>)} If an error occurs, resolve to a string error message.
     */
    function create(tx, pid, resigning, tid) {
        tid = tid !== undefined ? tid : g.userTid;

        if ((g.phase >= g.PHASE.AFTER_TRADE_DEADLINE && g.phase <= g.PHASE.RESIGN_PLAYERS) && !resigning) {
            return Promise.resolve("You're not allowed to sign free agents now.");
        }

        // Can't flatten because of error callbacks
        return lock.canStartNegotiation(tx).then(function (canStartNegotiation) {
            if (!canStartNegotiation) {
                return "You cannot initiate a new negotiaion while game simulation is in progress or a previous contract negotiation is in process.";
            }

            return dao.players.count({
                ot: tx,
                index: "tid",
                key: g.userTid
            }).then(function (numPlayersOnRoster) {
                if (numPlayersOnRoster >= 15 && !resigning) {
                    return "Your roster is full. Before you can sign a free agent, you'll have to release or trade away one of your current players.";
                }

                return dao.players.get({ot: tx, key: pid}).then(function (p) {
                    var negotiation, playerAmount, playerYears;

                    if (p.tid !== g.PLAYER.FREE_AGENT) {
                        return p.name + " is not a free agent.";
                    }

                    // Initial player proposal;
                    playerAmount = p.contract.amount;
                    playerYears = p.contract.exp - g.season;
                    // Adjust to account for in-season signings;
                    if (g.phase <= g.PHASE.AFTER_TRADE_DEADLINE) {
                        playerYears += 1;
                    }

                    negotiation = {
                        pid: pid,
                        tid: tid,
                        team: {amount: 0, years: 0},
                        player: {amount: playerAmount, years: playerYears},
                        orig: {amount: playerAmount, years: playerYears},
                        resigning: resigning
                    };

                    return dao.negotiations.add({ot: tx, value: negotiation}).then(function () {
                        require("core/league").updateLastDbChange();
                        ui.updateStatus("Contract negotiation");
                        return ui.updatePlayMenu(tx);
                    });
                });
            });
        });
    }

    /**
     * Restrict the input to between g.minContract and g.maxContract, the valid amount of annual thousands of dollars for a contract.
     *
     * @memberOf core.contractNegotiation
     * @param {number} years Annual salary, in thousands of dollars, to be validated.
     * @param {Objejct} p Player object
     * @return {number} An integer between g.minContract and g.maxContract, rounded to the nearest $10k.
     */
    function validAmount(amount, p) {
        if (amount < g.minContract) {
            amount = g.minContract;
        } else if (amount > helpers.vetMaxContract(p)) {
            amount = helpers.vetMaxContract(p);
        }
        return helpers.round(amount / 10) * 10;
    }

    /**
     * Restrict the input to between 1 and 5, the valid number of years for a contract.
     *
     * @memberOf core.contractNegotiation
     * @param {number} years Number of years, to be validated.
     * @return {number} An integer between 1 and 5.
     */
    function validYears(years) {
        if (years < 1) {
            years = 1;
        } else if (years > 5) {
            years = 5;
        }
        return Math.round(years);
    }

    /**
     * Make an offer to a player.
     *
     * @memberOf core.contractNegotiation
     * @param {number} pid An integer that must correspond with the player ID of a player in an ongoing negotiation.
     * @param {number} teamAmount Teams's offer amount in thousands of dollars per year (between 500 and 20000).
     * @param {number} teamYears Team's offer length in years (between 1 and 5).
     * @return {Promise}
     */
    function offer(pid, teamAmount, teamYears) {
        var isResigning, oRosterSize, tx;

        // No need to check salary and roster space during resigning period.
        isResigning = g.phase === g.PHASE.RESIGN_PLAYERS;

        tx = dao.tx(["negotiations", "players", "releasedPlayers"], "readwrite");

        return Promise.join(
            getAllNegoWithAmount(tx, g.userTid),
            dao.players.get({ot: tx, key: pid}),
            function(allNego, p) {
                var nego = _.findWhere(allNego.objects, {pid: pid});
                // exclude current nego from total
                return team.getPayroll(tx, nego.tid)
                    .then(function(result) {
                        var numOfReleased = _.countBy(result[1], 'released'),
                            rosterSize,
                            salarySpace;

                        allNego.objects = _.filter(allNego.objects, function(n) {
                            return n.team.amount > 0 && n.team.years > 0 && n.pid != pid;
                        })
                        rosterSize = numOfReleased.false + allNego.objects.length;
                        // assign to outside variable, for checking later
                        oRosterSize = rosterSize;

                        // Exclude current negotiation if it already exist.
                        if (nego) {
                            allNego.amount -= nego.team.amount;
                        }
                        salarySpace = Math.max(g.salaryCap - result[0], 0);
                        salarySpace = Math.max(salarySpace, g.minContract);
                        return {
                            nego: nego,
                            p: p,
                            rosterSize: rosterSize,
                            salarySpace: salarySpace,
                            negoTotal: allNego.amount
                        }
                    });
            }
        )
        .then(function(result) {
            var cutoff,
                diffGrade,
                nego = result.nego,
                offerGrade,
                p = result.p,
                t = result;

            nego.team.amount = validAmount(teamAmount, p);
            nego.team.years = validYears(teamYears);

            t.negoTotal += nego.team.amount;
            console.log(t.negoTotal, t.salarySpace, t.rosterSize, teamAmount);

            if (!isResigning && t.rosterSize + 1 > g.maxRosterSize) {
                return "Your roster is full (includes offered contracts). Before you can offer a free agent, you'll have to release or trade away one of your current players or cancel a contract offer to another free agent.";
            }

            if (!isResigning && (t.salarySpace - t.negoTotal < 0 && teamAmount > g.minContract)) {
                return 'This contract would put you over the salary cap. You cannot go over the salary cap to sign free agents to contracts higher than the minimum salary. Either negotiate for a lower contract or cancel the negotiation.';
            }
            cutoff = (g.phase === g.PHASE.RESIGN_PLAYERS) ? freeAgents.OFFER_GRADE_CUTOFF : freeAgents.OFFER_GRADE_CUTOFF_FA;

            offerGrade = freeAgents.gradeOffer(negotiationToOffer(nego), p);
            diffGrade = Math.max(cutoff - offerGrade, 0);
            // mood only increases (less favorable)
            nego.grade = offerGrade;
            p.freeAgentMood[nego.tid] += Math.abs(diffGrade) * 0.5 * random.randInt(1, 3) + .05;
            return Promise.join(
                dao.players.put({ot: tx, value: p}),
                dao.negotiations.put({ot: tx, value: nego})
            )
            .then(function() {
                localStorage.signingSkip = 0;
                require("core/league").updateLastDbChange();
            }).then(function() {
                if (g.phase >= g.PHASE.PRESEASON && g.phase <= g.PHASE.PLAYOFFS) {
                    if (oRosterSize < g.minRosterSize) {
                        decidePlayerResignOffers(null, true);
                    }
                }
            });
        });
    }

    /**
     * Cancel contract negotiations with a player.
     *
     * @memberOf core.contractNegotiation
     * @param {number} pid An integer that must correspond with the player ID of a player in an ongoing negotiation.
     * @return {Promise}
     */
    function cancel(pid, notDelete) {
        var tx, updateF;
        notDelete = notDelete || false;
        tx = dao.tx(["gameAttributes", "messages", "negotiations"], "readwrite");

        updateF = function() {
            if (g.phase === g.PHASE.FREE_AGENCY) {
                ui.updateStatus(g.daysLeft + " days left");
            } else {
                ui.updateStatus("Idle");
            }
            ui.updatePlayMenu(tx);
        }

        if (notDelete) {
            return dao.negotiations.get({ot: tx, key: pid})
                .then(function(nego) {
                    nego.team.amount = 0;
                    nego.team.years = 0;
                    nego.grade = null;
                    return dao.negotiations.put({ot: tx, value: nego});
                })
                .then(updateF);
        } else {
            // Delete negotiation
            dao.negotiations.delete({ot: tx, key: pid}).then(updateF);
        }

        return tx.complete().then(function () {
            require("core/league").updateLastDbChange();
        });
    }

    /**
     * Cancel all ongoing contract negotiations.
     *
     * Currently, the only time there should be multiple ongoing negotiations in the first place is when a user is re-signing players at the end of the season, although that should probably change eventually.
     *
     * @memberOf core.contractNegotiation
     * @param {IDBTransaction} tx An IndexedDB transaction on gameAttributes, messages, and negotiations, readwrite.
     * @return {Promise}
     */
    function cancelAll(tx) {
        // var tx = dao.tx(["gameAttributes", "messages", "negotiations"], "readwrite")
        return dao.negotiations.clear({ot: tx}).then(function () {
            require("core/league").updateLastDbChange();
            ui.updateStatus("Idle");
            return ui.updatePlayMenu(tx);
        });
    }

    /**
     * Accept the player's offer.
     *
     * If successful, then the team's current roster will be displayed.
     *
     * @memberOf core.contractNegotiation
     * @param {number} pid An integer that must correspond with the player ID of a player in an ongoing negotiation.
     * @return {Promise.<string=>} If an error occurs, resolves to a string error message.
     */
    function accept(pid) {
        return Promise.all([
            dao.negotiations.get({key: pid}),
            team.getPayroll(null, g.userTid).get(0)
        ]).spread(function (negotiation, payroll) {
            var tx;

            // If this contract brings team over the salary cap, it's not a minimum;
            // contract, and it's not re-signing a current player, ERROR!
            if (!negotiation.resigning && (payroll + negotiation.player.amount > g.salaryCap && negotiation.player.amount !== g.minContract)) {
                return "This contract would put you over the salary cap. You cannot go over the salary cap to sign free agents to contracts higher than the minimum salary. Either negotiate for a lower contract or cancel the negotiation.";
            }

            // This error is for sanity checking in multi team mode. Need to check for existence of negotiation.tid because it wasn't there originally and I didn't write upgrade code. Can safely get rid of it later.
            if (negotiation.tid !== undefined && negotiation.tid !== g.userTid) {
                return "This negotiation was started by the " + g.teamRegionsCache[negotiation.tid] + " " + g.teamNamesCache[negotiation.tid] + " but you are the " + g.teamRegionsCache[g.userTid] + " " + g.teamNamesCache[g.userTid] + ". Either switch teams or cancel this negotiation.";
            }

            // Adjust to account for in-season signings;
            if (g.phase <= g.PHASE.AFTER_TRADE_DEADLINE) {
                negotiation.player.years -= 1;
            }

            tx = dao.tx(["players", "playerStats"], "readwrite");
            dao.players.iterate({
                ot: tx,
                key: pid,
                callback: function (p) {
                    p.tid = g.userTid;
                    p.gamesUntilTradable = 15;

                    // Handle stats if the season is in progress
                    if (g.phase <= g.PHASE.PLAYOFFS) { // Otherwise, not needed until next season
                        p = player.addStatsRow(tx, p, g.phase === g.PHASE.PLAYOFFS);
                    }

                    p = player.setContract(p, {
                        amount: negotiation.player.amount,
                        exp: g.season + negotiation.player.years
                    }, true);

                    if (negotiation.resigning) {
                        eventLog.add(null, {
                            type: "reSigned",
                            text: 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[g.userTid], g.season]) + '">' + g.teamNamesCache[g.userTid] + '</a> re-signed <a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a> for ' + helpers.formatCurrency(p.contract.amount / 1000, "M") + '/year through ' + p.contract.exp + '.',
                            showNotification: false,
                            pids: [p.pid],
                            tids: [g.userTid]
                        });
                    } else {
                        eventLog.add(null, {
                            type: "freeAgent",
                            text: 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[g.userTid], g.season]) + '">' + g.teamNamesCache[g.userTid] + '</a> signed <a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a> for ' + helpers.formatCurrency(p.contract.amount / 1000, "M") + '/year through ' + p.contract.exp + '.',
                            showNotification: false,
                            pids: [p.pid],
                            tids: [g.userTid]
                        });
                    }

                    return p;
                }
            });

            return tx.complete().then(function () {
                return cancel(pid);
            }).then(function () {
                require("core/league").updateLastDbChange();
            });
        });
    }

    return {
        accept: accept,
        cancel: cancel,
        cancelAll: cancelAll,
        create: create,
        offer: offer,
        getAllUserOffers: getAllUserOffers,
        getAllNegoWithAmount: getAllNegoWithAmount,
        decidePlayerResignOffers: decidePlayerResignOffers,
    };
});
