/**
 * @name core.trade
 * @namespace Trades between the user's team and other teams.
 */
define(["dao", "globals", "core/league", "core/player", "core/team", "core/freeAgents", "lib/bluebird", "lib/underscore", "util/eventLog", "util/helpers", "util/random"], function (dao, g, league, player, team, freeAgents, Promise, _, eventLog, helpers, random) {
    "use strict";

    /**
     * Get the contents of the current trade from the database.
     *
     * @memberOf core.trade
     * @param {Promise.<Array.<Object>>} Resolves to an array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs).
     */
    function get(ot) {
        return dao.trade.get({ot: ot, key: 0}).then(function (tr) {
            return tr.teams;
        });
    }

    /**
     * Start a new trade with a team.
     *
     * @memberOf core.trade
     * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs). If the other team's tid is null, it will automatically be determined from the pids.
     * @return {Promise}
     */
    function create(teams) {
        return get().then(function (oldTeams) {
            // If nothing is in this trade, it's just a team switch, so keep the old stuff from the user's team
            if (teams[0].pids.length === 0 && teams[1].pids.length === 0 && teams[0].dpids.length === 0 && teams[1].dpids.length === 0) {
                teams[0].pids = oldTeams[0].pids;
                teams[0].dpids = oldTeams[0].dpids;
            }

            // Make sure tid is set
            return Promise.try(function () {
                if (teams[1].tid === undefined || teams[1].tid === null) {
                    return dao.players.get({key: teams[1].pids[0]}).then(function (p) {
                        teams[1].tid = p.tid;
                    });
                }
            }).then(function () {
                var tx;

                tx = dao.tx("trade", "readwrite");
                dao.trade.put({
                    ot: tx,
                    value: {
                        rid: 0,
                        teams: teams
                    }
                });
                return tx.complete().then(function () {
                    league.updateLastDbChange();
                });
            });
        });
    }

    /**
     * Gets the team ID for the team that the user is trading with.
     *
     * @memberOf core.trade
     * @return {er} Resolves to the other team's team ID.
     */
    function getOtherTid() {
        return get().then(function (teams) {
            return teams[1].tid;
        });
    }

    /**
     * Filter untradable players.
     *
     * If a player is not tradable, set untradable flag in the root of the object.
     *
     * @memberOf core.trade
     * @param {Array.<Object>} players Array of player objects or partial player objects
     * @return {Array.<Object>} Processed input
     */
    function filterUntradable(players) {
        var i;

        for (i = 0; i < players.length; i++) {
            if (players[i].contract.exp <= g.season && g.phase > g.PHASE.PLAYOFFS && g.phase < g.PHASE.FREE_AGENCY) {
                // If the season is over, can't trade players whose contracts are expired
                players[i].untradable = true;
                players[i].untradableMsg = "Cannot trade expired contracts";
            } else if (players[i].gamesUntilTradable > 0) {
                // Can't trade players who recently were signed or traded
                players[i].untradable = true;
                players[i].untradableMsg = "Cannot trade recently-acquired player for " + players[i].gamesUntilTradable + " more games";
            } else {
                players[i].untradable = false;
                players[i].untradableMsg = "";
            }
        }

        return players;
    }

    /**
     * Is a player untradable.
     *
     * Just calls filterUntradable and discards everything but the boolean.
     *
     * @memberOf core.trade
     * @param {<Object>} players Player object or partial player objects
     * @return {boolean} Processed input
     */
    function isUntradable(player) {
        return filterUntradable([player])[0].untradable;
    }

    /**
     * Validates that players are allowed to be traded and updates the database.
     *
     * If any of the player IDs submitted do not correspond with the two teams that are trading, they will be ignored.
     *
     * @memberOf core.trade
     * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs).
     * @return {Promise.<Array.<Object>>} Resolves to an array taht's the same as the input, but with invalid entries removed.
     */
    function updatePlayers(teams) {
        var promises, tx;

        // This is just for debugging
        team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids, null).then(function (dv) {
            console.log(dv);
        });

        tx = dao.tx(["draftPicks", "players"]);

        // Make sure each entry in teams has pids and dpids that actually correspond to the correct tid
        promises = [];
        teams.forEach(function (t) {
            // Check players
            promises.push(dao.players.getAll({
                ot: tx,
                index: "tid",
                key: t.tid
            }).then(function (players) {
                var j, pidsGood;

                pidsGood = [];
                for (j = 0; j < players.length; j++) {
                    // Also, make sure player is not untradable
                    if (t.pids.indexOf(players[j].pid) >= 0 && !isUntradable(players[j])) {
                        pidsGood.push(players[j].pid);
                    }
                }
                t.pids = pidsGood;
            }));

            // Check draft picks
            promises.push(dao.draftPicks.getAll({
                ot: tx,
                index: "tid",
                key: t.tid
            }).then(function (dps) {
                var dpidsGood, j;

                dpidsGood = [];
                for (j = 0; j < dps.length; j++) {
                    if (t.dpids.indexOf(dps[j].dpid) >= 0) {
                        dpidsGood.push(dps[j].dpid);
                    }
                }
                t.dpids = dpidsGood;
            }));
        });

        return Promise.all(promises).then(function () {
            var tx, updated;

            updated = false; // Has the trade actually changed?

            tx = dao.tx("trade", "readwrite");
            get(tx).then(function (oldTeams) {
                var i;

                for (i = 0; i < 2; i++) {
                    if (teams[i].tid !== oldTeams[i].tid) {
                        updated = true;
                        break;
                    }
                    if (teams[i].pids.toString() !== oldTeams[i].pids.toString()) {
                        updated = true;
                        break;
                    }
                    if (teams[i].dpids.toString() !== oldTeams[i].dpids.toString()) {
                        updated = true;
                        break;
                    }
                }

                if (updated) {
                    dao.trade.put({
                        ot: tx,
                        value: {
                            rid: 0,
                            teams: teams
                        }
                    });
                }
            });

            return tx.complete().then(function () {
                if (updated) {
                    league.updateLastDbChange();
                }
            });
        }).then(function () {
            return teams;
        });
    }


    /**
     * Create a summary of the trade, for eventual display to the user.
     *
     * @memberOf core.trade
     * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs).
     * @return {Promise.Object} Resolves to an object contianing the trade summary.
     */
    function summary(teams) {
        var dpids, i, pids, players, promises, s, tids, tx;

        tids = [teams[0].tid, teams[1].tid];
        pids = [teams[0].pids, teams[1].pids];
        dpids = [teams[0].dpids, teams[1].dpids];

        s = {teams: [], warning: null};
        for (i = 0; i < 2; i++) {
            s.teams.push({trade: [], total: 0, payrollAfterTrade: 0, name: ""});
        }

        tx = dao.tx(["draftPicks", "players", "releasedPlayers"]);

        // Calculate properties of the trade
        players = [[], []];
        promises = [];
        [0, 1].forEach(function (i) {
            promises.push(dao.players.getAll({
                ot: tx,
                index: "tid",
                key: tids[i]
            }).then(function (playersTemp) {
                players[i] = player.filter(playersTemp, {
                    attrs: ["pid", "name", "contract"],
                    season: g.season,
                    tid: tids[i],
                    showRookies: true
                });
                s.teams[i].trade = players[i].filter(function (player) { return pids[i].indexOf(player.pid) >= 0; });
                s.teams[i].total = s.teams[i].trade.reduce(function (memo, player) { return memo + player.contract.amount; }, 0);
            }));

            promises.push(dao.draftPicks.getAll({
                ot: tx,
                index: "tid",
                key: tids[i]
            }).then(function (picks) {
                var j;

                s.teams[i].picks = [];
                for (j = 0; j < picks.length; j++) {
                    if (dpids[i].indexOf(picks[j].dpid) >= 0) {
                        s.teams[i].picks.push({desc: picks[j].season + " " + (picks[j].round === 1 ? "1st" : "2nd") + " round pick (" + g.teamAbbrevsCache[picks[j].originalTid] + ")"});
                    }
                }
            }));
        });

        return Promise.all(promises).then(function () {
            var overCap, ratios;

            // Test if any warnings need to be displayed
            overCap = [false, false];
            ratios = [0, 0];
            return Promise.map([0, 1], function (j) {
                var k;
                if (j === 0) {
                    k = 1;
                } else if (j === 1) {
                    k = 0;
                }

                s.teams[j].name = g.teamRegionsCache[tids[j]] + " " + g.teamNamesCache[tids[j]];

                if (s.teams[j].total > 0) {
                    ratios[j] = Math.floor((100 * s.teams[k].total) / s.teams[j].total);
                } else if (s.teams[k].total > 0) {
                    ratios[j] = Infinity;
                } else {
                    ratios[j] = 100;
                }

                return team.getPayroll(tx, tids[j]).get(0).then(function (payroll) {
                    s.teams[j].payrollAfterTrade = payroll / 1000 + s.teams[k].total - s.teams[j].total;
                    if (s.teams[j].payrollAfterTrade > g.salaryCap / 1000) {
                        overCap[j] = true;
                    }
                });
            }).then(function () {
                var j;

                if ((ratios[0] > 125 && overCap[0] === true) || (ratios[1] > 125 && overCap[1] === true)) {
                    // Which team is at fault?;
                    if (ratios[0] > 125) {
                        j = 0;
                    } else {
                        j = 1;
                    }
                    s.warning = "The " + s.teams[j].name + " are over the salary cap, so the players it receives must have a combined salary of less than 125% of the salaries of the players it trades away.  Currently, that value is " + ratios[j] + "%.";
                }

                return s;
            });
        });
    }


    /**
     * Remove all players currently added to the trade.
     *
     * @memberOf core.trade
     * @return {Promise}
     */
    function clear() {
        var tx;

        tx = dao.tx("trade", "readwrite");
        dao.trade.get({ot: tx, key: 0}).then(function (tr) {
            var i;

            for (i = 0; i < tr.teams.length; i++) {
                tr.teams[i].pids = [];
                tr.teams[i].dpids = [];
            }

            dao.trade.put({ot: tx, value: tr});
        });
        return tx.complete().then(function () {
            league.updateLastDbChange();
        });
    }

    /**
     * Proposes the current trade in the database.
     *
     * Before proposing the trade, the trade is validated to ensure that all player IDs match up with team IDs.
     *
     * @memberOf core.trade
     * @param {boolean} forceTrade When true (like in God Mode), this trade is accepted regardless of the AI
     * @return {Promise.<boolean, string>} Resolves to an array. The first argument is a boolean for whether the trade was accepted or not. The second argument is a string containing a message to be dispalyed to the user.
     */
    function propose(forceTrade) {
        forceTrade = forceTrade !== undefined ? forceTrade : false;

        if (g.phase >= g.PHASE.AFTER_TRADE_DEADLINE && g.phase <= g.PHASE.PLAYOFFS) {
            return Promise.resove([false, "Error! You're not allowed to make trades now."]);
        }

        return get().then(function (teams) {
            // The summary will return a warning if (there is a problem. In that case,
            // that warning will already be pushed to the user so there is no need to
            // return a redundant message here.
            return summary(teams).then(function (s) {
                if (s.warning && !forceTrade) {
                    return [false, null];
                }

                return callEvaluateTrade(null, teams, true).then(function(dv) {
                    return doTrade(dv, teams, s, forceTrade);
                });
            });
        });
    }

    /**
     * Make a trade work
     *
     * Have the AI add players/picks until they like the deal. Uses forward selection to try to find the first deal the AI likes.
     *
     * @memberOf core.trade
     * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs).
     * @param {boolean} holdUserConstant If true, then players/picks will only be added from the other team. This is useful for the trading block feature.
     * @param {?Object} estValuesCached Estimated draft pick values from trade.getPickValues, or null. Only pass if you're going to call this repeatedly, then it'll be faster if you cache the values up front.
     * @return {Promise.[boolean, Object]} Resolves to an array with one or two elements. First is a boolean indicating whether "make it work" was successful. If true, then the second argument is set to a teams object (similar to first input) with the "made it work" trade info.
     */
    function makeItWork(teams, holdUserConstant, estValuesCached) {
        var added, initialSign, testTrade, tryAddAsset;

        added = 0;

        // Add either the highest value asset or the lowest value one that makes the trade good for the AI team.
        tryAddAsset = function () {
            var assets, tx;

            assets = [];

            tx = dao.tx(["draftPicks", "players"]);

            if (!holdUserConstant) {
                // Get all players not in userPids
                dao.players.iterate({
                    ot: tx,
                    index: "tid",
                    key: teams[0].tid,
                    callback: function (p) {
                        if (teams[0].pids.indexOf(p.pid) < 0 && !isUntradable(p)) {
                            assets.push({
                                type: "player",
                                pid: p.pid,
                                tid: teams[0].tid
                            });
                        }
                    }
                });
            }

            // Get all players not in otherPids
            dao.players.iterate({
                ot: tx,
                index: "tid",
                key: teams[1].tid,
                callback: function (p) {
                    if (teams[1].pids.indexOf(p.pid) < 0 && !isUntradable(p)) {
                        assets.push({
                            type: "player",
                            pid: p.pid,
                            tid: teams[1].tid
                        });
                    }
                }
            });

            if (!holdUserConstant) {
                // Get all draft picks not in userDpids
                dao.draftPicks.iterate({
                    ot: tx,
                    index: "tid",
                    key: teams[0].tid,
                    callback: function (dp) {
                        if (teams[0].dpids.indexOf(dp.dpid) < 0) {
                            assets.push({
                                type: "draftPick",
                                dpid: dp.dpid,
                                tid: teams[0].tid
                            });
                        }
                    }
                });
            }

            // Get all draft picks not in otherDpids
            dao.draftPicks.iterate({
                ot: tx,
                index: "tid",
                key: teams[1].tid,
                callback: function (dp) {
                    if (teams[1].dpids.indexOf(dp.dpid) < 0) {
                        assets.push({
                            type: "draftPick",
                            dpid: dp.dpid,
                            tid: teams[1].tid
                        });
                    }
                }
            });

            return tx.complete().then(function () {
                var otherDpids, otherPids, userDpids, userPids;

                // If we've already added 5 assets or there are no more to try, stop
                if (initialSign === -1 && (assets.length === 0 || added >= 5)) {
                    return [false];
                }

                // Calculate the value for each asset added to the trade, for use in forward selection
                return Promise.map(assets, function (asset) {
                    userPids = teams[0].pids.slice();
                    otherPids = teams[1].pids.slice();
                    userDpids = teams[0].dpids.slice();
                    otherDpids = teams[1].dpids.slice();

                    if (asset.type === "player") {
                        if (asset.tid === g.userTid) {
                            userPids.push(asset.pid);
                        } else {
                            otherPids.push(asset.pid);
                        }
                    } else {
                        if (asset.tid === g.userTid) {
                            userDpids.push(asset.dpid);
                        } else {
                            otherDpids.push(asset.dpid);
                        }
                    }
                    return team.valueChange(teams[1].tid, userPids, otherPids, userDpids, otherDpids, estValuesCached).then(function (dv) {
                        asset.dv = dv;
                    });
                }).then(function () {
                    var asset, j;

                    assets.sort(function (a, b) { return b.dv - a.dv; });

                    // Find the asset that will push the trade value the smallest amount above 0
                    for (j = 0; j < assets.length; j++) {
                        if (assets[j].dv < 0) {
                            break;
                        }
                    }
                    if (j > 0) {
                        j -= 1;
                    }
                    asset = assets[j];
                    if (asset.type === "player") {
                        if (asset.tid === g.userTid) {
                            teams[0].pids.push(asset.pid);
                        } else {
                            teams[1].pids.push(asset.pid);
                        }
                    } else {
                        if (asset.tid === g.userTid) {
                            teams[0].dpids.push(asset.dpid);
                        } else {
                            teams[1].dpids.push(asset.dpid);
                        }
                    }

                    added += 1;

                    return testTrade();
                });
            });
        };

        // See if the AI team likes the current trade. If not, try adding something to it.
        testTrade = function () {
            return team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids, estValuesCached).then(function (dv) {
                if (dv > 0 && initialSign === -1) {
                    return [true, teams];
                }

                if ((added > 2 || (added > 0 && Math.random() > 0.5)) && initialSign === 1) {
                    if (dv > 0) {
                        return [true, teams];
                    }

                    return [false];
                }

                return tryAddAsset();
            });
        };

        return team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids, estValuesCached).then(function (dv) {
            if (dv > 0) {
                // Try to make trade better for user's team
                initialSign = 1;
            } else {
                // Try to make trade better for AI team
                initialSign = -1;
            }

            return testTrade();
        });
    }

    /**
     * Estimate draft pick values, based on the generated draft prospects in the database.
     *
     * This was made for team.valueChange, so it could be called once and the results cached.
     *
     * @memberOf core.trade
     * @param {IDBObjectStore|IDBTransaction|null} ot An IndexedDB object store or transaction on players; if null is passed, then a new transaction will be used.
     * @return {Promise.Object} Resolves to estimated draft pick values.
     */
    function getPickValues(ot) {
        var estValues, i, promises;

        estValues = {
            default: [75, 73, 71, 69, 68, 67, 66, 65, 64, 63, 62, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 50, 50, 49, 49, 49, 48, 48, 48, 47, 47, 47, 46, 46, 46, 45, 45, 45, 44, 44, 44, 43, 43, 43, 42, 42, 42, 41, 41, 41, 40, 40, 39, 39, 38, 38, 37, 37] // This is basically arbitrary
        };

        // Look up to 4 season in the future, but depending on whether this is before or after the draft, the first or last will be empty/incomplete
        promises = [];
        for (i = g.season; i < g.season + 4; i++) {
            promises.push(dao.players.getAll({
                ot: ot,
                index: "draft.year",
                key: i
            }).then(function (players) {
                if (players.length > 0) {
                    for (i = 0; i < players.length; i++) {
                        players[i].value += 4; // +4 is to generally make picks more valued
                    }
                    players.sort(function (a, b) { return b.value - a.value; });
                    estValues[players[0].draft.year] = _.pluck(players, "value");
                }
            }));
        }

        return Promise.all(promises).then(function () {
            return estValues;
        });
    }

    /**
     * Make a trade work
     *
     * This should be called for a trade negotiation, as it will update the trade objectStore.
     *
     * @memberOf core.trade
     * @return {Promise.string} Resolves to a string containing a message to be dispalyed to the user, as if it came from the AI GM.
     */
    function makeItWorkTrade() {
        return Promise.all([
            getPickValues(),
            get()
        ]).spread(function (estValues, teams0) {
            // return makeItWork(helpers.deepCopy(teams0), false, estValues).spread(function (found, teams) {
            return callEvaluateTrade(null, helpers.deepCopy(teams0)).spread(function (found, teams) {
                if (!found) {
                    return g.teamRegionsCache[teams0[1].tid] + ' GM: "I can\'t afford to give up so much."';
                }
                return summary(teams).then(function (s) {
                    var i, updated;

                    // Store AI's proposed trade in database, if it's different
                    updated = false;

                    for (i = 0; i < 2; i++) {
                        if (teams[i].tid !== teams0[i].tid) {
                            updated = true;
                            break;
                        }
                        if (teams[i].pids.toString() !== teams0[i].pids.toString()) {
                            updated = true;
                            break;
                        }
                        if (teams[i].dpids.toString() !== teams0[i].dpids.toString()) {
                            updated = true;
                            break;
                        }
                    }

                    return Promise.try(function () {
                        var tx;

                        if (updated) {
                            tx = dao.tx("trade", "readwrite");
                            dao.trade.put({
                                ot: tx,
                                value: {
                                    rid: 0,
                                    teams: teams
                                }
                            });
                            return tx.complete();
                        }
                    }).then(function () {
                        if (s.warning) {
                            return g.teamRegionsCache[teams[1].tid] + ' GM: "Something like this would work if you can figure out how to get it done without breaking the salary cap rules."';
                        }

                        return g.teamRegionsCache[teams[1].tid] + ' GM: "How does this sound?"';
                    });
                });
            });
        });
    }

    function doTrade(dv, teams, s, forceTrade) {
        var dpids, formatAssetsEventLog, outcome, pids, tids, tx;
        console.log('doing trade');
        forceTrade = forceTrade || false;

        if (s.warning && !forceTrade) {
            console.log(s.warning);
            return [false, null];
        }

        tids = [teams[0].tid, teams[1].tid];
        pids = [teams[0].pids, teams[1].pids];
        dpids = [teams[0].dpids, teams[1].dpids];
        outcome = "rejected";

        tx = dao.tx(["draftPicks", "players", "playerStats"], "readwrite");
        if (dv && dv || forceTrade) {
            // Trade players
            outcome = "accepted";
            [0, 1].forEach(function (j) {
                var k;

                if (j === 0) {
                    k = 1;
                } else if (j === 1) {
                    k = 0;
                }

                pids[j].forEach(function (pid) {
                    dao.players.get({
                        ot: tx,
                        key: pid
                    }).then(function (p) {
                        p.tid = tids[k];
                        // Don't make traded players untradable
                        p.gamesUntilTradable = 40;
                        p.ptModifier = 1; // Reset
                        if (g.phase <= g.PHASE.PLAYOFFS) {
                            p = player.addStatsRow(tx, p, g.phase === g.PHASE.PLAYOFFS);
                        }
                        dao.players.put({ot: tx, value: p});
                    });
                });

                dpids[j].forEach(function (dpid) {
                    dao.draftPicks.get({
                        ot: tx,
                        key: dpid
                    }).then(function (dp) {
                        dp.tid = tids[k];
                        dp.abbrev = g.teamAbbrevsCache[tids[k]];
                        dao.draftPicks.put({ot: tx, value: dp});
                    });
                });
            });

            // Log event
            formatAssetsEventLog = function (t) {
                var i, strings, text;

                strings = [];

                t.trade.forEach(function (p) {
                    strings.push('<a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a>');
                });
                t.picks.forEach(function (dp) {
                    strings.push('a ' + dp.desc);
                });

                if (strings.length === 0) {
                    text = "nothing";
                } else if (strings.length === 1) {
                    text = strings[0];
                } else if (strings.length === 2) {
                    text = strings[0] + " and " + strings[1];
                } else {
                    text = strings[0];
                    for (i = 1; i < strings.length; i++) {
                        if (i === strings.length - 1) {
                            text += ", and " + strings[i];
                        } else {
                            text += ", " + strings[i];
                        }
                    }
                }

                return text;
            };

            eventLog.add(null, {
                type: "trade",
                text: 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[tids[0]], g.season]) + '">' + g.teamNamesCache[tids[0]] + '</a> traded ' + formatAssetsEventLog(s.teams[0]) + ' to the <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[tids[1]], g.season]) + '">' + g.teamNamesCache[tids[1]] + '</a> for ' + formatAssetsEventLog(s.teams[1]) + '.',
                showNotification: false,
                pids: pids[0].concat(pids[1]),
                tids: tids
            });
        }

        return tx.complete().then(function () {
            if (outcome === "accepted") {
                return clear().then(function () { // This includes dbChange
                    // Auto-sort CPU team roster
                    if (g.userTids.indexOf(tids[1]) < 0) {
                        return team.rosterAutoSort(null, tids[1]);
                    }
                }).then(function () {
                    return [true, 'Trade accepted! "Nice doing business with you!"'];
                });
            }

            return [false, 'Trade rejected! "What, are you crazy?"'];
        });

        // After trade, remove pids and dpids in team.offers object.
        // do this by
        // setting tradingBlockSkip.
    }

    /**
     * Convert from trade format to tradeNego
     */
    function callEvaluateTrade(tx, tradeTeams, firstResult) {
        var order;
        firstResult = firstResult || false;
        tx = dao.tx(["teams"], "readwrite", tx);
        return Promise.map(tradeTeams, function(t) {
            return dao.teams.get({
                ot:tx,
                key: t.tid,
            });
        }).then(function(teams) {
            var i,
                tradeNego = _.pluck(teams, "offers");
            for (i = 0; i < 2; i++) {
                tradeNego[i].pids = tradeTeams[i].pids;
                tradeNego[i].dpids = tradeTeams[i].dpids;
                tradeNego[i].value = 0;
            }
            order = _.pluck(tradeTeams, "tid");
            if (firstResult) {
                return  evaluateTrade(null, tradeNego, firstResult);
            }
            return evaluateTrade(null, tradeNego);
        }).then(function(result) {
            var tmp;
            // order result similar to first call.
            if (result[0] && !firstResult) {
                if (order[0] !== result[1][0].tid) {
                    tmp = result[1][0];
                    result[1][0] = result[1][1];
                    result[1][1] = tmp;
                }
            }
            return result;
        });
    }

    /**
     * tradeNego: [offer1, offer2]
     */
    function evaluateTrade(tx, tradeNego, firstResult) {
        var fnChangeAsset, fnEvaluateTrade, fnEvaluateStep, fnGetPlayers, fnGetDraftPicks, fnUpdateTradeValue, tids;
        tx = dao.tx(["teams", "players", "playerStats", "draftPicks", "releasedPlayers"],
            "readwrite", tx);

        fnGetPlayers = function(tid) {
            return dao.players.getAll({
                ot: tx,
                index: "tid",
                key: tid
            });
        };

        fnGetDraftPicks = function(tid) {
            return dao.draftPicks.getAll({
                ot: tx,
                index: "tid",
                key: tid
            });
        };

        fnUpdateTradeValue = function(tradeNego, players, draftPicks) {
            var expOnly, i;
            for (i = 0; i < tradeNego.length; i++) {
                    expOnly = ['salarySpace', 'expiring'].indexOf(tradeNego[1 - i].priority[0]) >= 0;
                    expOnly = false;
                    tradeNego[i].value = assessTradeAssets(tradeNego[i], players, draftPicks, expOnly);
                }
                // Remove protection on asset if maxVal of other is higher.
                for  (i = 0; i < tradeNego.length; i++) {
                    if (tradeNego[i].isProtected && (tradeNego[i].maxValue < tradeNego[1 - i].maxValue)) {

                        tradeNego[i].value /= 1000;
                    }
                }
        };

        fnChangeAsset = function(offer, assets, assetCount, assetInitial, maxAssetCount, players, draftPicks, cond) {
            var toRemove;
            if(assets[0].hasOwnProperty('round') && cond) {
                offer.dpids = offer.dpids || [];
                offer.dpids.push(assets[0].dpid);
                assetCount ++;
                if (assetCount > maxAssetCount) {
                    offer.dpids.splice(assetInitial.picks, 1);
                    assetCount --;
                }
            } else if (assets[0].hasOwnProperty('pid')) {
                offer.pids = offer.pids || [];
                offer.pids.push(assets[0].pid);
                offer.contract += assets[0].contract.amount;
                assetCount ++;
                if (assetCount > maxAssetCount) {
                    toRemove = offer.pids.splice(assetInitial.players, 1);
                    console.log("to remove", toRemove);
                    offer.contract -= players[toRemove[0]].contract.amount;
                    assetCount --;
                }
            }
            return [assets.splice(0, 1), assetCount];
        };

        fnEvaluateStep = function(tradeNego, assets, players, draftPicks, noAddUser) {
            var assetCount = [
                    tradeNego[0].pids.length + tradeNego[0].dpids.length,
                    tradeNego[1].pids.length + tradeNego[1].dpids.length
                ],
                assetInitial,
                assetMax,
                cond = {value: false, salary: false, salaryOther: false},
                localAssets = assets.slice(0).filter(function(p) {return p.tid === tradeNego[1].tid;}),
                otherAssets = assets.slice(0).filter(function(p) {return p.tid === tradeNego[0].tid;}),
                removed = [],
                removedOther = [],
                sort,
                switch0 = false,
                switch1 = false,
                tmp;

            noAddUser = noAddUser || false;

            assetInitial = [
                {players: tradeNego[0].pids.length, picks: tradeNego[0].dpids.length},
                {players: tradeNego[1].pids.length, picks: tradeNego[1].dpids.length}
            ];
            assetMax = [
                (tradeNego[1].maxValue > 80) ? 4 : (tradeNego[1].maxValue > 60) ? 3 : (tradeNego[1].maxValue > 50) ? 2 : 2,
                (tradeNego[0].maxValue > 80) ? 4 : (tradeNego[0].maxValue > 60) ? 3 : (tradeNego[0].maxValue > 50) ? 2 : 2,
            ];
            // assetMax = [4, 4];

            sort = (tradeNego[0].priority[0] === "salarySpace") ? "contract_amount" : "tradeValue";
            localAssets = _.sortBy(localAssets, sort);
            otherAssets = _.sortBy(otherAssets, sort);
            console.log('sort', sort);
            if (sort === "tradeValue") {
                localAssets = localAssets.reverse();
            } else {
                localAssets = localAssets.filter(function(p) {
                    if (p.hasOwnProperty("pid")) {
                        return p.contract.exp === g.season;
                    } else {
                        return true;
                    }
                });
                otherAssets = otherAssets.filter(function(p) {
                    if (p.hasOwnProperty("pid")) {
                        // return non-expiring;
                        return p.contract.exp !== g.season;
                    } else {
                        return true;
                    }
                });
            }

            while(localAssets.length > 0 && otherAssets.length > 0) {
                cond.value = tradeNego[1].value / tradeNego[0].value >= tradeNego[0].reqValue;
                cond.salary = (tradeNego[0].contract - tradeNego[1].salarySpace) / (tradeNego[1].contract) < 1.25;
                cond.salaryOther = (tradeNego[1].contract - tradeNego[0].salarySpace) / (tradeNego[0].contract) < 1.25;

                console.log(JSON.stringify(cond));
                if (cond.value && cond.salary && (cond.salaryOther || noAddUser)) {
                    localAssets = [];
                    otherAssets = [];
                }

                if (!cond.value || !cond.salary) {
                    console.log('adjusting');
                    if (Math.abs(tradeNego[1].value - tradeNego[0].value) < 5 && assetCount[1] > 0) {
                        if (sort === "tradeValue") {
                            console.log('reverse sorted', tradeNego[1].value, tradeNego[0].value);
                            localAssets = _.sortBy(localAssets, sort);
                        }
                        assetInitial[1] = {players: tradeNego[1].pids.length, picks: tradeNego[1].dpids.length};
                    }

                    if (cond.value && !cond.salary) {
                        localAssets = localAssets.filter(function(p) {
                            return p.hasOwnProperty('pid');
                        })
                        localAssets = _.sortBy(localAssets, "contract_amount");
                    }
                    console.log(JSON.stringify(_.zip(
                        _.pluck(localAssets, 'tradeValue'),
                        _.pluck(localAssets, 'name'),
                        _.pluck(localAssets, 'round')
                    )));

                    tmp = fnChangeAsset(tradeNego[1], localAssets, assetCount[1], assetInitial[1], assetMax[1], players, draftPicks, cond.salaryOther);
                    removed = removed.concat(tmp[0]);
                    assetCount[1] = tmp[1];

                    if (assetCount[1] > assetMax[1]) {
                        localAssets = [];
                    }
                } else if (!cond.salaryOther && !noAddUser) {
                    console.log('adjusting other');
                    console.log(JSON.stringify(_.zip(
                        _.pluck(localAssets, 'tradeValue'),
                        _.pluck(localAssets, 'name'),
                        _.pluck(localAssets, 'round')
                    )));

                    // if (tradeNego[1].value - tradeNego[0].value < 5 && removed.length > 0) {
                    //     localAssets.splice(0, 0, removed.splice(0, 1));
                    // }

                    tmp = fnChangeAsset(tradeNego[0], otherAssets, assetCount[0], assetInitial[0], assetMax[0], players, draftPicks, cond.salary);
                    removedOther = removedOther.concat(tmp[0]);
                    assetCount[0] = tmp[1];
                }

                fnUpdateTradeValue(tradeNego, players, draftPicks);

            }
        };

        fnEvaluateTrade = function(players, draftPicks, tradeNego) {
            var assets, i, result, tradeDpids, tradePids, v;
            firstResult = firstResult || false;
            tradePids = _.flatten(_.pluck(tradeNego, 'pids'));
            tradeDpids = _.flatten(_.pluck(tradeNego, 'dpids'));

            players = _.flatten(players);
            players = _.filter(players, function(p) {
                return p.gamesUntilTradable === 0;
            });
            draftPicks = _.flatten(draftPicks);

            tradeNego = _.sortBy(tradeNego, 'value').reverse();

            result = (tradeNego[1].value / tradeNego[0].value) || 0;
            console.log(JSON.stringify(_.zip(_.pluck(tradeNego, 'tid'), _.pluck(tradeNego, 'pids'), _.pluck(tradeNego, 'dpids'))), result);

            if (g.userTid === tradeNego[0].tid && tradeNego[0].value > 0 && tradeNego[1].value > 0) {
                console.log(JSON.stringify(tradeNego), true);
                return [true, tradeNego];
            }

            if (result < tradeNego[0].reqValue || isNaN(result)) {
                if (tradeNego[1].pids.length + tradeNego[1].dpids.length > 4) {
                    console.log(JSON.stringify(tradeNego), false);
                    return [false];
                }

                assets = _.flatten(
                    _.union(players, draftPicks)
                )
                .filter(function(p) {
                    return (p.hasOwnProperty('round')) ? tradeDpids.indexOf(p.dpid) === -1 : tradePids.indexOf(p.pid) === -1;
                }).map(function(p) {
                    p.tradeValue = getAssetValue(p);
                    if (p.hasOwnProperty('pid')) {
                        p.contract_amount = p.contract.amount + p.tradeValue;
                    } else {
                        p.contract_amount = (p.round === 1) ? 5000 : 500;
                        p.contract_amount += p.tradeValue;
                    }
                    return p;
                });


                players = _.object(_.pluck(players, "pid"), players);
                draftPicks = _.object(_.pluck(draftPicks, "dpid"), draftPicks);

                fnUpdateTradeValue(tradeNego, players, draftPicks);

                if (firstResult) {
                    tradeNego = _.sortBy(tradeNego, 'value');
                    if (g.userTid === tradeNego[0].tid) {
                        tradeNego = tradeNego.reverse();
                    }
                    result = (tradeNego[1].value / tradeNego[0].value) || 0;
                    return result >= tradeNego[0].reqValue;
                }

                assets = assets.filter(function(p) {
                    // Only add player of lesser trade value.
                    return p.tradeValue <= tradeNego[0].maxValue * 1.02;
                });
                // .filter(function(p) {
                //     if (p.hasOwnProperty('round')) {
                //         return true;
                //     } else {
                //         // Don't add more players if other team has no roster space.
                //         if (tradeNego[0].rosterSpace + tradeNego[0].pids.length <= tradeNego[1].pids.length) {
                //             return;
                //         }
                //         return p.contract.amount < tradeNego[0].contract + tradeNego[0].salarySpace;
                //     }
                // });
                fnEvaluateStep(tradeNego, assets, players, draftPicks, tradeNego[1].tid === g.userTid);

            }

            // fail if either does not have asset to trade.
            for (i = 0; i < tradeNego.length; i++) {
                if (!tradeNego[i].pids.length && !tradeNego[i].dpids.length) {
                    return [false];
                }
            }
            result = (tradeNego[1].value / tradeNego[0].value) || 0;

            console.log(JSON.stringify(tradeNego), result >= tradeNego[0].reqValue);
            console.log(tradeNego[1].priority[0], JSON.stringify(_.zip(_.pluck(tradeNego, 'tid'), _.pluck(tradeNego, 'pids'), _.pluck(tradeNego, 'dpids'))), result);
            return [result >= tradeNego[0].reqValue, tradeNego];
        };

        tids = _.pluck(tradeNego, "tid");
        return Promise.join(
            Promise.map(tids, fnGetPlayers),
            Promise.map(tids, fnGetDraftPicks),
            tradeNego,
            fnEvaluateTrade
        );
    }

    function matchTradeTeams(finder, teams) {
        var ts;
        ts = teams.slice(0);
        // if rebuilding and taxpaying look for salary space

        if (finder.offers.priority[0] === "value") {
            ts  = ts.sort(function(a, b) {
                return b.offers.value - a.offers.value;
            });
        } else if (finder.offers.priority[0] === "salarySpace") {
            ts = ts.sort(function(a, b) {
                var r = b.offers.salarySpace - a.offers.salarySpace;
                return (r === 0) ? b.offers.expiring - a.offers.expiring : r;
            });
        } else {
            ts = ts.sort(function(a, b) {
                var r = b.offers.expiring - a.offers.expiring;
                return (r === 0) ? b.offers.salarySpace - a.offers.salarySpace : r;
            });
        }
        ts = ts.slice(0, 5);
        // random.shuffle(ts);
        if (ts[0].tid === finder.tid) {
            return ts[1];
        }
        return ts[0];
    }

    // players and draftPicks must be objects with their respective ids as keys.
    function assessTradeAssets(offer, players, draftPicks, expOnly) {
        var i, isProtected, maxVal, out, p, value, values;
        expOnly = expOnly || false;
        values = [];
        isProtected = false;
        for (i = 0; i < offer.pids.length; i++) {
            p = players[offer.pids[i]];
            value = getAssetValue(p);
            value = (expOnly && p.contract.exp !== g.season) ? value / 2 : value;
            values.push(value);
            if (offer.pidprotected.indexOf(offer.pids[i]) >= 0) {
                isProtected = true;
            }
        }
        for (i = 0; i < offer.dpids.length; i++) {
            value = getAssetValue(draftPicks[offer.dpids[i]]);
            if (offer.dpidprotected.indexOf(offer.dpids[i]) >= 0) {
                isProtected = true;
            }
            values.push(value);
        }

        out = 0;
        values = values.sort(function(a, b){ return b - a;});
        for (i = 0; i < values.length; i++) {
            out += values[i] / (i + 1);
        }
        offer.maxValue = (values.length > 0) ? values[0] : 0;
        // if any of the asset is protected, increase trade value to make untradeable.
        if (offer.tid === g.userTid && g.autoPlaySeasons === 0) {
            isProtected = false;
        }
        offer.isProtected = isProtected;
        out = (isProtected) ? out *= 1000 : out;
        return out;
    }

    function getAssetValue(asset) {
        var age, potVal, r, v, values;
        values = {
            80: 100,
            70: 80,
            60: 35,
            50: 10,
            40: 1,
        };
        if (asset.hasOwnProperty('dpid')) {
            v = getDraftPickValue(asset);
            console.log(v, "pick", asset.round, asset.season, asset.tid);
            return getDraftPickValue(asset);
        } else {
            age = g.season - asset.born.year;
            r = _.last(asset.ratings);
            potVal = (age < 23) ? r.pot : r.ovr;
            v = ( asset.value + 3 * potVal ) / 4;

            v = helpers.bound(Math.floor(v / 10) * 10, 40, 80);
            v = values[v] + asset.value/100 * 10;

            // Adjust for age;
            if (age < 23) {
                v *= 1.25;
            } else if (age < 25) {
                v *= 1.1;
            } else if (age >= 25 && age <= 29) {
                v *= 1;
            } else {
                v *= 0.90;
            }

            console.log(v, asset.name, asset.value, r.ovr, asset.tid);
            return v;
        }
    }

    function updateLocalTeamRankings(teams) {
        var i, byScore, byScore3;
        teams = teams.slice(0);
        teams = teams.map(function(t) {
            var i,
                strategy = (t.strategy === "rebuilding") ? 1 : 0,
                s = _.last(t.seasons),
                s3 = t.seasons.slice(-3, -1);
            t.score = s.lost - 4 * s.playoffRoundsWon + strategy;
            t.score3 = s3.reduce(function(a, b) {
                return a + b.lost - 4 * s.playoffRoundsWon + strategy;
            }, 0);
            return t;
        });
        byScore = _.pluck(_.sortBy(teams, "score"), "tid");
        byScore3 = _.pluck(_.sortBy(teams, "score3"), "tid");
        localStorage.teamRankings = JSON.stringify(byScore);
        localStorage.teamRankings3 = JSON.stringify(byScore3);
    }

    function getDraftPickValue(draftPick) {
        var rank,
            score,
            teamRankings = JSON.parse(localStorage.teamRankings) || [] ,
            teamsRankings3 = JSON.parse(localStorage.teamRankings3) || [],
            yrdiff;

        yrdiff = draftPick.season - g.season;
        if (draftPick.round === 1) {
            if (teamRankings.indexOf(draftPick.originalTid) >= 0) {
                rank = teamRankings.indexOf(draftPick.originalTid);
                rank = (rank > 15) ? 35 * (rank - 15) / 14 : -15 + rank;
                score =  35 + rank;
            } else {
                score = 45;
            }
            if (yrdiff > 0) {
                score = (score + (yrdiff) * 45) / (yrdiff + 1);
            }
            return score;
        } else {
            if (teamRankings.indexOf(draftPick.originalTid) >= 0) {
                rank = teamRankings.indexOf(draftPick.originalTid);
                rank = (rank > 15) ? 4.5 * (rank - 15) / 14 : -4.5 + rank;
                score = 15 + rank;
            } else {
                score = 15;
            }
            if (yrdiff > 0) {
                score = (score + (yrdiff) * 15) / (yrdiff + 1);
            }
            return score;
        }
    }

    function setTradeablePids(players, offers, tmInfo) {
        var pids,
            pidsOrig = players.filter(function(p) {
                return p.gamesUntilTradable === 0;
            }),
            fnAdd,
            fnSort,
            fnTaxPaying,
            fnRebuilding,
            fnContending,
            fnLosing;

        if (g.phase >= g.PHASE.AFTER_TRADE_DEADLINE && g.phase <= g.PHASE.PLAYOFFS) {
            return;
        }

        pidsOrig = pidsOrig.map(function(p) {
            p.playerGrade = gradePlayer(p);
            return p;
        });

        fnSort = function(a, b) {
            var r = a.playerGrade - b.playerGrade;
            r = (r === 0) ? b.contract.amount - a.contract.amount : r;
            return (r === 0) ? b.born.year - a.born.year : r;
        };

        fnAdd = function(p) {
            offers.pids.push(p.pid);
            offers.value = getAssetValue(p);
            offers.contract += p.contract.amount;
            if (offers.pidprotected.indexOf(p.pid) >= 0) {
                // Remove added asset from protected list
                offers.pidprotected.splice(offers.pidprotected.indexOf(p.pid), 1);
            }
        };

        fnTaxPaying = function() {
            pids = pidsOrig.filter(function(p) {
                return p.contract.exp !== g.season &&
                    p.contract.amount + tmInfo.luxuryTax > 0 &&
                    p.contract.amount > g.maxContract * 0.2 &&
                    p.playerGrade < 0.6;
            });
            pids.sort(function(a, b) {
                var r;
                r = a.playerGrade - b.playerGrade;
                r = (r === 0) ? a.contract.amount - b.contract.amount : r;
                return (r === 0) ? b.born.year - a.born.year : r;
            });

            if (pids.length > 0) {
                fnAdd(pids[0]);
                offers.priority = ["salarySpace", "expiring", "value"];
                offers.reqValue = 0.1;
                return;
            }
        };

        fnRebuilding = function() {
            pids = pidsOrig.filter(function(p) {
                return p.contract.exp !== g.season &&
                    p.contract.amount > g.maxContract * 0.25 &&
                    p.playerGrade < 0.6;
            });
            pids.sort(fnSort);

            if (pids.length > 0) {
                fnAdd(pids[0]);
                offers.priority = ["expiring", "salarySpace", "value"];
                // offers.reqValue = random.uniform(0.5, 0.7);
                return;
            }
        };

        fnContending = function() {
            // Trade expiring contracts (in chance to get assets in return)
            pids = pidsOrig.filter(function(p) {
                return p.contract.exp === g.season &&
                    p.contract.amount > g.maxContract * 0.25 &&
                    p.playerGrade < 0.6;
            });
            pids.sort(fnSort);

            if (pids.length > 0) {
                fnAdd(pids[0]);
                offers.expiring += pids[0].contract.amount;
                return;
            }
        };

        fnLosing = function() {
            if (tmInfo.games.won3 / tmInfo.games.gp3 < 0.55) {
                console.log('shake things up');
                pids = pidsOrig.filter(function(p) {
                    return p.contract.amount > g.maxContract * 0.25 &&
                        p.playerGrade > 0.8;
                });
                random.shuffle(pids);

                if (pids.length > 0) {
                    fnAdd(pids[0]);
                    return;
                }
            }
        };

        // taxpaying team reduce salary.
        if (tmInfo.isTaxPaying && (tmInfo.games.gp > 41 && tmInfo.games.winp < 0.67 || tmInfo.cash < 0)) {
            return fnTaxPaying();
        }

        // rebuilding team trade non-expiring for expiring
        if (tmInfo.isRebuilding && tmInfo.salarySpace < g.salaryCap - g.minPayroll && tmInfo.games.gp > 20 && tmInfo.games.winp < 0.55) {
            return fnRebuilding();
        }

        // contending team  trade expiring
        if (!tmInfo.isRebuilding && tmInfo.expiring.amount > 0 ) {
            return fnContending();
        }

        // If team is losing, shake things up, trade a valuable player
        if (tmInfo.games.gp > 41 && tmInfo.games.winp < 0.55 && tmInfo.games.hype < 0.25) {
            return fnLosing();
        }
    }

    function setTradeableDpids(draftPicks, offers, tmInfo) {
        var cond1, cond2, dpids, round, year;
        if (g.phase >= g.PHASE.AFTER_TRADE_DEADLINE && g.phase <= g.PHASE.PLAYOFFS ||
                offers.pids.length > 0 ||
                tmInfo.games.gp < 41 ) {
            return;
        }
        cond1 = tmInfo.isTaxPaying && 15 - tmInfo.expiring.count < 2;
        cond2 = tmInfo.salarySpace > g.salaryCap - g.minPayroll && offers.rosterSpace > 0;
        if (cond1 || cond2) {
            year = (tmInfo.games.winp < 0.55) ? g.season + random.randInt(1, 3): g.season;
            round = (Math.random > 0.9) ? 1 : 2;
            dpids = draftPicks.filter(function(dp) {
                return dp.season === year && dp.round === round;
            });
            if (dpids.length > 0) {
                console.log('draft pick on trading block');
                offers.dpids.push(dpids[0].dpid);
                offers.value = getAssetValue(dpids[0]);
                if (offers.dpidprotected.indexOf(dpids[0].dpid) >= 0) {
                    // Remove added asset from protected list
                    offers.dpidprotected.splice(offers.dpidprotected.indexOf(dpids[0].dpid), 1);
                }
            }
        }
    }

    function updateTradingBlock(tx, initialize, tids, empty) {
        var getTeamOffers, teamTradingSkip, updateTeamOffers;
        tx = dao.tx(["teams", "players", "playerStats", "draftPicks", "releasedPlayers"],
            "readwrite", tx);
        initialize = initialize || false;
        tids = tids || _.range(30);
        empty = empty || false;

        getTeamOffers = function(t, players, draftPicks, payroll) {
            var expDeals, info, offers, s, s3;

            info = getTeamTradingInfo(t, payroll);

            offers = {
                tid: t.tid,
                isRebuilding: info.isRebuilding,
                isTaxPaying: info.isTaxPaying,
                pids: [],
                dpids: [],
                salarySpace: Math.max(g.salaryCap - payroll[0], 0),
                rosterSpace: 15 - players.length,
                expiring: 0,                       // amount of expiring deals
                value: 0,                          // value of main trade asset
                reqValue: random.uniform(0.9, 1.1),  // percentage of value that must be met before an offer is accepted.
                contract: 0,
                priority: ["value"],
                pidprotected: _.pluck(_.filter(players, function(p) {
                    return p.rosterOrder <= 8;
                }), 'pid'),
                dpidprotected: _.pluck(draftPicks, 'dpid')
            };

            if (t.tid === g.userTid && g.autoPlaySeasons === 0) {
                t.offers = offers;
                return dao.teams.put({ot: tx, value: t});
            }

            if (!empty) {
                setTradeablePids(players, offers, info);
                setTradeableDpids(draftPicks, offers, info);
            }
            t.offers = offers;
            console.log(g.teamAbbrevsCache[t.tid], offers, offers.value);
            return dao.teams.put({ot: tx, value: t});
        };

        updateTeamOffers = function(tid) {
            if (teamTradingSkip[tid] > 0 && !initialize) {
                teamTradingSkip[tid]--;
                return;
            }

            return Promise.join(
                dao.teams.get({
                    ot: tx,
                    key: tid
                }),
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tid
                }),
                dao.draftPicks.getAll({
                    ot: tx,
                    index: "tid",
                    key: tid
                }),
                team.getPayroll(tx, tid),
                getTeamOffers
            )
            .then(function() {
                teamTradingSkip[tid] = random.randInt(0, 20);
            });
        };

        if (!localStorage.teamTradingSkip) {
            teamTradingSkip = _.range(30).map(function() {
                return random.randInt(0, 20);
            });
            localStorage.teamTradingSkip = JSON.stringify(teamTradingSkip);
        } else {
            teamTradingSkip = JSON.parse(localStorage.teamTradingSkip);
        }

        return Promise.map(tids, updateTeamOffers, {concurrency: tids.length})
            .then(function() {
                localStorage.teamTradingSkip = JSON.stringify(teamTradingSkip);
            });
    }

    function getTeamTradingInfo(t, payroll) {
        var expDeals, info, s, s3;
        s = _.last(t.seasons);
        s3 = t.seasons.slice(-3, -1);
        expDeals = payroll[1].filter(function(c) {
            return c.exp === g.season;
        });

        info = {
            isRebuilding: t.strategy === "rebuilding",
            salarySpace: Math.max(g.salaryCap - payroll[0], 0),
            cash: s.cash,
            luxuryTax: (payroll[0] > g.luxuryPayroll) ? payroll[0] - g.luxuryPayroll : 0,
            isTaxPaying: payroll[0] > g.luxuryPayroll,
            madePlayoffs: s.playoffRoundsWon >= 0,
            expiring: {
                amount: expDeals.reduce(function(a, b) {return a + b.amount;}, 0),
                count: expDeals.length
            },
            games: {
                winp: s.won / s.gp,
                gp: s.gp,
                hype: s.hype,
                won3: s3.reduce(function(a, b) {return a + b.won;}, 0),
                gp3: s3.reduce(function(a, b) {return a + b.gp;}, 0)
            }
        };

        return info;
    }

    function doCPUTrade(tx) {
        tx = dao.tx(["teams", "players", "releasedPlayers", "draftPicks"], "readwrite", tx);

        return dao.teams.getAll()
        .then(function(teams) {
            var i, order, result, tids, tmp, tradeNego;

            updateLocalTeamRankings(teams);
            if (g.autoPlaySeasons === 0) {
                teams = teams.filter(function(t) {
                    return t.tid !== g.userTid;
                });
            }
            random.shuffle(teams);
            tradeNego = [teams[0].offers, matchTradeTeams(teams[0], teams).offers];
            order = _.pluck(tradeNego, "tid");
            return evaluateTrade(null, tradeNego)
                .then(function(result) {
                    if (result[0]) {
                        // switch up order
                        if (order[0] !== result[1][0].tid) {
                            tmp = result[1][0];
                            result[1][0] = result[1][1];
                            result[1][1] = tmp;
                        }

                        return Promise.join(
                            result[0],
                            result[1],
                            summary(tradeNego),
                            doTrade
                        ).then(function(tradeResult) {
                            if (tradeResult[0]) {
                                tids = _.pluck(result[1], 'tid');
                                console.log("cpu trade success", g.teamAbbrevsCache[tids[0]], g.teamAbbrevsCache[tids[1]]);

                                if (freeAgents.hasOwnProperty("readyTeamsFA")) {
                                    return freeAgents.readyTeamsFA(null, tids)
                                    .then(function() {
                                        updateTradingBlock(null, true, tids, true);
                                    });
                                }
                                updateTradingBlock(null, true, tids, true);
                            } else {
                                console.log('trade failed');
                            }
                        });
                    }
                });
        });
    }

    function initiateTrades(tx) {
        tx = dao.tx(["teams", "players", "releasedPlayers", "draftPicks"], "readwrite", tx);

        return Promise.each(_.range(random.randInt(1, 3)), function() {
            // do at most 3 trades per day.
            return doCPUTrade(tx);
        }).then(function() {
            localStorage.skipTrading = random.randInt(0, 21);
        });
    }

    function tickCpuTradingDay(tx) {
        if (g.phase >= g.PHASE.AFTER_TRADE_DEADLINE && g.phase <= g.PHASE.PLAYOFFS) {
            return;
        }

        tx = dao.tx(["teams", "players", "releasedPlayers", "draftPicks"], "readwrite", tx);

        return updateTradingBlock(tx)
            .then(function() {
                if (!localStorage.skipTrading) {
                    localStorage.skipTrading = random.randInt(0, 10);
                }

                if (localStorage.skipTrading > 0) {
                    localStorage.skipTrading--;
                } else {
                    return initiateTrades(tx);
                }
            });
    }

    /** Erase later on */
    function gradePlayer(p, forSigning) {
        var age, composite, grade, potential, roster, skill, zAge;
        forSigning = forSigning || false;
        zAge = g.season - p.born.year;
        age = Math.max((4 - (zAge - 24)) / 4.0, 0);
        composite = gradeComposite(playerComposite(p.ratings));
        skill = p.ratings[p.ratings.length - 1].skills.length / 2;
        potential = p.ratings[p.ratings.length - 1].pot / 80;
        roster = (p.tid === -1) ? 0 : (14 - p.rosterOrder) / 14.0;
        if (forSigning) {
            return [age, potential, skill];
        }
        grade = (age + 1.5 * composite + potential + 0.5 * roster + 2 * skill) / 6;
        // if(grade > 0.6 || true) {
        //     console.log('age:', age, 'composite:', composite,
        //         'potential:', potential, 'roster:', roster, 'skill:', skill,
        //         'grade', grade, 'name:', p.name, p.value, zAge);
        // }
        return grade;
    }

    function gradeComposite (composite) {
        composite = _.omit(composite, ['pace', 'usage', 'turnovers', 'fouling']);
        composite = _.filter(_.values(composite), function (v) {
            return v > 0.6;
        });
        return composite.length / 10;
    }

    function playerComposite(ratings) {
        var cr, game, k, rating;
        game = require('core/game');
        cr = {};
        rating = _.find(ratings, function (x) {
            return x.season === g.season;
        });
        for (k in g.compositeWeights) {
            if (g.compositeWeights.hasOwnProperty(k)) {
                cr[k] = game.makeComposite(rating, g.compositeWeights[k].ratings, g.compositeWeights[k].weights);
            }
        }
        return cr;
    }
    /** end erase later */

    return {
        get: get,
        create: create,
        updatePlayers: updatePlayers,
        getOtherTid: getOtherTid,
        summary: summary,
        clear: clear,
        propose: propose,
        makeItWork: makeItWork,
        makeItWorkTrade: makeItWorkTrade,
        filterUntradable: filterUntradable,
        getPickValues: getPickValues,
        updateTradingBlock: updateTradingBlock,
        evaluateTrade: evaluateTrade,
        tickCpuTradingDay: tickCpuTradingDay,
        doCPUTrade: doCPUTrade
    };
});
