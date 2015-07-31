/**
 * @name core.freeAgents
 * @namespace Functions related to free agents that didn't make sense to put anywhere else.
 */
define(["dao", "globals", "ui", "core/player", "core/team", "lib/bluebird", "lib/underscore", "util/eventLog", "util/helpers", "util/lock", "util/random"], function (dao, g, ui, player, team, Promise, _, eventLog, helpers, lock, random) {
    "use strict";

    var CPU_RESIGN_CUTOFF = 0.6;
    var OFFER_GRADE_CUTOFF = 0.9;


    function gradeComposite (composite) {
        composite = _.omit(composite, ['pace', 'usage', 'turnovers', 'fouling']);
        composite = _.filter(_.values(composite), function (v) {
            return v > 0.6;
        });
        return composite.length / 10;
    }

    function compareComposites(a, b, needs) {
        var count, i;
        a = _.pick(a, needs);
        b = _.pick(b, needs);

        count = 0;
        for (i = 0; i < needs.length; i++) {
            if (a[needs[i]] > b[needs[i]]) {
                count++;
            }
        }
        return count / needs.length;
    }

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
        return (age + 1.5 * composite + potential + 0.5 * roster + 2 * skill) / 6;
        // if(grade > 0.6) {
        //     console.log('age:', age, 'composite:', composite,
        //         'potential:', potential, 'roster:', roster, 'skill:', skill,
        //         'grade', grade, 'name:', p.name, p.value, zAge);
        // }
    }

    function signingScore(p, t, needs) {
        var composite, gp;
        gp = gradePlayer(p, true);
        composite = compareComposites(p.compositeRating, t.fa.compositeRating, needs);
        p.signingScore = (0.5 * gp[0] + 2 * composite + 1.5 * gp[1] + gp[2]) / 5.0;
        // console.log(p.name, gp[0], composite, gp[1], gp[2]);
        return p.signingScore;
    }

    /**
     * Exclude fields in searching for players.
     * @param  {object} compositeRatings objects with keys and values for composite player ratings.
     * @return {Array.string} fields to be included
     */
    function teamNeeds(compositeRatings) {
        var cr, notInclude;
        notInclude = ['pace', 'usage', 'turnovers', 'fouling', 'endurance', 'shootingFT'];
        cr = _.omit(compositeRatings, notInclude);
        cr = _.pairs(cr).sort(function (a, b) {
            return a[1] - b[1];
        });
        return _.keys(_.object(cr));
    }

    /**
     * Group the team needs, at max 2 from the same category only.
     * @param  {Array.string} needs fields to be included
     * @return {Array.string}       final fields to include, max length 5.
     */
    function groupNeeds(needs, fcount) {
        var big, defender, diff, i, needsCopy, playmaker, shooter, tcount, ttype, wing, x;
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
            x = Math.min(Math.floor(x / 2), 4);
            tcount[x].push(needs[i]);
        }
        for (i = 0; i < tcount.length; i++) {
            tcount[i] = tcount[i].slice(0, 2);
        }
        tcount = _.flatten(tcount);
        diff = _.difference(needs, tcount);
        return _.difference(needsCopy, diff).slice(0, fcount);
    }

    function makeOffer(t, players, toRelease) {
        toRelease = toRelease || false;
        return Promise.try(function () {
            var baseScore, fp, i, needs, offerCond, offers, playerGrade, pp, ppmin,
                rosterSpace, salarySpace, zContract, zVal;
            offers = [];
            ppmin = [];
            fp = helpers.deepCopy(players);

            needs = teamNeeds(t.fa.compositeRating);
            if (g.daysLeft <= 15 && t.fa.rosterSpace > 0) {
                needs = needs;
                zVal = (g.daysLeft - 1) / 15;
            } else {
                needs = groupNeeds(needs, 5);
                zVal = 1;
            }
            salarySpace = t.fa.salarySpace;
            rosterSpace = t.fa.rosterSpace;

            // filter by salary
            pp = fp.filter(function (p) {
                return p.contract.amount <= salarySpace;
            });

            // Do not sign minimum contracts over the roster limit
            if (toRelease) {
                pp = pp.filter(function(p) {
                    return p.contract.amount > g.minContract;
                });
                // if team will release player to make this signing possible,
                // make sure player grade is greater than the last signing.
                pp.map(function(p) {
                    signingScore(p, t, needs);
                });
                pp = pp.filter(function(p) {
                    return p.signingScore >= t.fa.minSigningScore;
                });
            }

            if (pp.length > 0) {
                // Get signing score only once
                if (!toRelease) {
                    pp.map(function(p) {
                        signingScore(p, t, needs);
                    });
                }

                pp = pp.sort(function (a, b) {
                    var r = 0;
                    r = b.signingScore - a.signingScore;
                    return (r === 0) ? b.valueWithContract - a.valueWithContract : r;
                });

                baseScore =  0.45 + zVal * 0.35;
                if (rosterSpace > 1 && pp[0].signingScore < baseScore) {
                    baseScore = pp[rosterSpace - 2].signingScore;
                }

                if (!toRelease) {
                    pp = pp.filter(function(p) {
                        return p.signingScore >= baseScore;
                    });
                }

                var ftmp = function(p) {return [p.pid, p.name, p.signingScore, p.contract.amount];}
                var tmp = pp.map(ftmp);
                console.log('offers considered', g.teamAbbrevsCache[t.tid], JSON.stringify(tmp));

                for (i = 0; i < pp.length; i++)  {
                    // console.log(pp[i].value, pp[i].name, g.teamAbbrevsCache[t.tid], pp[i].signingScore, baseScore);
                    if (pp[i].signingScore >= baseScore || toRelease ) {
                        // toRelease = go over the roster limit to sign a free agent
                        // given that you have salary space available.
                        zContract = player.cpuGenContract(pp[i], t.fuzzValue);

                        // sign higher contract players first?
                        // if min contract player is at top of list, deprioritize
                        // sign him last, so that we can make offer to player
                        if (zContract.amount <= g.minContract && rosterSpace > 2 && pp.length > 1) {
                            ppmin.push(pp.splice(i, 1)[0]);
                            zContract.amount = salarySpace + 1;
                            rosterSpace -= 1;
                            i--;
                            console.log('deprioritizing min', g.teamAbbrevsCache[t.tid], JSON.stringify(pp.map(ftmp)), JSON.stringify(ppmin.map(ftmp)));
                            if (!toRelease) {
                                console.log(pp, i, rosterSpace);
                                baseScore = pp[Math.min(i + rosterSpace - 1, pp.length - 1) ].signingScore;
                                console.log(g.teamAbbrevsCache[t.tid], baseScore, 'baseScore', i);
                            }
                        }

                        // What i would like is to not offer min contract while the cap space
                        // is not yet used up.
                        if (zContract.amount <= g.minContract && ppmin.length > 0) {
                            pp.splice(i, 0, ppmin.shift());
                            console.log('offer to first min contract', g.teamAbbrevsCache[t.tid]);
                        }

                        if (zContract.amount <= salarySpace) {
                            if (toRelease) {
                                console.log(pp[i].name, 'offered over roster limit.');
                            }
                            offers.push({
                                tid: t.tid,
                                pid: pp[i].pid,
                                amount: zContract.amount,
                                exp: (zVal < 1) ? g.season + 1 : zContract.exp,
                                skill: needs,
                                signingScore: pp[i].signingScore
                            });
                            salarySpace = Math.max(0, salarySpace - zContract.amount);
                            // Only offer min contracts when salarySpace is low.
                            if (salarySpace < g.minContract && rosterSpace > 1) {
                                salarySpace = Math.max(g.minContract, salarySpace);
                            }
                            rosterSpace -= 1;
                        }

                    } else {
                        i = pp.length;
                    }

                    if (rosterSpace < 1 || salarySpace < g.minContract) {
                        i = pp.length;
                    }
                }

            }
            console.log('offers accepted', g.teamAbbrevsCache[t.tid], offers);
            return offers;
        });
    }

    function gradeOffer(offer, p) {
        var amount, exp, mood, yr, yrOff;
        yrOff = offer.exp - g.season;
        yr = p.contract.exp - g.season;
        amount = offer.amount / p.contract.amount;
        exp = (yr - Math.abs(yrOff - yr)) / yr;
        mood = 1 - p.freeAgentMood[offer.tid] / 2.5;
        offer.grade = (2 * amount + 0.5 * exp + mood) / 3.5;
        return offer.grade;
    }

    function decideContract(tx, p, offers, maxSalarySpace) {
        var acceptContract, desiredMet, goContract, teamUpdate;
        offers = _.where(offers, {
            pid: p.pid
        });

        teamUpdate = function (tid, amount, skill, skillValue, signingScore) {
            return dao.teams.get({
                    ot: tx,
                    key: tid
                })
                .then(function (t) {
                    console.log('accepted', g.teamAbbrevsCache[t.tid], t.fa.salarySpace, amount, t.fa.salarySpace - amount, t.fa.rosterSpace);
                    t.fa.salarySpace = Math.max(0, t.fa.salarySpace - amount);
                    t.fa.salarySpace = Math.max(t.fa.salarySpace, g.minContract);
                    t.fa.rosterSpace -= 1;
                    t.fa.rosterSpace = Math.max(0, t.fa.rosterSpace);
                    t.fa.minSigningScore = Math.min(t.fa.minSigningScore, signingScore);
                    // t.fa.compositeRating[skill] += skillValue;
                    // t.fa.compositeRating[skill] /= 2;
                    return dao.teams.put({
                            ot: tx,
                            value: t
                        })
                        .thenReturn(null);
                });
        };

        acceptContract = function (offer) {
            p.tid = offer.tid;
            p.contract.amount = offer.amount;
            p.contract.exp = offer.exp;
            if (g.phase <= g.PHASE.PLAYOFFS) {
                p = player.addStatsRow(tx, p, g.phase === g.PHASE.PLAYOFFS);
            }
            p = player.setContract(p, p.contract, true);
            p.gamesUntilTradable = 15;

            eventLog.add(null, {
                type: "freeAgent",
                text: 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[p.tid], g.season]) + '">' + g.teamNamesCache[p.tid] + '</a> signed <a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a> for ' + helpers.formatCurrency(p.contract.amount / 1000, "M") + '/year through ' + p.contract.exp + '.',
                showNotification: p.tid === g.userTid,
                pids: [p.pid],
                tids: [p.tid]
            });
            return teamUpdate(offer.tid, offer.amount, offer.skill, p.compositeRating[offer.skill], offer.signingScore)
                .then(function () {
                    return dao.players.put({
                            ot: tx,
                            value: p
                        })
                        .then(function() {
                            return team.rosterAutoSort(tx, offer.tid);
                        });
                });
        };

        // grade the offers
        if (offers.length > 0) {
            offers.map(function(o) { return gradeOffer(o, p);});
            offers.sort(function (a, b) {
                return b.grade - a.grade;
            });
            desiredMet = offers[0].grade > OFFER_GRADE_CUTOFF;
        } else {
            desiredMet = false;
        }

        goContract = Math.random() > 0.95 - +desiredMet * 0.3 - (1 - g.daysLeft / 30);
        if (goContract && offers.length > 0) {
            console.log('accepted', p.value, p.name, g.teamAbbrevsCache[offers[0].tid], offers[0].amount, offers[0].grade, offers);
            return acceptContract(offers[0]);
        }

        if (p.contract.amount > maxSalarySpace) {
            // accept reduced salary and play for just a year.
            p.contract.amount = Math.max(maxSalarySpace * Math.random(), g.minContract);
            p.contract.exp = g.season + 1;
            console.log('Reduced salary for ', p.name, p.value, p.contract.amount, p.contract.exp);
        }

        return dao.players.put({
                ot: tx,
                value: p
            })
            .thenReturn(null);
    }

    function tickFreeAgencyDay(tx) {
        console.log(g.daysLeft, 'of Free Agency');
        tx = dao.tx(["players", "releasedPlayers", "teams", "playerStats"], "readwrite", tx);

        return Promise.join(
            dao.teams.getAll({
                ot: tx
            }),
            dao.players.getAll({
                ot: tx,
                index: "tid",
                key: g.PLAYER.FREE_AGENT
            }),
            function (teams, players) {
                var i, maxSalarySpace, offers, rosterSpaceTotal;
                offers = [];
                teams.sort(function (a, b) {
                    return b.fa.salarySpace - a.fa.salarySpace;
                });
                maxSalarySpace = teams[0].fa.salarySpace;
                players.sort(function (a, b) {
                    return b.contract.amount - a.contract.amount;
                });

                // debug
                rosterSpaceTotal = teams.reduce(function (a, b) {
                    return a + b.fa.rosterSpace;
                }, 0);
                console.log('maxSalarySpace', maxSalarySpace,
                    'roster space', rosterSpaceTotal,
                    'free agent count', players.length);
                if (g.daysLeft === 1) {
                    console.log(JSON.stringify(
                        teams.map(function (t) {
                            return [t.region, t.fa.rosterSpace];
                        })
                    ));
                }
                // end debug

                for (i = 0; i < teams.length; i++) {
                    if (teams[i].fa.rosterSpace > 0 ) {
                        if (teams[i].tid !== g.userTid || g.autoPlaySeasons > 0) {
                            offers.push(makeOffer(teams[i], players));
                        }
                    }
                    else if (teams[i].fa.rosterSpace === 0 && teams[i].fa.salarySpace > g.minContract) {
                        if (teams[i].tid !== g.userTid || g.autoPlaySeasons > 0) {
                            teams[i].fa.rosterSpace = 1;
                            offers.push(makeOffer(teams[i], players, true));
                        }
                    }
                }

                return Promise.all(offers)
                    .then(function (offers) {
                        offers = _.flatten(offers);
                        offers = _.sortBy(offers, 'pid');
                        return Promise.each(players, function (p) {
                            return decideContract(tx, p, offers, maxSalarySpace);
                        });
                    });
            }
        );
    }

    function sumContracts(players) {
        return players.reduce(function (a, b) {
            return a + b.contract.amount;
        }, 0);
    }

    /**
     * Ready all teams for free agency.
     */
    function readyTeamsFA(tx) {
        var game, i, promises, readyTeam, teamComposite;
        game = require('core/game');
        tx = dao.tx(["players", "releasedPlayers", "teams"], "readwrite", tx);
        promises = [];

        teamComposite = function (players, numOfPlayers) {
            var i, k, tc;
            numOfPlayers = (numOfPlayers > players.length) ? players.length - 1 : numOfPlayers;
            tc = {};
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
        };

        readyTeam = function (t) {
            var team = t.team;
            team.fa = {};

            team.fa.compositeRating = teamComposite(t.player, 7);
            // team.fa.synergy
            team.fa.rosterSpace = Math.max(0, 15 - t.player.length);
            team.fa.salarySpace = Math.max(0, g.salaryCap - sumContracts(t.player));
            team.fa.salarySpace = Math.max(team.fa.salarySpace, g.minContract);
            team.fa.minSigningScore = 2.0;

            // ensure fuzzValue exist.
            team.fuzzValue = team.fuzzValue || player.genFuzz(t.scoutingRank);
            return team;
        };

        for (i = 0; i < g.numTeams; i++) {
            promises.push(game.loadTeam(i, tx, true));
        }

        return Promise.all(promises)
            .then(function (teams) {
                _.each(teams, function (t) {
                    var team = readyTeam(t);
                    dao.teams.put({
                        ot: tx,
                        value: team
                    }).then(function () {
                        return;
                    });
                });
            });
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

    /**
     * Save composite rating.
     */
    function readyPlayersFA(tx, baseMoods) {
        var readyPlayer;
        tx = dao.tx(["gameAttributes", "messages", "negotiations", "players", "releasedPlayers", "teams"], "readwrite", tx);

        readyPlayer = function () {
            return dao.players.iterate({
                ot: tx,
                index: "tid",
                key: IDBKeyRange.bound(g.PLAYER.UNDRAFTED, g.PLAYER.FREE_AGENT),
                callback: function (p) {
                    p.compositeRating = playerComposite(p.ratings);
                    p.faGrade = gradePlayer(p);
                    return player.addToFreeAgents(tx, p, g.PHASE.FREE_AGENCY, baseMoods);
                }
            });
        };

        return Promise.join(
            require('core/contractNegotiation').cancelAll(tx),
            readyPlayer
        );
    }

    /**
     * Try to resign players for the cpu and user teams (if autoplay)
     */
    function cpuResignPlayers(tx, baseMoods) {
        var eventReleased, eventResigned, resignPlayers, signOverLuxuryTax, signPlayer, updatePlayer;
        tx = dao.tx(["gameAttributes", "messages", "negotiations", "players", "releasedPlayers", "teams"], "readwrite", tx);

        updatePlayer = function (p) {
            var resigned = false;
            // console.log((p.tid === -1) ? 'FA' : p.tid, p.name, p.contract.amount, p.contract.exp);
            if (p.tid !== -1) {
                resigned = true;
                eventResigned(p);
            }
            dao.players.put({
                ot: tx,
                value: p
            }).then(function() {
                if (resigned) {
                    return team.rosterAutoSort(tx, p.tid);
                }
            });
        };

        eventResigned = function (p) {
            eventLog.add(null, {
                type: "reSigned",
                text: 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[p.tid], g.season]) + '">' + g.teamNamesCache[p.tid] + '</a> re-signed <a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a> for ' + helpers.formatCurrency(p.contract.amount / 1000, "M") + '/year through ' + p.contract.exp + '.',
                showNotification: false,
                pids: [p.pid],
                tids: [p.tid]
            });
        };

        eventReleased = function (p, tid) {
            eventLog.add(null, {
                type: "released",
                text: 'The <a href="' + helpers.leagueUrl(["roster", g.teamAbbrevsCache[tid], g.season]) + '">' + g.teamNamesCache[tid] + '</a> released <a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a> to free agency.',
                showNotification: false,
                pids: [p.pid],
                tids: [tid]
            });
        };

        signPlayer = function (p, offer) {
            p.contract.amount = offer.amount;
            p.contract.exp = offer.exp;
            p.tid = offer.tid;
            p = player.setContract(p, p.contract, true);
            p.gamesUntilTradable = 15;
        };

        signOverLuxuryTax = function (p, offer, grade, strategy, cash) {
            if (strategy === 'rebuilding') {
                if (grade > 1.0) {
                    signPlayer(p, offer);
                    console.log('rebuilding', 'resigned', p.name);
                }
            } else {
                if (cash > 0) {
                    signPlayer(p, offer);
                }
                if (grade > 9.0) {
                    signPlayer(p, offer);
                }
                if (p.tid === offer.tid) {
                    console.log('contending', 'resigned', p.name);
                }
            }

            if (p.tid === -1) {
                // announce released of high grade FA.
                console.log(p.name, 'released', grade, strategy, cash);
                eventReleased(p, offer.tid);
            }
        };

        resignPlayers = function (teams, players) {
            var cash, fuzzValues, i, salarySpace, strategies, toUpdate, tp, tpCopy;

            toUpdate = [];
            strategies = _.pluck(teams, 'strategy');
            fuzzValues = _.pluck(teams, 'fuzzValue');
            cash = teams.map(function (t) {
                return _.last(t.seasons).cash;
            });
            players = _.groupBy(players, 'tid');

            for (i = 0; i < 30; i++) {
                tp = players[i];

                // Skip user team if not on autoplay.
                if (g.autoPlaySeasons === 0 && i === g.userTid) {
                    tp = [];
                }

                tpCopy = tp.slice();
                tp = _.sortBy(tp, 'value').reverse();
                tp = _.filter(tp, function (p) {
                    return p.contract.exp === g.season;
                });
                tpCopy = _.difference(tpCopy, tp);
                salarySpace = g.salaryCap - sumContracts(tpCopy);
                _.each(tp, function (p) {
                    var grade, offer, offerGrade, zContract;
                    grade = gradePlayer(p);
                    player.addToFreeAgents(tx, p, g.PHASE.RESIGN_PLAYERS, baseMoods, false);

                    if (grade > CPU_RESIGN_CUTOFF) {
                        zContract = player.cpuGenContract(p, fuzzValues[i] || player.genFuzz(15.5));
                        offer = {
                            tid: i,
                            pid: p.pid,
                            amount: zContract.amount,
                            exp: zContract.exp
                        };
                        offerGrade = gradeOffer(offer, p);
                        if (offerGrade > OFFER_GRADE_CUTOFF) {
                            if (salarySpace + p.contract.amount > g.luxuryPayroll) {
                                signOverLuxuryTax(p, offer, grade, strategies[i], cash[i]);
                            } else {
                                signPlayer(p, offer);
                            }
                        } else {
                            console.log(p.name, 'refuses to sign with', g.teamAbbrevsCache[i],  offerGrade);
                        }

                    }
                });
                toUpdate = toUpdate.concat(tp);
            }

            return Promise.map(toUpdate, updatePlayer);
        };

        return Promise.join(
            dao.teams.getAll({
                ot: tx
            }),
            dao.players.getAll({
                ot: tx,
                index: "tid",
                key: IDBKeyRange.lowerBound(0)
            }),
            resignPlayers
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
            players.sort(function (a, b) {
                return b.value - a.value;
            });

            if (players.length === 0) {
                return;
            }

            // Randomly order teams
            tids = [];
            for (i = 0; i < g.numTeams; i++) {
                tids.push(i);
            }
            random.shuffle(tids);

            return Promise.each(tids, function (tid) {
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
                                return dao.players.put({
                                    ot: tx,
                                    value: p
                                }).then(function () {
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
                    p.injury = {
                        type: "Healthy",
                        gamesRemaining: 0
                    };
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
            return helpers.round(amount / 10) * 10; // Round to nearest 10k, assuming units are thousands
        }

        if (amount > g.maxContract / 1000) {
            amount = g.maxContract / 1000;
        }
        return helpers.round(amount * 100) / 100; // Round to nearest 10k, assuming units are millions
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
            require("core/league").setGameAttributesComplete({
                gamesInProgress: false
            }).then(function () {
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
                tickFreeAgencyDay().then(function() {
                    require("core/league").setGameAttributesComplete({
                        daysLeft: g.daysLeft - 1,
                        lastDbChange: Date.now()
                    }).then(function () {
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
            };

            if (numDays > 0) {
                // If we didn't just stop games, let's play
                // Or, if we are starting games (and already passed the lock), continue even if stopGames was just seen
                if (start || !g.stopGames) {
                    if (g.stopGames) {
                        require("core/league").setGameAttributesComplete({
                            stopGames: false
                        }).then(cbYetAnother);
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
                    require("core/league").setGameAttributesComplete({
                        gamesInProgress: true
                    }).then(function () {
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
        tickFreeAgencyDay: tickFreeAgencyDay,
        cpuResignPlayers: cpuResignPlayers
    };
});
