  /**
 * @name core.trade
 * @namespace Trades between the user's team and other teams.
 */
define(["dao", "globals", "core/league", "core/season", "core/player", "core/team", "lib/bluebird", "lib/underscore", "util/eventLog", "util/helpers", "util/random", "util/tradeHelpers"], function (dao, g, league, season, player, team, Promise, _, eventLog, helpers, random, th) {
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

    function _getTeamInfo(tx, teamr) {
        return Promise.all([
            team.getPayroll(tx, teamr.tid)
        ])
        .spread(function(payrollr) {
            var info = {};

            var payroll = payrollr[0];

            info.isRebuilding = teamr.strategy === 'rebuilding';
            info.isContending =  teamr.strategy === 'contending';

            var beforePO = g.phase < g.PHASE.PLAYOFFS;

            var seasons = teamr.seasons.reverse().slice(0,3);    // get only last three seasons
            var current = seasons[0];

            info.cash = current.cash;
            info.hype = current.hype;


            info.isLottery = beforePO ? current.won/(current.won+current.lost) < 0.55 : current.playoffRoundsWon === -1;
            info.isPlayoff = !info.isLottery;
            info.isFavorite = current.won/(current.won+current.lost) > 0.73;
            info.isChampion = current.playoffRoundsWon === 4;

            var starterMoney, starMoney;
            starterMoney = 0.5*g.maxContract;
            starMoney = 0.9*g.maxContract;

            info.payroll = payroll;
            info.hasSpace = payroll < g.salaryCap;
            info.capSpace = g.salaryCap - payroll;
            info.hasSpaceForRole = info.capSpace >= 5000;
            info.hasSpaceForStart = info.capSpace >= starterMoney;
            info.hasSpaceForMax = info.capSpace >= starMoney;

            info.salaryPaid = current.payrollEndOfSeason;
            info.salary = beforePO ? info.payroll : info.salaryPaid;
            info.isTaxPaying = info.payroll > g.luxuryPayroll;

            info.hasLosingRec = current.won/(current.won+current.lost) < 0.55;
            info.hasLosingRecForTwo = seasons.slice(0,2).map(th.getWs).reduce(th.sumf) / seasons.slice(0,2).map(th.getWLs).reduce(th.sumf) < 0.55;
            info.hasLosingRecForThree = seasons.map(th.getWs).reduce(th.sumf) / seasons.map(th.getWLs).reduce(th.sumf) < 0.55;
            info.losingRecForThree = seasons.map(th.getWs).reduce(th.sumf) / seasons.map(th.getWLs).reduce(th.sumf);

            info.team = teamr;
            info.tid = teamr.tid;

            return info;
        });
    }

    function getTeamInfo(tx) {
        return function() {
            return _getTeamInfo(tx, arguments[0]);
        };
    }

    function genTradeScenarios(tm1, teams) {
        var SCENARIOS = [
            'expstarter',
            'exprole',
            'disgruntled',
            'freespace',
            'lesstax',
            'tradepick',
            'dumppick'
        ];
        var possible = ['exprole'];
        var t = tm1;

        if (t.isRebuilding) {
            console.log('is rebuilding');
            // Rebuilding teams
            if (t.isTaxPaying) {
                possible.push('lesstax');  // even useful players
            }

            if (t.hasLosingRec) {
                possible.push('expstarter');
                possible.push('freespace');

                if(t.hasLosingRecForTwo && t.hasLosingRecForThree && t.hype===0) {
                    possible.push('disgruntled');  // get best trade for star
                }
            }

            if (t.hasSpaceForStart) {
                possible.push('tradepick');     // chance to get good players
            }

        } else {
            console.log('is contending');

            // Contending teams
            if (t.isTaxPaying) {
                if(t.isLottery && t.hasLosingRecForTwo) {
                    possible.push('lesstax');  // even starters
                }

                if(t.isLottery) {
                    possible.push('expstarter'); // target teams with space.
                }
            }

            if (t.hasSpaceForRole && t.isPlayoff) {  // use pick or expiring contracts to make deals for useful assets.
                possible.push('dumppick');
            }

            if (t.isFavorite) {
                possible.push('dumppick');
            }

            if (t.hasLosingRecForThree) {
                possible.push('lesstax');
            }

        }
        console.log(possible);

        // Select team first, then use a weighted scenario.

        var exprole, expstarter, disgruntled, freespace, lesstax, tradepick, dumppick, outcomes;


        // contending || salary > luxury tax && rebuilding
        // contending && losing record;
        exprole = function(tx, tm1, teams) {
            console.log('Dealing expiring contracts');
            var pid, tm2, ft;
            teams = teams;

            ft = teams.filter(function(o) {return o.isRebuilding; });
            tm2 = th.randomTeam(ft);

            return Promise.all(
                [
                    dao.players.getAll({
                        ot: tx,
                        index: "tid",
                        key: tm1.tid
                    }),
                ])
                .spread(function (players) {
                    console.debug(tm1, tm2);

                    players = players.filter(
                        th.andF(th.expThisSeason, th.atLeastFive, th.roleplayers));
                    if(tm1.isRebuilding) {
                        players =  players.filter(th.areVeterans);
                    }

                    if (players.length === 0)
                        return false;
                    players = players.sort(th.highToLow);
                    players = players.slice(0,3);
                    console.log('selection', players);
                    pid = random.choice(players).pid;

                    var output = [];
                    output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                    output.push({ tid: tm2.tid, pids: [], dpids:[]});

                    return Promise.try(function() {return output; });
                });

        };

        expstarter = function(tx, tm1, teams) {
            console.log('Dealing expiring contracts');
            var pid, tm2, ft;

            ft = teams.filter(th.andF(
                function(o) {return o.isRebuilding; },
                function(o) {return o.hasSpaceForStart; }
            ));
            if (ft.length === 0) {
                ft = teams.filter(function(o) { return o.isRebuilding; });
            }
            tm2 = th.randomTeam(ft);

            return Promise.all(
                [
                    dao.players.getAll({
                        ot: tx,
                        index: "tid",
                        key: tm1.tid
                    }),
                ])
                .spread(function (players) {
                    players = players.filter(
                        th.andF(th.expThisSeason, th.atLeastFive,
                            th.orF(th.roleplayers, th.starters)));
                    if (tm1.isRebuilding) {
                        players = players.filter(th.areVeterans);
                    }

                    if (players.length === 0)
                        return false;
                    players = players.sort(th.highToLow);
                    players = players.slice(0,3);
                    console.log('selection', players);
                    pid = random.choice(players).pid;

                    var output = [];
                    output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                    output.push({ tid: tm2.tid, pids: [], dpids:[]});

                    return Promise.try(function() {return output; });
                });

        };

        disgruntled = function(tx, tm1, teams) {
            console.log('have to trade disgruntled star');
            var pid, tm2, ft;

            ft = teams.filter(th.andF(
                function(o) {return o.isRebuilding; },
                function(o) {return o.hasSpaceForMax; }
            ));
            if (ft.length === 0) {
                ft = teams.filter(function(o) { return o.isRebuilding; });
            }
            tm2 = th.randomTeam(ft);

            return Promise.all(
                [
                    dao.players.getAll({
                        ot: tx,
                        index: "tid",
                        key: tm1.tid
                    }),
                ])
                .spread(function (players) {
                    players = players.filter(
                        th.andF(th.expThisSeason, th.stars));

                    if (players.length === 0)
                        return false;
                    players = players.sort(th.oldestFirst);
                    players = players.slice(0,3);
                    console.log('selection', players);
                    pid = random.choice(players).pid;

                    var output = [];
                    output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                    output.push({ tid: tm2.tid, pids: [], dpids:[]});

                    return Promise.try(function() {return output; });
                });
        };

        // salary > luxury tax
        // rebuilding, give up players with years remaining in contract to teams with space
        // look for players with expiring deals
        freespace = function(tx, tm1, teams) {
            console.log('trading for expiring deals');
            var pid, tm2, ft, pid2;

            ft = teams.filter(th.andF(
                function(o) {return o.hasSpaceForStart; }
            ));
            if (ft.length === 0) {
                ft = teams;
            }
            tm2 = th.randomTeam(ft);

            return Promise.all(
                [
                    dao.players.getAll({
                        ot: tx,
                        index: "tid",
                        key: tm1.tid
                    }),
                    dao.players.getAll({
                        ot: tx,
                        index: "tid",
                        key: tm2.tid
                    }),
                ])
                .spread(function (players, others) {
                    players = players.filter(th.andF(
                        th.notF(th.expThisSeason),
                        th.roleplayers,
                        th.atLeastFive
                        )
                    );

                    if (players.length === 0)
                        return false;
                    players = players.sort(th.costlyFirst);
                    players = players.slice(0,3);
                    console.log('selection', players);
                    pid = random.choice(players).pid;

                    others = others.filter(th.andF(
                        th.expThisSeason,
                        th.atLeastFive
                    ));
                    others = others.sort(th.costlyFirst);
                    others = players.slice(0,3);
                    pid2 = random.choice(others).pid;

                    var output = [];
                    output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                    output.push({ tid: tm2.tid, pids: [pid2], dpids:[]});

                    return Promise.try(function() {return output; });
                });
        };

        lesstax = function(tx, tm1, teams) {
            console.log('moving assets to free lessen tax');
            var pid, tm2, ft;

            ft = teams.filter(th.andF(
                function(o) {return o.hasSpaceForStart; }
            ));
            if (ft.length === 0) {
                ft = teams;
            }
            tm2 = th.randomTeam(ft);

            return Promise.all(
                [
                    dao.players.getAll({
                        ot: tx,
                        index: "tid",
                        key: tm1.tid
                    }),
                ])
                .spread(function (players) {
                    players = players.filter(th.andF(
                        th.notF(th.expThisSeason),
                        th.orF(th.roleplayers, th.starters),
                        th.atLeastFive
                        )
                    );

                    if (players.length === 0)
                        return false;
                    players = players.sort(th.costlyFirst);
                    players = players.slice(0,3);
                    console.log('selection', players);
                    pid = random.choice(players).pid;

                    var output = [];
                    output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                    output.push({ tid: tm2.tid, pids: [], dpids:[]});

                    return Promise.try(function() {return output; });
                });
        };

        // contending, offer pick(s) for role players with skills
        tradepick = function(tx, tm1, teams) {
            console.log('trading pick for player with value');
            return Promise.try(function() {return false; });
        };

        dumppick = function(tx, tm1, teams) {
            console.log('dumping pick for future');
            return Promise.try(function() {return false; });
        };


        outcomes = {
            disgruntled: disgruntled,
            freespace: freespace,
            lesstax: lesstax,
            exprole: exprole,
            expstarter: expstarter,
            tradepick: tradepick,
            dumppick: dumppick
        };
        var choice = random.choice(SCENARIOS);
        return [outcomes[choice], tm1, teams];
    }

    function _createSimTrade(tradeChance) {
        var tx, tm1, teams, executeScene, next;
        teams = [];

        if (Math.random() > tradeChance) {
            return;
        }

        if (g.phase >= g.PHASE.AFTER_TRADE_DEADLINE && g.phase <= g.PHASE.PLAYOFFS) {
            return;
        }
        console.log('creating trade...');

        tx = dao.tx(["players", "teams", "releasedPlayers"], 'readwrite');
        var mapFunc = getTeamInfo(tx);


        Promise.try(function() {
            return dao.teams.getAll({
                ot: tx
            });
        })
        .map(mapFunc)
        .error(function(e) {
            console.error("error reading database.", e.message);
        })
        .then(function(teams) {
            tm1 = th.randomTeam(teams);
            return genTradeScenarios(tm1, teams);
        })
        .error(function(e) {
            console.error("error reading database.", e.message);
        })
        .then(function(results) {
            if (!results[0]) {
                console.warn('no executeScene');
                return;
            }

            results[0](tx, results[1], results[2])
                .then(function(tradeTeams) {
                    if(!tradeTeams) {
                        console.log('Trade not found');
                        return;
                    }

                    return Promise.all([
                        getPickValues(),
                    ])
                    .spread(function (estValues) {
                        return makeItWork(tradeTeams, false, estValues).spread(function (found, tradeTeams) {
                            if(!found) {
                                console.log('Trade not found');
                                return;
                            }

                            console.log(tradeTeams);
                            applyTrade(tradeTeams);
                        });
                    });

                });
        });

    }

    function createSimTrade() {
        // Base occurrence on remaining days of season
        return season.getDaysLeftSchedule().then(function (schedule) {
            var  tradeChance;
            if (schedule > 50) {
                tradeChance = 0.25;
            } else if(schedule <= 50 && schedule >= 28) {
                tradeChance = 0.8;
            } else if(g.phase === g.PHASE.FREE_AGENCY) {
                tradeChance = 0.7;
            } else {
                tradeChance = 0.0;
            }
            tradeChance = 1.0;
            return _createSimTrade(tradeChance);
        });
    }

    function applyTrade(teams) {
        var dpids, pids, tids, forceTrade;

        tids = [teams[0].tid, teams[1].tid];
        pids = [teams[0].pids, teams[1].pids];
        dpids = [teams[0].dpids, teams[1].dpids];

        return summary(teams).then(function (s) {
            var outcome;
            // FIXME: promises not yet done here?
            if (s.warning) {
                console.warn('Invalid trade.');
                return [false, null];
            }
            console.log('summary', s);
            console.log('--');

            outcome = "rejected"; // Default

            return team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids, null).then(function (dv) {
                var formatAssetsEventLog, tx;

                tx = dao.tx(["draftPicks", "players", "playerStats"], "readwrite");

                if (dv > 0 || forceTrade) {
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
                                //p.gamesUntilTradable = 15;
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
                            console.log('nothing', t);
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
                    var eventText = 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[tids[0]], g.season]) + '">' + g.teamNamesCache[tids[0]] + '</a> traded ' + formatAssetsEventLog(s.teams[0]) + ' to the <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[tids[1]], g.season]) + '">' + g.teamNamesCache[tids[1]] + '</a> for ' + formatAssetsEventLog(s.teams[1]) + '.';
                    console.info(eventText);
                    eventLog.add(null, {
                        type: "trade",
                        text: eventText,
                        showNotification: true,
                        pids: pids[0].concat(pids[1]),
                        tids: tids.concat(28)  //Temp log all trades;
                    });
                }
            });

            if (outcome === "accepted") {
                return clear().then(function () { // This includes dbChange
                    // Auto-sort CPU team roster
                    team.rosterAutoSort(null, tids[0]);
                    return team.rosterAutoSort(null, tids[1]);

                });
            }
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
            var dpids, pids, tids;

            tids = [teams[0].tid, teams[1].tid];
            pids = [teams[0].pids, teams[1].pids];
            dpids = [teams[0].dpids, teams[1].dpids];

            // The summary will return a warning if (there is a problem. In that case,
            // that warning will already be pushed to the user so there is no need to
            // return a redundant message here.
            return summary(teams).then(function (s) {
                var outcome;

                if (s.warning && !forceTrade) {
                    return [false, null];
                }

                outcome = "rejected"; // Default

                return team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids, null).then(function (dv) {
                    var formatAssetsEventLog, tx;

                    tx = dao.tx(["draftPicks", "players", "playerStats"], "readwrite");

                    if (dv > 0 || forceTrade) {
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
                                    //p.gamesUntilTradable = 15;
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
        var estValues, i, promises, doProcess;

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
            return makeItWork(helpers.deepCopy(teams0), false, estValues).spread(function (found, teams) {
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
        createSimTrade: createSimTrade
    };
});
