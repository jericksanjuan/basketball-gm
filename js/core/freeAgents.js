/**
 * @name core.freeAgents
 * @namespace Functions related to free agents that didn't make sense to put anywhere else.
 */
define(["dao", "globals", "ui", "core/player", "core/team", "core/game", "lib/bluebird", "lib/underscore", "util/eventLog", "util/helpers", "util/lock", "util/random"], function (dao, g, ui, player, team, game, Promise, _, eventLog, helpers, lock, random) {
    "use strict";

    /**
     * Exclude fields in searching for players.
     * @param  {object} compositeRatings objects with keys and values for composite player ratings.
     * @return {Array.string} fields to be included
     */
    function teamNeeds(compositeRatings) {
        var cr, notInclude;
        notInclude = ['pace', 'usage', 'turnovers', 'fouling', 'endurance', 'shootingFT']
        cr = _.omit(compositeRatings, notInclude);
        cr = _.pairs(cr).sort(function(a, b) {return a[1] - b[1]});
        return _.keys(_.object(cr));
    }

    /**
     * Group the team needs, at max 2 from the same category only.
     * @param  {Array.string} needs fields to be included
     * @return {Array.string}       final fields to include, max length 5.
     */
    function groupNeeds(needs) {
        var big, diff, defender, i, needsCopy, playmaker, shooter, tcount, ttype, wing, x;
        big = ['shootingLowPost', 'rebounding'];
        shooter = ['shootingMidRange', 'shootingThreePointer'];
        wing = ['athleticism', 'shootingAtRim'];
        playmaker = ['dribbling', 'passing'];
        defender = ['defense', 'defenseInterior', 'defensePerimeter', 'stealing', 'blocking'];

        tcount = [[], [], [], [], []];
        needsCopy = needs.slice();
        ttype = _.union(big, shooter, wing, playmaker, defender);

        for (i = 0; i < needs.length; i++) {
            x = ttype.indexOf(needs[i]);
            x = Math.min(Math.floor(x/2), 4);
            tcount[x].push(needs[i]);
        }
        for (i = 0; i < tcount.length; i++) {
            tcount[i] = tcount[i].slice(0, 2);
        }
        tcount = _.flatten(tcount);
        diff = _.difference(needs, tcount);
        return _.difference(needsCopy, diff).slice(0,5);
    }

    function makeOffer(t, players) {
        var fp, needs, i, offers, pp, rosterSpace, salaryOffered, salarySpace, toRemove;
        return Promise.try(function() {
            offers = [];
            fp = helpers.deepCopy(players);

            console.log(t.region, t.fa.salarySpace);
            needs = teamNeeds(t.fa.compositeRating);
            needs = groupNeeds(needs);
            salarySpace = t.fa.salarySpace;
            rosterSpace = t.fa.rosterSpace;
            for (i = 0; i < needs.length; i++) {
                // filter by criteria and salary
                pp = fp.filter(function(p) {
                    return p.compositeRating[needs[i]] > t.fa.compositeRating[needs[i]] &&
                        p.contract.amount <= salarySpace;
                });
                // sort by rating and salary value.
                pp = pp.sort(function(a, b) {
                    var r = 0;
                    r = b.compositeRating[needs[i]] -  a.compositeRating[needs[i]];
                    return (r === 0) ? b.contract.amount/b.value - a.contract.amount/a.value : r;
                });
                if (pp.length > 0) {
                    offers.push({
                        tid: t.tid,
                        pid: pp[0].pid,
                        amount: pp[0].contract.amount,
                        exp: pp[0].contract.exp
                    })
                    salarySpace -= pp[0].contract.amount;
                    rosterSpace -= 1;
                    if (rosterSpace === 0) {
                        i = needs.length;
                    }
                }
            }
            return offers;
        });
    }

    function decideContract(tx, p, maxSalarySpace) {
        return Promise.try(function() {
            if (p.contract.amount > maxSalarySpace) {
                // accept reduced salary and play for just a year.
                p.contract.amount = maxSalarySpace;
                p.contract.exp = g.season + 1;
            }
            return p;
            // return dao.players.put({ot: tx, value: p}).then(function(p) {
            //     return p;
            // });
        })

        // Decide on current offers
        // If negative check if salary demand is > maxSalarySpace
        // Reduce salary demand if true.
        //
        // If positive, set team, sign contract and reduce salarySpace and
        // roster spot of team.
        // save p and t;
        // announce signing;
    }

    function tickFreeAgencyDay(tx) {
        return Promise.join(
            dao.teams.getAll({ot: tx}),
            dao.players.getAll({ot: tx, index: "tid", key: g.PLAYER.FREE_AGENT}),
            function(teams, players) {
                var maxSalarySpace, offers, t, p, i;
                offers = [];
                teams.sort(function(a, b) {
                    return b.fa.salarySpace - a.fa.salarySpace;});
                maxSalarySpace = teams[0].fa.salarySpace;
                players.sort(function(a, b) {
                    return b.contract.amount - a.contract.amount;
                });

                for (i = 0; i < teams.length; i++) {
                    if (teams[i].fa.rosterSpace > 0 ) {
                        offers.push(makeOffer(teams[i], players));
                    }
                }

                return Promise.all(offers)
                    .then(function(offers) {
                        var decisions;
                        console.log(offers);
                        decisions = [];
                        for (i = 0; i < players.length; i++) {
                            decisions.push(decideContract(tx, players[i], maxSalarySpace));
                        }
                        return Promise.each(decisions, function(d) {
                            // console.log(d);
                        });
                    });
            }
        );
    }

    /**
     * Ready all teams for free agency.
     */
    function readyTeamsFA(tx) {
        var i, promises, readyTeam, sumContracts, teamComposite;
        tx = dao.tx(["players", "releasedPlayers", "teams"], "readwrite", tx);
        promises = [];

        sumContracts = function(players) {
            return players.reduce(function(a, b) {
                return a + b.contract.amount;
            }, 0);
        };

        teamComposite = function(players, numOfPlayers) {
            var i, k, tc;
            numOfPlayers = (numOfPlayers > players.length) ? players.length - 1 : numOfPlayers;
            tc = {}
            for (k in g.compositeWeights) {
                if (g.compositeWeights.hasOwnProperty(k)) {
                    for (i = 0; i < numOfPlayers; i++) {
                        if (tc.hasOwnProperty(k)) {
                            tc[k] += players[i].compositeRating[k];
                        } else {
                            tc[k] = players[i].compositeRating[k];
                        }
                    }
                    tc[k] /= numOfPlayers;
                }
            }
            return tc;
        }

        readyTeam = function(t) {
            var team = t.team;
            team.fa = {};

            team.fa.compositeRating = teamComposite(t.player, 7);
            // team.fa.synergy
            team.fa.rosterSpace = Math.max(0, 15 - t.player.length);
            team.fa.salarySpace = Math.max(0, g.salaryCap - sumContracts(t.player));
            team.fa.salarySpace = Math.max(team.fa.salarySpace, g.minContract);

            team.fa.fuzzValue = player.genFuzz(t.scoutingRank);
            return team;
        };

        for (i = 0; i < g.numTeams; i++) {
            promises.push(game.loadTeam(i, tx, true));
        }

        return Promise.all(promises)
            .then(function(teams) {
                _.each(teams, function(t) {
                    var team = readyTeam(t);
                    dao.teams.put({ot: tx, value: team}).then(function(t) {
                        return;
                    });
                })
            })
    }

    /**
     * Save composite rating.
     */
    function readyPlayersFA(tx) {
        var readyPlayer, playerComposite;
        tx = dao.tx(["players", "releasedPlayers", "teams"], "readwrite", tx);

        playerComposite = function(ratings) {
            var cr, k, rating;
            cr = {};
            rating = _.find(ratings, function(x) { return x.season === g.season });
            for (k in g.compositeWeights) {
                if (g.compositeWeights.hasOwnProperty(k)) {
                    cr[k] = game.makeComposite(rating, g.compositeWeights[k].ratings, g.compositeWeights[k].weights);
                }
            }
            return cr;
        }

        readyPlayer = function(_void, baseMoods) {
            return dao.players.iterate({
                ot: tx,
                index: "tid",
                key: IDBKeyRange.bound(g.PLAYER.UNDRAFTED, g.PLAYER.FREE_AGENT),
                callback: function (p) {
                    p.offers = {}
                    p.compositeRating = playerComposite(p.ratings)
                    return player.addToFreeAgents(tx, p, g.PHASE.FREE_AGENCY, baseMoods);
                }
            });
        };

        return Promise.join(
            require('core/contractNegotiation').cancelAll(),
            player.genBaseMoods(tx),
            readyPlayer
        );
    }

    /**
     * AI teams sign free agents.
     *
     * Each team (in random order) will sign free agents up to their salary cap or roster size limit. This should eventually be made smarter
     *
     * @memberOf core.freeAgents
     * @return {Promise}
     */
    function autoSign(tx) {
        tx = dao.tx(["players", "playerStats", "releasedPlayers", "teams"], "readwrite", tx);

        return Promise.all([
            team.filter({
                ot: tx,
                attrs: ["strategy"],
                season: g.season
            }),
            dao.players.getAll({
                ot: tx,
                index: "tid",
                key: g.PLAYER.FREE_AGENT
            })
        ]).spread(function (teams, players) {
            var i, strategies, tids;

            strategies = _.pluck(teams, "strategy");

            // List of free agents, sorted by value
            players.sort(function (a, b) { return b.value - a.value; });

            if (players.length === 0) {
                return;
            }

            // Randomly order teams
            tids = [];
            for (i = 0; i < g.numTeams; i++) {
                tids.push(i);
            }
            random.shuffle(tids);

            return Promise.each(tids, function(tid) {
                // Skip the user's team
                if (g.userTids.indexOf(tid) >= 0 && g.autoPlaySeasons === 0) {
                    return;
                }

                // Small chance of actually trying to sign someone in free agency, gets greater as time goes on
                if (g.phase === g.PHASE.FREE_AGENCY && Math.random() < 0.99 * g.daysLeft / 30) {
                    return;
                }

                // Skip rebuilding teams sometimes
                if (strategies[tid] === "rebuilding" && Math.random() < 0.7) {
                    return;
                }

/*                    // Randomly don't try to sign some players this day
                while (g.phase === g.PHASE.FREE_AGENCY && Math.random() < 0.7) {
                    players.shift();
                }*/

                return Promise.all([
                    dao.players.count({
                        ot: tx,
                        index: "tid",
                        key: tid
                    }),
                    team.getPayroll(tx, tid).get(0)
                ]).spread(function (numPlayersOnRoster, payroll) {
                    var i, p;

                    if (numPlayersOnRoster < 15) {
                        for (i = 0; i < players.length; i++) {
                            // Don't sign minimum contract players to fill out the roster
                            if (players[i].contract.amount + payroll <= g.salaryCap || (players[i].contract.amount === g.minContract && numPlayersOnRoster < 13)) {
                                p = players[i];
                                p.tid = tid;
                                if (g.phase <= g.PHASE.PLAYOFFS) { // Otherwise, not needed until next season
                                    p = player.addStatsRow(tx, p, g.phase === g.PHASE.PLAYOFFS);
                                }
                                p = player.setContract(p, p.contract, true);
                                p.gamesUntilTradable = 15;

                                eventLog.add(null, {
                                    type: "freeAgent",
                                    text: 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[p.tid], g.season]) + '">' + g.teamNamesCache[p.tid] + '</a> signed <a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a> for ' + helpers.formatCurrency(p.contract.amount / 1000, "M") + '/year through ' + p.contract.exp + '.',
                                    showNotification: false,
                                    pids: [p.pid],
                                    tids: [p.tid]
                                });

                                players.splice(i, 1); // Remove from list of free agents

                                // If we found one, stop looking for this team
                                return dao.players.put({ot: tx, value: p}).then(function () {
                                    return team.rosterAutoSort(tx, tid);
                                });
                            }
                        }
                    }
                });
            });
        });
    }

    /**
     * Decrease contract demands for all free agents.
     *
     * This is called after each day in the regular season, as free agents become more willing to take smaller contracts.
     *
     * @memberOf core.freeAgents
     * @return {Promise}
     */
    function decreaseDemands() {
        var tx;

        tx = dao.tx("players", "readwrite");

        dao.players.iterate({
            ot: tx,
            index: "tid",
            key: g.PLAYER.FREE_AGENT,
            callback: function (p) {
                var i;

                // Decrease free agent demands
                p.contract.amount -= 50;
                if (p.contract.amount < 500) {
                    p.contract.amount = 500;
                }

                if (g.phase !== g.PHASE.FREE_AGENCY) {
                    // Since this is after the season has already started, ask for a short contract
                    if (p.contract.amount < 1000) {
                        p.contract.exp = g.season;
                    } else {
                        p.contract.exp = g.season + 1;
                    }
                }

                // Free agents' resistance to signing decays after every regular season game
                for (i = 0; i < p.freeAgentMood.length; i++) {
                    p.freeAgentMood[i] -= 0.075;
                    if (p.freeAgentMood[i] < 0) {
                        p.freeAgentMood[i] = 0;
                    }
                }

                // Also, heal.
                if (p.injury.gamesRemaining > 0) {
                    p.injury.gamesRemaining -= 1;
                } else {
                    p.injury = {type: "Healthy", gamesRemaining: 0};
                }

                return p;
            }
        });

        return tx.complete();
    }

    /**
     * Get contract amount adjusted for mood.
     *
     * @memberOf core.freeAgents
     * @param {number} amount Contract amount, in thousands of dollars or millions of dollars (fun auto-detect!).
     * @param {number} mood Player mood towards a team, from 0 (happy) to 1 (angry).
     * @return {number} Contract amoung adjusted for mood.
     */
    function amountWithMood(amount, mood) {
        amount *= 1 + 0.2 * mood;

        if (amount >= g.minContract) {
            if (amount > g.maxContract) {
                amount = g.maxContract;
            }
            return helpers.round(amount / 10) * 10;  // Round to nearest 10k, assuming units are thousands
        }

        if (amount > g.maxContract / 1000) {
            amount = g.maxContract / 1000;
        }
        return helpers.round(amount * 100) / 100;  // Round to nearest 10k, assuming units are millions
    }

    /**
     * Will a player negotiate with a team, or not?
     *
     * @param {number} amount Player's desired contract amount, already adjusted for mood as in amountWithMood, in thousands of dollars
     * @param {number} mood Player's mood towards the team in question.
     * @return {boolean} Answer to the question.
     */
    function refuseToNegotiate(amount, mood) {
        if (amount * mood > 10000) {
            return true;
        }

        return false;
    }

    /**
     * Simulates one or more days of free agency.
     *
     * @memberOf core.freeAgents
     * @param {number} numDays An integer representing the number of days to be simulated. If numDays is larger than the number of days remaining, then all of free agency will be simulated up until the preseason starts.
     * @param {boolean} start Is this a new request from the user to simulate days (true) or a recursive callback to simulate another day (false)? If true, then there is a check to make sure simulating games is allowed. Default true.
     */
    function play(numDays, start) {
        var cbNoDays, cbRunDay, phase;

        start = start !== undefined ? start : true;
        phase = require("core/phase");

        // This is called when there are no more days to play, either due to the user's request (e.g. 1 week) elapsing or at the end of free agency.
        cbNoDays = function () {
            require("core/league").setGameAttributesComplete({gamesInProgress: false}).then(function () {
                ui.updatePlayMenu(null).then(function () {
                    // Check to see if free agency is over
                    if (g.daysLeft === 0) {
                        phase.newPhase(g.PHASE.PRESEASON).then(function () {
                            ui.updateStatus("Idle");
                        });
                    }
                });
            });
        };

        // This simulates a day, including game simulation and any other bookkeeping that needs to be done
        cbRunDay = function () {
            var cbYetAnother;

            // This is called if there are remaining days to simulate
            cbYetAnother = function () {
                decreaseDemands().then(function () {
                    autoSign().then(function () {
                        require("core/league").setGameAttributesComplete({daysLeft: g.daysLeft - 1, lastDbChange: Date.now()}).then(function () {
                            if (g.daysLeft > 0 && numDays > 0) {
                                ui.realtimeUpdate(["playerMovement"], undefined, function () {
                                    ui.updateStatus(g.daysLeft + " days left");
                                    play(numDays - 1, false);
                                });
                            } else if (g.daysLeft === 0) {
                                cbNoDays();
                            }
                        });
                    });
                });
            };

            if (numDays > 0) {
                // If we didn't just stop games, let's play
                // Or, if we are starting games (and already passed the lock), continue even if stopGames was just seen
                if (start || !g.stopGames) {
                    if (g.stopGames) {
                        require("core/league").setGameAttributesComplete({stopGames: false}).then(cbYetAnother);
                    } else {
                        cbYetAnother();
                    }
                }
            } else if (numDays === 0) {
                // If this is the last day, update play menu
                cbNoDays();
            }
        };

        // If this is a request to start a new simulation... are we allowed to do
        // that? If so, set the lock and update the play menu
        if (start) {
            lock.canStartGames(null).then(function (canStartGames) {
                if (canStartGames) {
                    require("core/league").setGameAttributesComplete({gamesInProgress: true}).then(function () {
                        ui.updatePlayMenu(null).then(function () {
                            cbRunDay();
                        });
                    });
                }
            });
        } else {
            cbRunDay();
        }
    }

    return {
        autoSign: autoSign,
        decreaseDemands: decreaseDemands,
        amountWithMood: amountWithMood,
        refuseToNegotiate: refuseToNegotiate,
        play: play,
        readyTeamsFA: readyTeamsFA,
        readyPlayersFA: readyPlayersFA,
        tickFreeAgencyDay: tickFreeAgencyDay
    };
});
