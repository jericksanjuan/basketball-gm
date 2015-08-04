/**
 * @name core.phase
 * @namespace Anything related to moving between phases of the game (e.g. regular season, playoffs, draft, etc.).
 */
define(["dao", "globals", "ui", "core/contractNegotiation", "core/draft", "core/finances", "core/freeAgents", "core/player", "core/season", "core/team", "lib/bluebird", "lib/underscore", "util/account", "util/ads", "util/eventLog", "util/helpers", "util/lock", "util/message", "util/random"], function (dao, g, ui, contractNegotiation, draft, finances, freeAgents, player, season, team, Promise, _, account, ads, eventLog, helpers, lock, message, random) {
    "use strict";

    var phaseChangeTx;

    /**
     * Common tasks run after a new phrase is set.
     *
     * This updates the phase, executes a callback, and (if necessary) updates the UI. It should only be called from one of the NewPhase* functions defined below.
     *
     * @memberOf core.phase
     * @param {number} phase Integer representing the new phase of the game (see other functions in this module).
     * @param {string=} url Optional URL to pass to ui.realtimeUpdate for redirecting on new phase. If undefined, then the current page will just be refreshed.
     * @param {Array.<string>=} updateEvents Optional array of strings.
     * @return {Promise}
     */
    function finalize(phase, url, updateEvents) {
        updateEvents = updateEvents !== undefined ? updateEvents : [];

        // Set phase before updating play menu
        return require("core/league").setGameAttributesComplete({phase: phase, phaseChangeInProgress: false}).then(function () {
            ui.updatePhase(g.season + " " + g.PHASE_TEXT[phase]);
            return ui.updatePlayMenu(null).then(function () {
                // Set lastDbChange last so there is no race condition (WHAT DOES THIS MEAN??)
                require("core/league").updateLastDbChange();
                updateEvents.push("newPhase");
                ui.realtimeUpdate(updateEvents, url);
            });
        }).then(function () {
            // If auto-simulating, initiate next action
            if (g.autoPlaySeasons > 0) {
                // Not totally sure why setTimeout is needed, but why not?
                setTimeout(function () {
                    require("core/league").autoPlay();
                }, 100);
            }
        });
    }

    function newPhasePreseason(tx) {
         // Important: do this before changing the season or contracts and stats are fucked up
        return require("core/league").setGameAttributes(tx, {season: g.season + 1})
            .then(function () {
            var coachingRanks, scoutingRank;

            coachingRanks = [];

            // Add row to team stats and season attributes
            return dao.teams.iterate({
                ot: tx,
                callback: function (t) {
                    // Save the coaching rank for later
                    coachingRanks[t.tid] = _.last(t.seasons).expenses.coaching.rank;

                    // Only need scoutingRank for the user's team to calculate fuzz when ratings are updated below.
                    // This is done BEFORE a new season row is added.
                    if (t.tid === g.userTid) {
                        scoutingRank = finances.getRankLastThree(t, "expenses", "scouting");
                    }

                    t = team.addSeasonRow(t);
                    t = team.addStatsRow(t);

                    return t;
                }
            }).then(function () {
                // Loop through all non-retired players
                return dao.players.iterate({
                    ot: tx,
                    index: "tid",
                    key: IDBKeyRange.lowerBound(g.PLAYER.FREE_AGENT),
                    callback: function (p) {
                        // Update ratings
                        p = player.addRatingsRow(p, scoutingRank);
                        p = player.develop(p, 1, false, coachingRanks[p.tid]);

                        // Update player values after ratings changes
                        return player.updateValues(tx, p, []).then(function (p) {
                            // Add row to player stats if they are on a team
                            if (p.tid >= 0) {
                                p = player.addStatsRow(tx, p, false);
                            }
                            return p;
                        });
                    }
                });
            }).then(function () {
                if (g.autoPlaySeasons > 0) {
                    return require("core/league").setGameAttributes(tx, {autoPlaySeasons: g.autoPlaySeasons - 1});
                }
            }).then(function() {
                return Promise.join(
                        team.allRostersAutoSort(tx),
                        freeAgents.readyPlayersFA(tx)
                    )
            }).then(function () {
                if (g.enableLogging && !window.inCordova) {
                    ads.show();
                }
                team.checkRosterSizes();

                return [undefined, ["playerMovement"]];
            });
        });
    }

    function newPhaseRegularSeason(tx) {
        return dao.teams.getAll({ot: tx}).then(function (teams) {
            return season.setSchedule(tx, season.newSchedule(teams));
        }).then(function () {
            // First message from owner
            if (g.showFirstOwnerMessage) {
                return message.generate(tx, {wins: 0, playoffs: 0, money: 0});
            }

            // Spam user with another message?
            if (localStorage.nagged === "true") {
                // This used to store a boolean, switch to number
                localStorage.nagged = "1";
            }

            if (g.season === g.startingSeason + 3 && g.lid > 3 && !localStorage.nagged) {
                localStorage.nagged = "1";
                return dao.messages.add({
                    ot: tx,
                    value: {
                        read: false,
                        from: "The Commissioner",
                        year: g.season,
                        text: '<p>Hi. Sorry to bother you, but I noticed that you\'ve been playing this game a bit. Hopefully that means you like it. Either way, we would really appreciate some feedback so we can make this game better. <a href="mailto:commissioner@basketball-gm.com">Send an email</a> (commissioner@basketball-gm.com) or <a href="http://www.reddit.com/r/BasketballGM/">join the discussion on Reddit</a>.</p>'
                    }
                });
            }
            if ((localStorage.nagged === "1" && Math.random() < 0.25) || (localStorage.nagged === "2" && Math.random < 0.025)) {
                localStorage.nagged = "2";
                return dao.messages.add({
                    ot: tx,
                    value: {
                        read: false,
                        from: "The Commissioner",
                        year: g.season,
                        text: '<p>Hi. Sorry to bother you again, but if you like the game, please share it with your friends! Also:</p><p><a href="https://twitter.com/basketball_gm">Follow Basketball GM on Twitter</a></p><p><a href="https://www.facebook.com/basketball.general.manager">Like Basketball GM on Facebook</a></p><p><a href="http://www.reddit.com/r/BasketballGM/">Discuss Basketball GM on Reddit</a></p><p>The more people that play Basketball GM, the more motivation I have to continue improving it. So it is in your best interest to help me promote the game! If you have any other ideas, please <a href="mailto:commissioner@basketball-gm.com">email me</a>.</p>'
                    }
                });
            }
            if ((localStorage.nagged === "2" && Math.random() < 0.25) || (localStorage.nagged === "3" && Math.random < 0.025)) {
                //if (g.enableLogging) { _gaq.push(["_trackEvent", "Ad Display", "DraftKings"]); }
                localStorage.nagged = "3";
                /*return dao.messages.add({
                    ot: tx,
                    value: {
                        read: false,
                        from: "The Commissioner",
                        year: g.season,
                        text: '<p>DraftKings is a great new way to play fantasy sports and win money. They are running a special promotion for Basketball GM players: they\'ll waive the entry fee for a $30k fantasy NBA pool and match your first deposit for free! All you have to do is draft the best 8 player team. Your Basketball GM experience may prove to be useful!</p><p><a href="https://www.draftkings.com/gateway?s=640365236"><img src="/img/dk-logo.png"></a></p><p>And better yet, by signing up through <a href="https://www.draftkings.com/gateway?s=640365236">this link</a>, you will be supporting Basketball GM. So even if you\'re not totally sure if you want to try DraftKings, give it a shot as a personal favor to me. In return, I will continue to improve this free game that you\'ve spent hours playing - there is some cool stuff in the works, stay tuned!</p>'
                    }
                });*/
            }
        }).then(function() {
            // random start of reg. season cpu free agent signings
            localStorage.signingSkip = random.randInt(0,7);
            // reset team's FA signing criteria
            return freeAgents.readyTeamsFA(tx);
        }).then(function () {
            return [undefined, ["playerMovement"]];
        });
    }

    function newPhaseAfterTradeDeadline() {
        throw new Error("newPhaseAfterTradeDeadline not implemented");
    }

    function newPhasePlayoffs(tx) {
        // Achievements after regular season
        account.checkAchievement.septuawinarian();

        // Set playoff matchups
        return season.createPlayoffMatchups(tx)
            .then(function () {
                return Promise.all([
                    finances.assessPayrollMinLuxury(tx),
                    season.newSchedulePlayoffsDay(tx)
                ]);
            }).then(function () {
                var url;

                // Don't redirect if we're viewing a live game now
                if (location.pathname.indexOf("/live_game") === -1) {
                    url = helpers.leagueUrl(["playoffs"]);
                }

                return [url, ["teamFinances"]];
            });
    }

    function newPhaseBeforeDraft(tx) {
        // Achievements after playoffs
        account.checkAchievement.fo_fo_fo();
        account.checkAchievement["98_degrees"]();
        account.checkAchievement.dynasty();
        account.checkAchievement.dynasty_2();
        account.checkAchievement.dynasty_3();
        account.checkAchievement.moneyball();
        account.checkAchievement.moneyball_2();
        account.checkAchievement.small_market();

        // Select winners of the season's awards
        return season.awards(tx).then(function () {
            // Add award for each player on the championship team
            return team.filter({
                ot: tx,
                attrs: ["tid"],
                seasonAttrs: ["playoffRoundsWon"],
                season: g.season
            });
        }).then(function (teams) {
            var i, tid;

            // Give award to all players on the championship team
            for (i = 0; i < teams.length; i++) {
                if (teams[i].playoffRoundsWon === 4) {
                    tid = teams[i].tid;
                    break;
                }
            }
            return dao.players.iterate({
                ot: tx,
                index: "tid",
                key: tid,
                callback: function (p) {
                    p.awards.push({season: g.season, type: "Won Championship"});
                    return p;
                }
            });
        }).then(function () {
            var maxAge, minPot;

            // Do annual tasks for each player, like checking for retirement

            // Players meeting one of these cutoffs might retire
            maxAge = 34;
            minPot = 40;

            return dao.players.iterate({
                ot: tx,
                index: "tid",
                key: IDBKeyRange.lowerBound(g.PLAYER.FREE_AGENT),
                callback: function (p) {
                    var update;

                    update = false;

                    // Get player stats, used for HOF calculation
                    return dao.playerStats.getAll({
                        ot: tx,
                        index: "pid, season, tid",
                        key: IDBKeyRange.bound([p.pid], [p.pid, ''])
                    }).then(function (playerStats) {
                        var age, excessAge, excessPot, pot, randval;

                        age = g.season - p.born.year;
                        pot = p.ratings[p.ratings.length - 1].pot;

                        if (age > maxAge || pot < minPot) {
                            excessAge = 0;
                            if (age > 34 || p.tid === g.PLAYER.FREE_AGENT) {  // Only players older than 34 or without a contract will retire
                                if (age > 34) {
                                    excessAge = (age - 34) / 20;  // 0.05 for each year beyond 34
                                }
                                excessPot = (40 - pot) / 50;  // 0.02 for each potential rating below 40 (this can be negative)
                                randval = helpers.bound(random.realGauss(0, 1), -1, 4); // bounding the negative end,
                                if (excessAge + excessPot + randval > 0) {              // increases the likelihood of retirement.
                                    p = player.retire(tx, p, playerStats);
                                    update = true;
                                }
                            }
                        } else {
                            // Very small chance of an active retiring.
                            if (Math.random() < 0.0000001 ) {
                                p = player.retire(tx, p, playerStats);
                                update = true;
                            }
                        }


                        // Update "free agent years" counter and retire players who have been free agents for more than one years
                        if (p.tid === g.PLAYER.FREE_AGENT) {
                            if (p.yearsFreeAgent >= 1) {
                                p = player.retire(tx, p, playerStats);
                            } else {
                                p.yearsFreeAgent += 1;
                            }
                            p.contract.exp += 1;
                            update = true;
                        } else if (p.tid >= 0 && p.yearsFreeAgent > 0) {
                            p.yearsFreeAgent = 0;
                            update = true;
                        }

                        // Heal injures
                        if (p.injury.type !== "Healthy") {
                            if (p.injury.gamesRemaining <= 82) {
                                p.injury = {type: "Healthy", gamesRemaining: 0};
                            } else {
                                p.injury.gamesRemaining -= 82;
                            }
                            update = true;
                        }

                        // Update player in DB, if necessary
                        if (update) {
                            return p;
                        }
                    });
                }
            });
        }).then(function () {
            // Remove released players' salaries from payrolls if their contract expired this year
            return dao.releasedPlayers.iterate({
                ot: tx,
                index: "contract.exp",
                key: IDBKeyRange.upperBound(g.season),
                callback: function (rp) {
                    dao.releasedPlayers.delete({
                        ot: tx,
                        key: rp.rid
                    });
                }
            });
        }).then(function () {
            return team.updateStrategies(tx);
        }).then(function () {
            return season.updateOwnerMood(tx);
        }).then(function (deltas) {
            return message.generate(tx, deltas);
        }).then(function () {
            var url;

            // Don't redirect if we're viewing a live game now
            if (location.pathname.indexOf("/live_game") === -1) {
                url = helpers.leagueUrl(["history"]);
            }

            helpers.bbgmPing("season");

            return [url, ["playerMovement"]];
        });
    }

    function newPhaseDraft(tx) {
        // Achievements after awards
        account.checkAchievement.hardware_store();
        account.checkAchievement.sleeper_pick();

        // Kill off old retired players (done here since not much else happens in this phase change, so making it a little slower is fine)
        return dao.players.iterate({
            ot: tx,
            index: "tid",
            key: g.PLAYER.RETIRED,
            callback: function (p) {
                var probDeath;
                if (p.hasOwnProperty("diedYear") && p.diedYear) {
                    return;
                }

                // Formula badly fit to http://www.ssa.gov/oact/STATS/table4c6.html
                probDeath = 0.0001165111 * Math.exp(0.0761889274 * (g.season - p.born.year));

                if (Math.random() < probDeath) {
                    p.diedYear = g.season;
                    return p;
                }
            }
        }).then(function () {
            return draft.genOrder(tx);
        }).then(function () {
            // This is a hack to handle weird cases where players have draft.year set to the current season, which fucks up the draft UI
            return dao.players.iterate({
                ot: tx,
                index: "draft.year",
                key: g.season,
                callback: function (p) {
                    if (p.tid >= 0) {
                        p.draft.year -= 1;
                        return p;
                    }
                }
            });
        }).then(function () {
            return [helpers.leagueUrl(["draft"])];
        });
    }

    function newPhaseAfterDraft(tx) {
        var promises, round, tid;

        promises = [];

        // Add a new set of draft picks
        for (tid = 0; tid < g.numTeams; tid++) {
            for (round = 1; round <= 2; round++) {
                promises.push(dao.draftPicks.add({
                    ot: tx,
                    value: {
                        tid: tid,
                        originalTid: tid,
                        round: round,
                        season: g.season + 4
                    }
                }));
            }
        }

        return Promise.all(promises).then(function () {
            return [undefined, ["playerMovement"]];
        });
    }

    function newPhaseResignPlayers(tx) {
        return player.genBaseMoods(tx).then(function (baseMoods) {
            // Re-sign players on user's team
            return dao.players.iterate({
                ot: tx,
                index: "tid",
                key: IDBKeyRange.lowerBound(0),
                callback: function (p) {
                    var tid;

                    if (p.contract.exp <= g.season && g.userTids.indexOf(p.tid) >= 0 && g.autoPlaySeasons === 0) {
                        tid = p.tid;

                        // Add to free agents first, to generate a contract demand
                        return player.addToFreeAgents(tx, p, g.PHASE.RESIGN_PLAYERS, baseMoods).then(function () {
                            // Open negotiations with player
                            return contractNegotiation.create(tx, p.pid, true, tid).then(function() {
                                return;
                            });
                        });
                    }
                }
            });
        }).then(function () {
            // Set daysLeft here because this is "basically" free agency, so some functions based on daysLeft need to treat it that way (such as the trade AI being more reluctant)
            return require("core/league").setGameAttributes(tx, {daysLeft: 30});
        }).then(function () {
            return [helpers.leagueUrl(["negotiation"]), ["playerMovement"]];
        });
    }

    function newPhaseFreeAgency(tx) {
        var oBaseMoods;
        return player.genBaseMoods(tx)
            .then(function(baseMoods) {
                oBaseMoods = baseMoods;
                return freeAgents.cpuResignPlayers(tx, baseMoods);
            }).then(function() {
                return contractNegotiation.decidePlayerResignOffers(tx);
            }).then(function() {
                return team.allRostersAutoSort(tx);
            }).then(function() {
                return freeAgents.readyTeamsFA(tx);
            }). then(function() {
                return freeAgents.readyPlayersFA(tx, oBaseMoods);
            }).then(draft.tickDraftClasses(tx)
            ).then(function () {
                return [helpers.leagueUrl(["free_agents"]), ["playerMovement"]];
            });
    }

    function newPhaseFantasyDraft(tx, position) {
        return contractNegotiation.cancelAll(tx).then(function () {
            return draft.genOrderFantasy(tx, position);
        }).then(function () {
            return require("core/league").setGameAttributes(tx, {nextPhase: g.phase});
        }).then(function () {
            // Protect draft prospects from being included in this
            return dao.players.iterate({
                ot: tx,
                index: "tid",
                key: g.PLAYER.UNDRAFTED,
                callback: function (p) {
                    p.tid = g.PLAYER.UNDRAFTED_FANTASY_TEMP;
                    return p;
                }
            }).then(function () {
                // Make all players draftable
                dao.players.iterate({
                    ot: tx,
                    index: "tid",
                    key: IDBKeyRange.lowerBound(g.PLAYER.FREE_AGENT),
                    callback: function (p) {
                        p.tid = g.PLAYER.UNDRAFTED;
                        return p;
                    }
                });
            });
        }).then(function () {
            return dao.releasedPlayers.clear({ot: tx});
        }).then(function () {
            return [helpers.leagueUrl(["draft"]), ["playerMovement"]];
        });
    }

    /**
     * Set a new phase of the game.
     *
     * This function is called to do all the crap that must be done during transitions between phases of the game, such as moving from the regular season to the playoffs. Phases are defined in the g.PHASE.* global variables. The phase update may happen asynchronously if the database must be accessed, so do not rely on g.phase being updated immediately after this function is called. Instead, pass a callback.
     *
     * phaseChangeTx contains the transaction for the phase change. Phase changes are atomic: if there is an error, it all gets cancelled. The user can also manually abort the phase change. IMPORTANT: For this reason, gameAttributes must be included in every phaseChangeTx to prevent g.phaseChangeInProgress from being changed. Since phaseChangeTx is readwrite, nothing else will be able to touch phaseChangeInProgress until it finishes.
     *
     * @memberOf core.phase
     * @param {number} phase Numeric phase ID. This should always be one of the g.PHASE.* variables defined in globals.js.
     * @param {} extra Parameter containing extra info to be passed to phase changing function. Currently only used for newPhaseFantasyDraft.
     * @return {Promise}
     */
    function newPhase(phase, extra) {
        // Prevent at least some cases of code running twice
        if (phase === g.phase) {
            return;
        }

        return lock.phaseChangeInProgress().then(function (phaseChangeInProgress) {
            if (!phaseChangeInProgress) {
                return require("core/league").setGameAttributesComplete({phaseChangeInProgress: true}).then(function () {
                    ui.updatePlayMenu(null);

                    // In Chrome, this will update play menu in other windows. In Firefox, it won't because ui.updatePlayMenu gets blocked until phaseChangeTx finishes for some reason.
                    require("core/league").updateLastDbChange();

                    if (phase === g.PHASE.PRESEASON) {
                        phaseChangeTx = dao.tx(["gameAttributes", "players", "playerStats", "releasedPlayers", "teams", "negotiations", "messages"], "readwrite");
                        return newPhasePreseason(phaseChangeTx);
                    }
                    if (phase === g.PHASE.REGULAR_SEASON) {
                        phaseChangeTx = dao.tx(["gameAttributes", "messages", "schedule", "teams", "players", "releasedPlayers"], "readwrite");
                        return newPhaseRegularSeason(phaseChangeTx);
                    }
                    if (phase === g.PHASE.AFTER_TRADE_DEADLINE) {
                        return newPhaseAfterTradeDeadline();
                    }
                    if (phase === g.PHASE.PLAYOFFS) {
                        phaseChangeTx = dao.tx(["players", "playerStats", "playoffSeries", "releasedPlayers", "schedule", "teams"], "readwrite");
                        return newPhasePlayoffs(phaseChangeTx);
                    }
                    if (phase === g.PHASE.BEFORE_DRAFT) {
                        phaseChangeTx = dao.tx(["awards", "events", "gameAttributes", "messages", "players", "playerStats", "releasedPlayers", "teams"], "readwrite");
                        return newPhaseBeforeDraft(phaseChangeTx);
                    }
                    if (phase === g.PHASE.DRAFT) {
                        phaseChangeTx = dao.tx(["draftPicks", "draftOrder", "gameAttributes", "players", "teams"], "readwrite");
                        return newPhaseDraft(phaseChangeTx);
                    }
                    if (phase === g.PHASE.AFTER_DRAFT) {
                        phaseChangeTx = dao.tx(["draftPicks", "gameAttributes"], "readwrite");
                        return newPhaseAfterDraft(phaseChangeTx);
                    }
                    if (phase === g.PHASE.RESIGN_PLAYERS) {
                        phaseChangeTx = dao.tx(["gameAttributes", "messages", "negotiations", "players", "teams"], "readwrite");
                        return newPhaseResignPlayers(phaseChangeTx);
                    }
                    if (phase === g.PHASE.FREE_AGENCY) {
                        phaseChangeTx = dao.tx(["gameAttributes", "messages", "negotiations", "players", "teams", "releasedPlayers"], "readwrite");
                        return newPhaseFreeAgency(phaseChangeTx);
                    }
                    if (phase === g.PHASE.FANTASY_DRAFT) {
                        phaseChangeTx = dao.tx(["draftOrder", "gameAttributes", "messages", "negotiations", "players", "releasedPlayers"], "readwrite");
                        return newPhaseFantasyDraft(phaseChangeTx, extra);
                    }
                }).catch(function (err) {
                    // If there was any error in the phase change, abort transaction
                    if (phaseChangeTx && phaseChangeTx.abort) {
                        phaseChangeTx.abort();
                    }

                    require("core/league").setGameAttributesComplete({phaseChangeInProgress: false}).then(function () {
                        throw err;
                    });
                }).spread(function (url, updateEvents) {
                    return phaseChangeTx.complete().then(function () {
                        return finalize(phase, url, updateEvents);
                    });
                });
            }

            helpers.errorNotify("Phase change already in progress, maybe in another tab.");
        });
    }

    function abort() {
        try {
            // Stop error from bubbling up, since this function is only called on purpose
            phaseChangeTx.onerror = function (e) {
                e.stopPropagation();
                e.preventDefault();
            };

            phaseChangeTx.abort();
        } catch (err) {
            // Could be here because tx already ended, phase change is happening in another tab, or something weird.
            console.log("This is probably not actually an error:");
            console.log(err.stack);
            helpers.errorNotify("If \"Abort\" doesn't work, check if you have another tab open.");
        } finally {
            // If another window has a phase change in progress, this won't do anything until that finishes
            require("core/league").setGameAttributesComplete({phaseChangeInProgress: false}).then(function () {
                return ui.updatePlayMenu(null);
            });
        }
    }

    return {
        newPhase: newPhase,
        abort: abort
    };
});
