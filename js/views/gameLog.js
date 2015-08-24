/**
 * @name views.gameLog
 * @namespace Game log and box score viewing for all seasons and teams.
 */
define(["dao", "globals", "ui", "lib/bluebird", "lib/jquery", "lib/knockout", "views/components", "util/bbgmView", "util/helpers"], function (dao, g, ui, Promise, $, ko, components, bbgmView, helpers) {
    "use strict";

    function sumForTeam(output, gameO, tid, index) {
        var game, j, k, keys, t, tdx;
        game = _.where(gameO.teams, {tid: tid})[0];
        keys = _.keys(game);
        keys = _.without(keys, "tid");
        t = output.teams[index];
        for (j = 0; j < keys.length; j++) {
            if (keys[j] === "ptsQtrs") {
                if(t.hasOwnProperty("ptsQtrs")) {
                    if (game.ptsQtrs.length > t.ptsQtrs.length) {
                        t.ptsQtrs.push(0);
                    }
                    for (k = 0; k < game.ptsQtrs.length; k++) {
                        t.ptsQtrs[k] += game.ptsQtrs[k];
                    }
                } else {
                    t.ptsQtrs = game.ptsQtrs;
                }
            } else if (keys[j] === "players") {
                if (t.hasOwnProperty("players")) {
                    for (k = 0; k < t.players.length; k++) {
                        var l, pkeys, player;
                        player = _.where(game.players, {pid: t.players[k].pid});
                        if(player.length > 0) {
                            player = player[0];
                            pkeys = _.keys(player);
                            pkeys = _.without(pkeys, "injury", "name", "pos", "skills", "ptsQtrs", "pid");
                            for (l = 0; l < pkeys.length; l++) {
                                t.players[k][pkeys[l]] += player[pkeys[l]];
                            }
                        }
                    }
                } else {
                    t.players = game.players;
                }
            } else {
                t[keys[j]] = (t.hasOwnProperty(keys[j])) ? t[keys[j]] + game[keys[j]] : game[keys[j]];
            }
        }
        t.abbrev = g.teamAbbrevsCache[tid];
        t.region = g.teamRegionsCache[tid];
        t.name = g.teamNamesCache[tid];

        // four factors
        t.efg = 100 * (t.fg + (t.tp / 2)) / t.fga;
        t.tovp = 100 * t.tov / (t.fga + 0.44 * t.fta + t.tov);
        tdx = (gameO.teams[0].tid === tid) ? 1 : 0;
        t.orbp = 100 * t.orb / (t.orb + gameO.teams[tdx].drb);
        t.ftpfga = t.ft / t.fga;

        // Fix the total minutes calculation, which is usually fucked up for some unknown reason
        t.min = 240 + 25 * gameO.overtimes;
    }

    /**
     * Generate a box score.
     *
     * @memberOf views.gameLog
     * @param {number} gid Integer game ID for the box score (a negative number means no box score).
     * @return {Promise.Object} Resolves to an object containing the box score data (or a blank object).
     */
    function boxScore(inputs, vm) {
        var gid = inputs.gid;
        if (isNaN(gid) || !gid) {
            return dao.games.getAll({
                index: "season",
                key: inputs.season
            }).then(function(games) {
                var game,
                    gameCount = parseInt(inputs.gameCount),
                    i,
                    otherTid = g.teamAbbrevsCache.indexOf(inputs.opponent),
                    output,
                    tid = g.teamAbbrevsCache.indexOf(inputs.abbrev);

                games = games.filter(function(gm) {
                    var teams = gm.teams;
                    if (teams.length > 1 && tid > -1) {
                        if (otherTid > -1 && otherTid < 30) {
                            return (teams[0].tid === tid && teams[1].tid === otherTid) ||
                                (teams[1].tid === tid && teams[0].tid === otherTid);
                        }
                        return teams[0].tid === tid || teams[1].tid === tid;
                    }
                });

                if (!isNaN(gameCount)) {
                    games = games.slice(-gameCount);
                }

                if (games.length === 0) {
                    return {};
                }

                // vm.gamesList.games(games);

                output = {
                    won: {
                        region: g.teamRegionsCache[tid],
                        name: g.teamNamesCache[tid],
                        abbrev: g.teamAbbrevsCache[tid]
                    },
                    lost: {
                        region: "",
                        name: "",
                        abbrev: ""
                    },
                    overtime: "",
                    season: inputs.season,
                    teams: [{}, {}],
                    att: 0
                };
                if (otherTid > -1) {
                    output.lost = {
                        region: g.teamRegionsCache[otherTid],
                        name: g.teamNamesCache[otherTid],
                        abbrev: g.teamAbbrevsCache[otherTid]
                    };
                }

                for (i = 0; i < games.length; i ++) {
                    sumForTeam(output, games[i], tid, 0);
                    if (games[i].won.tid === tid) {
                        otherTid = games[i].lost.tid;
                    } else {
                        otherTid = games[i].won.tid;
                    }
                    sumForTeam(output, games[i], otherTid, 1);
                    output.att += games[i].att / games.length;
                }

                // if (game.overtimes === 1) {
                //     game.overtime = " (OT)";
                // } else if (game.overtimes > 1) {
                //     game.overtime = " (" + game.overtimes + "OT)";
                // } else {
                //     game.overtime = "";
                // }

                // Quarter/overtime labels
                output.qtrs = ["Q1", "Q2", "Q3", "Q4"];
                for (i = 0; i < output.teams[0].ptsQtrs.length - 4; i++) {
                    output.qtrs.push("OT" + (i + 1));
                }
                output.qtrs.push("F");

                return output;
            });
        }
        if (gid >= 0) {
            console.log('here again');
            return dao.games.get({key: gid}).then(function (game) {
                var i, t;

                // If game doesn't exist (bad gid or deleted box scores), show nothing
                if (!game) {
                    return {};
                }

                for (i = 0; i < game.teams.length; i++) {
                    t = game.teams[i];

                    // Team metadata
                    t.abbrev = g.teamAbbrevsCache[t.tid];
                    t.region = g.teamRegionsCache[t.tid];
                    t.name = g.teamNamesCache[t.tid];

                    // four factors
                    t.efg = 100 * (t.fg + (t.tp / 2)) / t.fga;
                    t.tovp = 100 * t.tov / (t.fga + 0.44 * t.fta + t.tov);
                    t.orbp = 100 * t.orb / (t.orb + game.teams[1 - i].drb);
                    t.ftpfga = t.ft / t.fga;

                    // Fix the total minutes calculation, which is usually fucked up for some unknown reason
                    t.min = 240 + 25 * game.overtimes;

                    // Put injured players at the bottom, then sort by GS and roster position
                    t.players.sort(function (a, b) {
                        // This sorts by starters first and minutes second, since .min is always far less than 1000 and gs is either 1 or 0. Then injured players are listed at the end, if they didn't play.
                        return (b.gs * 100000 + b.min * 1000 - b.injury.gamesRemaining) - (a.gs * 100000 + a.min * 1000 - a.injury.gamesRemaining);
                    });
                }

                // Team metadata
                game.won.region = g.teamRegionsCache[game.won.tid];
                game.won.name = g.teamNamesCache[game.won.tid];
                game.won.abbrev = g.teamAbbrevsCache[game.won.tid];
                game.lost.region = g.teamRegionsCache[game.lost.tid];
                game.lost.name = g.teamNamesCache[game.lost.tid];
                game.lost.abbrev = g.teamAbbrevsCache[game.lost.tid];

                if (game.overtimes === 1) {
                    game.overtime = " (OT)";
                } else if (game.overtimes > 1) {
                    game.overtime = " (" + game.overtimes + "OT)";
                } else {
                    game.overtime = "";
                }

                // Quarter/overtime labels
                game.qtrs = ["Q1", "Q2", "Q3", "Q4"];
                for (i = 0; i < game.teams[1].ptsQtrs.length - 4; i++) {
                    game.qtrs.push("OT" + (i + 1));
                }
                game.qtrs.push("F");

                return game;
            });
        }

        return Promise.resolve({});
    }

    function get(req) {
        var inputs, out;

        inputs = {};

        out = helpers.validateAbbrev(req.params.abbrev);
        inputs.abbrev = out[1];
        inputs.season = helpers.validateSeason(req.params.season);

        if (g.teamAbbrevsCache.indexOf(req.params.gid) >= 0 || req.params.gid === "all") {
            inputs.opponent = req.params.gid;
            inputs.gameCount = req.params.view;
            inputs.gid = null;
        } else {
            inputs.gid = req.params.gid !== undefined ? parseInt(req.params.gid, 10) : -1;
        }

        return inputs;
    }

    function InitViewModel() {
        this.boxScore = {
            gid: ko.observable(-1),
            prevGid: ko.observable(null),
            nextGid: ko.observable(null)
        };
        this.gamesList = {
            abbrev: ko.observable(),
            loading: ko.observable(true), // Needed because this isn't really set until updateGamesList, which could be after first render
            season: ko.observable(),
            games: ko.observableArray([])
        };

        this.opponent = ko.observable();
        this.gameCount = ko.observable();

        // This computed is used so the box score won't be rendered until after it is fully loaded (due to the throttle). Otherwise, the mapping plugin sometimes sets the gid before the rest of the box score.
        // But because it's throttled, ui.tableClickableRows can't be called directly in uiFirst or uiEvery.
        this.showBoxScore = ko.computed(function () {
            return this.boxScore.gid() >= 0;
        }, this).extend({throttle: 1});
    }

/* This doesn't work for some reason.
    mapping = {
        gamesList: {
            update: function (options) {
                return new function () {
                    komapping.fromJS(options.data, {
                        games: {
                            create: function (options) {
                                return options.data;
                            }
                        }
                    }, this);
                }();
            }
        }
    };*/

    function updatePrevNextLinks(vm) {
        var games, i;

        games = vm.gamesList.games();
        vm.boxScore.prevGid(null);
        vm.boxScore.nextGid(null);

        for (i = 0; i < games.length; i++) {
            if (games[i].gid === vm.boxScore.gid()) {
                if (i > 0) {
                    vm.boxScore.nextGid(games[i - 1].gid);
                }
                if (i < games.length - 1) {
                    vm.boxScore.prevGid(games[i + 1].gid);
                }
                break;
            }
        }
    }

    function updateTeamSeason(inputs) {
        return {
            // Needed for dropdown
            abbrev: inputs.abbrev,
            season: inputs.season,
            opponent: inputs.opponent,
            gameCount: inputs.gameCount
        };
    }

    /**
     * Update the displayed box score, as necessary.
     *
     * If the box score is already loaded, nothing is done.
     *
     * @memberOf views.gameLog
     * @param {number} inputs.gid Integer game ID for the box score (a negative number means no box score).
     */
    function updateBoxScore(inputs, updateEvents, vm) {
        console.log(inputs);
        console.log(vm);
        if (updateEvents.indexOf("dbChange") >= 0 || updateEvents.indexOf("firstRun") >= 0 || inputs.gid !== vm.boxScore.gid() || inputs.opponent !== vm.opponent() || inputs.gameCount !== vm.gameCount() || inputs.season !== vm.season()) {
            return boxScore(inputs, vm).then(function (game) {
                var vars;

                vars = {
                    boxScore: game,
                };

                // vm.opponent(inputs.opponent);
                // vm.gameCount(inputs.gameCount);

                // Either update the box score if we found one, or show placeholder
                if (!game.hasOwnProperty("teams")) {
                    vars.boxScore.gid = -1;
                } else {
                    if (!isNaN(inputs.gid)) {
                        vars.boxScore.gid = inputs.gid;
                    }
                    // Force scroll to top, which otherwise wouldn't happen because this is an internal link
                    window.scrollTo(window.pageXOffset, 0);
                }

                return vars;
            });
        }
    }

    /**
     * Update the game log list, as necessary.
     *
     * If the game log list is already loaded, nothing is done. If the game log list is loaded and a new game has been played, update. If the game log list is not loaded, load it.
     *
     * @memberOf views.gameLog
     * @param {string} inputs.abbrev Abbrev of the team for the list of games.
     * @param {number} inputs.season Season for the list of games.
     * @param {number} inputs.gid Integer game ID for the box score (a negative number means no box score), which is used only for highlighting the relevant entry in the list.
     */
    function updateGamesList(inputs, updateEvents, vm) {
        if (updateEvents.indexOf("dbChange") >= 0 || updateEvents.indexOf("firstRun") >= 0 || inputs.abbrev !== vm.gamesList.abbrev() || inputs.season !== vm.gamesList.season()) {
            // Load all games in list
            vm.gamesList.loading(true);
            vm.gamesList.games([]);
            return helpers.gameLogList(inputs.abbrev, inputs.season, inputs.gid, vm.gamesList.games()).then(function (games) {
                vm.gamesList.games(games);
                vm.gamesList.abbrev(inputs.abbrev);
                vm.gamesList.season(inputs.season);
                vm.gamesList.loading(false);

                // Update prev/next links, in case box score loaded before games list
                updatePrevNextLinks(vm);

/* This doesn't work for some reason.
                return {
                    gamesList: {
                        games: games,
                        abbrev: inputs.abbrev,
                        season: inputs.season,
                        loading: false
                    }
                };*/
            });
        }
        if (updateEvents.indexOf("gameSim") >= 0 && inputs.season === g.season) {
            // Partial update of only new games
            return helpers.gameLogList(inputs.abbrev, inputs.season, inputs.gid, vm.gamesList.games()).then(function (games) {
                var i;
                for (i = games.length - 1; i >= 0; i--) {
                    vm.gamesList.games.unshift(games[i]);
                }

                // Update prev/next links, in case box score loaded before games list
                updatePrevNextLinks(vm);
            });
        }
    }

    function uiFirst(vm) {
        ko.computed(function () {
            ui.title("Game Log - " + vm.season());
        }).extend({throttle: 1});

        // Update prev/next links whenever box score gid is changed
        ko.computed(function () {
            vm.boxScore.gid();
            updatePrevNextLinks(vm);
        }).extend({throttle: 1});
    }

    function uiEvery(updateEvents, vm) {
        components.dropdown("game-log-dropdown", ["teams", "seasons", "opponent", "gameCount"], [vm.abbrev(), vm.season(), vm.opponent(), vm.gameCount()], updateEvents, vm.boxScore.gid() >= 0 ? vm.boxScore.gid() : undefined);

        // UGLY HACK for two reasons:
        // 1. Box score might be hidden if none is loaded, so in that case there is no table to make clickable
        // 2. When box scores are shown, it might happen after uiEvery is called because vm.showBoxScore is throttled
        window.setTimeout(function () {
            var tableEls;

            tableEls = $(".box-score-team");
            if (tableEls.length > 0 && !tableEls[0].classList.contains("table-hover")) {
                ui.tableClickableRows(tableEls);
            }
        }, 100);
    }

    return bbgmView.init({
        id: "gameLog",
        get: get,
        InitViewModel: InitViewModel,
        runBefore: [updateBoxScore, updateTeamSeason],
        runWhenever: [updateGamesList],
        uiFirst: uiFirst,
        uiEvery: uiEvery
    });
});
